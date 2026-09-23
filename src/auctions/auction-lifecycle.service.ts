import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { ClockService } from '../common/time/clock.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { AUCTION_BID_EXISTENCE_PORT, AuctionBidExistencePort } from './auction-bid-existence.port';
import { assertValidAuctionTransition } from './auction-transitions';
import { AuctionStatus } from './auction.types';
import { Auction, AuctionDocument } from './schemas/auction.schema';

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 200;

function clampBatch(limit: number): number {
  const value = Math.trunc(limit) || DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(value, 1), MAX_BATCH_SIZE);
}

export type AuctionLifecycleRunSummary = {
  activated: number;
  endedNoBids: number;
  endedPendingClose: number;
};

/**
 * MAZAD-024's single authoritative transition mechanism. Every status
 * change an Auction document ever undergoes — start, expiry (with or
 * without bids) and cancellation — happens through one of this service's
 * methods, each of which validates the move against `AUCTION_TRANSITIONS`
 * (`auction-transitions.ts`) and persists it with an atomic, conditional
 * `findOneAndUpdate` keyed on the *expected current status*. Nothing else
 * in the codebase writes `Auction.status` directly (creation, in
 * `AuctionsService`, sets the *initial* SCHEDULED status — that is not a
 * transition).
 *
 * Time is read exclusively through `ClockService`, never `Date.now()` /
 * `new Date()` — "has this auction started/ended?" is always decided from
 * the server's clock plus the auction's own persisted `scheduledStartAt`/
 * `currentEndAt`, never a client-supplied timestamp.
 */
@Injectable()
export class AuctionLifecycleService {
  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<AuctionDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditLogService,
    private readonly clock: ClockService,
    @Inject(AUCTION_BID_EXISTENCE_PORT) private readonly bidExistence: AuctionBidExistencePort,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // -----------------------------------------------------------------------
  // Worker-facing: bulk, unattended, idempotent, safe under overlap.
  // -----------------------------------------------------------------------

  /**
   * Activates every SCHEDULED auction whose `scheduledStartAt` has arrived
   * ("arrived" is inclusive: exactly `scheduledStartAt` activates, one
   * millisecond before does not). Each claim is a single atomic
   * `findOneAndUpdate` filtered on `status: SCHEDULED`, so two workers (or
   * two overlapping ticks of the same worker) racing on the same document
   * can never both activate it — whichever wins the Mongo-level race
   * succeeds, the loser's filter simply no longer matches and it moves on.
   * Re-running finds nothing left to claim (idempotent).
   */
  async activateDueAuctions(limit = DEFAULT_BATCH_SIZE): Promise<{ activated: number }> {
    const batchSize = clampBatch(limit);
    let activated = 0;
    for (let i = 0; i < batchSize; i++) {
      const now = this.clock.now();
      const doc = await this.auctions
        .findOneAndUpdate(
          { status: AuctionStatus.SCHEDULED, scheduledStartAt: { $lte: now } },
          { $set: { status: AuctionStatus.ACTIVE } },
          { sort: { scheduledStartAt: 1 }, new: true },
        )
        .exec();
      if (!doc) break;
      activated += 1;
      await this.audit.logSystemAction(
        AuditAction.AUCTION_ACTIVATED,
        doc._id.toString(),
        'auction activated at scheduled start',
        { scheduledStartAt: doc.scheduledStartAt, activatedAt: now },
      );
    }
    return { activated };
  }

  /**
   * Ends every ACTIVE auction whose `currentEndAt` has arrived — the field
   * anti-sniping may have pushed out, never the immutable `scheduledEndAt`.
   * Routes to ENDED_NO_BIDS or ENDED_PENDING_CLOSE via the injected
   * `AuctionBidExistencePort` (see that file — the Bid collection is
   * MAZAD-026 and does not exist yet). The commit is a second, conditional
   * `findOneAndUpdate` that re-checks `status: ACTIVE` at write time, so a
   * concurrent cancellation landing between the read and the write safely
   * loses the race (the `continue` below) instead of both operations
   * applying to the same document.
   */
  async expireDueAuctions(limit = DEFAULT_BATCH_SIZE): Promise<{ endedNoBids: number; endedPendingClose: number }> {
    const batchSize = clampBatch(limit);
    let endedNoBids = 0;
    let endedPendingClose = 0;
    for (let i = 0; i < batchSize; i++) {
      const now = this.clock.now();
      const candidate = await this.auctions
        .findOne({ status: AuctionStatus.ACTIVE, currentEndAt: { $lte: now } })
        .sort({ currentEndAt: 1 })
        .select('_id')
        .lean()
        .exec();
      if (!candidate) break;
      const auctionId = (candidate._id as Types.ObjectId).toString();
      const hasBids = await this.bidExistence.hasValidBids(auctionId);
      const to = hasBids ? AuctionStatus.ENDED_PENDING_CLOSE : AuctionStatus.ENDED_NO_BIDS;
      const doc = await this.auctions
        .findOneAndUpdate(
          { _id: candidate._id, status: AuctionStatus.ACTIVE, currentEndAt: { $lte: now } },
          { $set: { status: to } },
          { new: true },
        )
        .exec();
      if (!doc) continue; // raced with a concurrent cancellation/worker instance — no error, just skip; the next iteration re-scans.
      if (to === AuctionStatus.ENDED_NO_BIDS) {
        endedNoBids += 1;
        await this.audit.logSystemAction(AuditAction.AUCTION_ENDED_NO_BIDS, auctionId, 'auction ended with no bids', { currentEndAt: doc.currentEndAt });
      } else {
        endedPendingClose += 1;
        await this.audit.logSystemAction(AuditAction.AUCTION_ENDED_PENDING_CLOSE, auctionId, 'auction ended, pending automatic winner determination', { currentEndAt: doc.currentEndAt });
      }
    }
    return { endedNoBids, endedPendingClose };
  }

  // -----------------------------------------------------------------------
  // Actor-facing: single auction, explicit authorization, explicit errors.
  // -----------------------------------------------------------------------

  /**
   * Self-service cancellation (frozen V1 rules): the advertiser may cancel
   * before or after start; an ACTIVE cancellation requires a reason;
   * CANCELLED is terminal, preserves whatever bid history exists (nothing
   * here deletes or touches bids — there is nothing to touch yet), and
   * carries no winner. A cancelled auction is never reused — re-auctioning
   * means creating a brand-new `Auction` via `AuctionsService.create`;
   * this method never mutates a document into a different auction.
   *
   * There is no admin marketplace-participation capability for auctions
   * today — MAZAD-023 seeded only `AUCTION_CREATE_OWN`, a marketplace-only
   * capability with no admin-operational counterpart — so, per "do not
   * invent a new marketplace actor model", this remains self-service only
   * until an authoritative admin operational contract exists.
   */
  async cancel(actorId: string, auctionId: string, reason: string | undefined, ip?: string) {
    if (!Types.ObjectId.isValid(auctionId)) {
      throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    }
    const [actor, auction] = await Promise.all([
      this.users.findById(actorId).lean().exec(),
      this.auctions.findById(auctionId).exec(),
    ]);
    if (!actor) throw new NotFoundException({ message: 'الحساب غير موجود', code: AuctionErrorCode.ACTOR_INVALID });
    if (!auction) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });

    AuthorizationPolicyService.assertOwnResource(actor, auction.advertiserAccountId.toString());
    assertValidAuctionTransition(auction.status, AuctionStatus.CANCELLED);

    const trimmedReason = reason?.trim();
    if (auction.status === AuctionStatus.ACTIVE && !trimmedReason) {
      throw new BadRequestException({ message: 'يجب ذكر سبب إلغاء المزاد النشط', code: AuctionErrorCode.CANCELLATION_REASON_REQUIRED });
    }

    const fromStatus = auction.status;
    const session = await this.connection.startSession();
    try {
      let updated: AuctionDocument | null = null;
      await session.withTransaction(async () => {
        updated = await this.auctions
          .findOneAndUpdate(
            { _id: auctionId, status: fromStatus },
            {
              $set: {
                status: AuctionStatus.CANCELLED,
                cancelledByActorId: new Types.ObjectId(actorId),
                cancelledAt: this.clock.now(),
                ...(trimmedReason ? { cancellationReason: trimmedReason } : {}),
              },
            },
            { new: true, session },
          )
          .exec();
        if (!updated) {
          // A worker (or another request) transitioned this auction between
          // our read and the write above — a genuine race the actor should
          // see and retry against fresh state, unlike a worker's silent no-op.
          throw new ConflictException({ message: 'تغيرت حالة المزاد أثناء الإلغاء، أعد التحميل', code: AuctionErrorCode.STATE_CONFLICT });
        }
        await this.audit.logRequired(
          {
            action: AuditAction.AUCTION_CANCELLED,
            actorUserId: actorId,
            targetResourceId: auctionId,
            reason: trimmedReason || 'auction cancelled',
            ip,
            metadata: { fromStatus, propertyId: auction.propertyId.toString() },
          },
          session,
        );
      });
      return { message: 'تم إلغاء المزاد بنجاح', auction: this.toSummary(updated!.toObject()) };
    } finally {
      await session.endSession();
    }
  }

  // -----------------------------------------------------------------------
  // Anti-sniping primitive. MAZAD-024 provides it; MAZAD-027 calls it from
  // atomic bid acceptance. Bid acceptance itself is NOT implemented here.
  // -----------------------------------------------------------------------

  /**
   * If `bidAt` falls inside the auction's final `antiSnipingWindowSeconds`
   * — measured against the *current* `currentEndAt`, never the immutable
   * `scheduledEndAt` — pushes `currentEndAt` forward by
   * `antiSnipingExtensionSeconds`. Repeatable with no cap, per the frozen
   * V1 rule; both durations are read from the auction's own immutable
   * `ruleSnapshot`, never from a mutable/global config.
   *
   * Safe to call from within a larger transaction (pass `session` in
   * `context`) — MAZAD-027's atomic bid-acceptance path is expected to do
   * exactly that, so a bid and the extension it triggers commit or roll
   * back together. Never shortens `currentEndAt`. Never applies once the
   * auction has left ACTIVE. The write is a conditional `findOneAndUpdate`
   * keyed on the exact `currentEndAt` value just read (a compare-and-swap);
   * a losing race — another extension or the closing worker committed
   * first — is reported as `extended: false` rather than corrupting the
   * timeline, and MAZAD-027 can re-derive from fresh state.
   */
  async extendIfWithinAntiSnipingWindow(
    auctionId: string,
    bidAt: Date,
    context: { session?: ClientSession } = {},
  ): Promise<{ extended: boolean; currentEndAt: Date }> {
    if (!Types.ObjectId.isValid(auctionId)) {
      throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    }
    const auction = await this.auctions.findById(auctionId).session(context.session ?? null).exec();
    if (!auction) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    if (auction.status !== AuctionStatus.ACTIVE) {
      return { extended: false, currentEndAt: auction.currentEndAt };
    }

    const observedEndAt = auction.currentEndAt;
    const windowMs = auction.ruleSnapshot.antiSnipingWindowSeconds * 1000;
    const remainingMs = observedEndAt.getTime() - bidAt.getTime();
    if (remainingMs > windowMs) {
      return { extended: false, currentEndAt: observedEndAt };
    }

    const extensionMs = auction.ruleSnapshot.antiSnipingExtensionSeconds * 1000;
    const newEndAt = new Date(observedEndAt.getTime() + extensionMs);
    const updated = await this.auctions
      .findOneAndUpdate(
        { _id: auctionId, status: AuctionStatus.ACTIVE, currentEndAt: observedEndAt },
        { $set: { currentEndAt: newEndAt } },
        { new: true, session: context.session },
      )
      .exec();
    if (!updated) {
      return { extended: false, currentEndAt: observedEndAt };
    }
    await this.audit.logSystemAction(
      AuditAction.AUCTION_END_TIME_EXTENDED,
      auctionId,
      'auction end time extended (anti-sniping)',
      { from: observedEndAt, to: updated.currentEndAt },
    );
    return { extended: true, currentEndAt: updated.currentEndAt };
  }

  private toSummary(item: any) {
    return {
      id: item._id.toString(),
      propertyId: item.propertyId.toString(),
      advertiserAccountId: item.advertiserAccountId.toString(),
      status: item.status,
      scheduledStartAt: item.scheduledStartAt,
      scheduledEndAt: item.scheduledEndAt,
      currentEndAt: item.currentEndAt,
      cancelledAt: item.cancelledAt,
      cancellationReason: item.cancellationReason,
    };
  }
}
