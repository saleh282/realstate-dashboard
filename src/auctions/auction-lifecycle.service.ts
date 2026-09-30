import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';
import { Capability } from '../authorization/capability';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { retryConflict, runTransactionWithRetry } from '../common/mongo/transaction-runner';
import { ClockService } from '../common/time/clock.service';
import {
  auctionActivatedEvent,
  auctionCancelledEvent,
  auctionEndExtendedEvent,
  auctionEndedNoBidsEvent,
  auctionEndedPendingCloseEvent,
} from '../outbox/outbox-events';
import { OutboxService } from '../outbox/outbox.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { AuctionActivationGate } from './auction-activation-gate';
import { AUCTION_BID_EXISTENCE_PORT, AuctionBidExistencePort } from './auction-bid-existence.port';
import { AuctionParticipantsReader } from './auction-participants.reader';
import {
  AdminAuctionCancellationCode,
  AuctionCancellationSource,
  SystemAuctionCancellationCode,
  assertReasonWithNote,
} from './auction-request.types';
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
    private readonly outbox: OutboxService,
    private readonly activationGate: AuctionActivationGate,
    private readonly participants: AuctionParticipantsReader,
  ) {}

  // -----------------------------------------------------------------------
  // Worker-facing: bulk, unattended, idempotent, safe under overlap.
  // -----------------------------------------------------------------------

  /**
   * Activates every SCHEDULED auction whose `scheduledStartAt` has arrived
   * ("arrived" is inclusive: exactly `scheduledStartAt` activates, one
   * millisecond before does not). Each activation is a conditional
   * `findOneAndUpdate` filtered on `status: SCHEDULED`, so two workers (or
   * two overlapping ticks of the same worker) racing on the same document
   * can never both activate it. Re-running finds nothing left (idempotent).
   *
   * MAZAD-031: each claim runs in its own transaction together with its
   * `AUCTION_ACTIVATED` outbox event, so the transition and its event commit
   * or abort as one. The best-effort audit telemetry stays after the commit.
   *
   * MAZAD-035 activation gate: inside that transaction `AuctionActivationGate`
   * re-checks the fee (0 = FREE is configured; absent is not), the seller's
   * eligibility, the property and the anchored SALE revision. A failing
   * auction is NOT activated and NOT cancelled: it gets an `activationHold`
   * marker (surfaced to Admin operations) and the candidate query excludes
   * held auctions, so one bad row can never starve the ones behind it.
   */
  async activateDueAuctions(limit = DEFAULT_BATCH_SIZE): Promise<{ activated: number; held: number }> {
    const batchSize = clampBatch(limit);
    let activated = 0;
    let held = 0;
    for (let i = 0; i < batchSize; i++) {
      const outcome = await runTransactionWithRetry(
        this.connection,
        async (session) => {
          const now = this.clock.now();
          const candidate = await this.auctions
            .findOne({ status: AuctionStatus.SCHEDULED, scheduledStartAt: { $lte: now }, activationHold: { $exists: false } })
            .sort({ scheduledStartAt: 1 })
            .session(session)
            .exec();
          if (!candidate) return { kind: 'NONE' as const };
          const holdCode = await this.activationGate.evaluate(candidate, session);
          if (holdCode) {
            const heldDoc = await this.auctions
              .findOneAndUpdate(
                { _id: candidate._id, status: AuctionStatus.SCHEDULED, activationHold: { $exists: false } },
                { $set: { activationHold: { code: holdCode, at: now } } },
                { new: true, session },
              )
              .exec();
            return heldDoc ? { kind: 'HELD' as const, doc: heldDoc, holdCode, now } : { kind: 'RACED' as const };
          }
          const doc = await this.auctions
            .findOneAndUpdate(
              { _id: candidate._id, status: AuctionStatus.SCHEDULED, scheduledStartAt: { $lte: now }, activationHold: { $exists: false } },
              { $set: { status: AuctionStatus.ACTIVE } },
              { new: true, session },
            )
            .exec();
          if (!doc) return { kind: 'RACED' as const };
          await this.outbox.recordRequired(auctionActivatedEvent({
            auctionId: doc._id.toString(), occurredAt: now, currentEndAt: doc.currentEndAt,
            advertiserAccountId: doc.advertiserAccountId.toString(),
          }), session);
          return { kind: 'ACTIVATED' as const, doc, now };
        },
        { retryExhausted: retryConflict('تحديث حالة المزاد قيد المعالجة؛ أعد المحاولة', AuctionErrorCode.STATE_CONFLICT) },
      );
      if (outcome.kind === 'NONE') break;
      if (outcome.kind === 'RACED') continue;
      if (outcome.kind === 'HELD') {
        held += 1;
        await this.audit.logSystemAction(AuditAction.AUCTION_ACTIVATION_HELD, outcome.doc._id.toString(), 'auction activation held by the activation gate', { code: outcome.holdCode, heldAt: outcome.now });
        continue;
      }
      activated += 1;
      // Best-effort telemetry, unchanged from MAZAD-024: only after the transition and its event committed.
      await this.audit.logSystemAction(
        AuditAction.AUCTION_ACTIVATED,
        outcome.doc._id.toString(),
        'auction activated at scheduled start',
        { scheduledStartAt: outcome.doc.scheduledStartAt, activatedAt: outcome.now },
      );
    }
    return { activated, held };
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
   *
   * MAZAD-031: the read, the conditional write and the
   * `AUCTION_ENDED_NO_BIDS` / `AUCTION_ENDED_PENDING_CLOSE` outbox event are
   * one transaction per auction. The bid-existence read is deliberately not
   * session-bound: it is safe because any bid that commits after this
   * transaction's snapshot has modified the Auction document, so the
   * conditional write conflicts and the whole attempt is retried against
   * fresh state.
   */
  async expireDueAuctions(limit = DEFAULT_BATCH_SIZE): Promise<{ endedNoBids: number; endedPendingClose: number }> {
    const batchSize = clampBatch(limit);
    let endedNoBids = 0;
    let endedPendingClose = 0;
    for (let i = 0; i < batchSize; i++) {
      // One transaction per auction (MAZAD-031): the ACTIVE → ENDED_* write and its outbox event commit together.
      const outcome = await runTransactionWithRetry(
        this.connection,
        async (session) => {
          const now = this.clock.now();
          const candidate = await this.auctions
            .findOne({ status: AuctionStatus.ACTIVE, currentEndAt: { $lte: now } })
            .sort({ currentEndAt: 1 })
            .select('_id')
            .session(session)
            .lean()
            .exec();
          if (!candidate) return { kind: 'NONE' as const };
          const auctionId = (candidate._id as Types.ObjectId).toString();
          const hasBids = await this.bidExistence.hasValidBids(auctionId);
          const to = hasBids ? AuctionStatus.ENDED_PENDING_CLOSE : AuctionStatus.ENDED_NO_BIDS;
          const doc = await this.auctions
            .findOneAndUpdate(
              { _id: candidate._id, status: AuctionStatus.ACTIVE, currentEndAt: { $lte: now } },
              { $set: { status: to } },
              { new: true, session },
            )
            .exec();
          if (!doc) return { kind: 'RACED' as const }; // raced with a concurrent cancellation/worker instance — nothing written; the next iteration re-scans.
          await this.outbox.recordRequired(
            to === AuctionStatus.ENDED_NO_BIDS
              ? auctionEndedNoBidsEvent({ auctionId, occurredAt: now, currentEndAt: doc.currentEndAt })
              : auctionEndedPendingCloseEvent({ auctionId, occurredAt: now, currentEndAt: doc.currentEndAt, acceptedBidCount: doc.acceptedBidCount ?? 0 }),
            session,
          );
          return { kind: 'ENDED' as const, to, doc, auctionId };
        },
        { retryExhausted: retryConflict('تحديث حالة المزاد قيد المعالجة؛ أعد المحاولة', AuctionErrorCode.STATE_CONFLICT) },
      );
      if (outcome.kind === 'NONE') break;
      if (outcome.kind === 'RACED') continue;
      // Best-effort telemetry, unchanged from MAZAD-024: only after the transition and its event committed.
      if (outcome.to === AuctionStatus.ENDED_NO_BIDS) {
        endedNoBids += 1;
        await this.audit.logSystemAction(AuditAction.AUCTION_ENDED_NO_BIDS, outcome.auctionId, 'auction ended with no bids', { currentEndAt: outcome.doc.currentEndAt });
      } else {
        endedPendingClose += 1;
        await this.audit.logSystemAction(AuditAction.AUCTION_ENDED_PENDING_CLOSE, outcome.auctionId, 'auction ended, pending automatic winner determination', { currentEndAt: outcome.doc.currentEndAt });
      }
    }
    return { endedNoBids, endedPendingClose };
  }

  // -----------------------------------------------------------------------
  // Actor-facing: single auction, explicit authorization, explicit errors.
  // -----------------------------------------------------------------------

  /**
   * Self-service cancellation (frozen V1 rules, Product decision 7): the
   * advertiser may cancel a SCHEDULED auction, or an ACTIVE one with a reason;
   * never after it ended. CANCELLED is terminal, preserves bid history and
   * carries no winner; re-auctioning means a new request and a new review.
   * Payments and entitlements are left untouched (no refund policy exists).
   */
  async cancel(actorId: string, auctionId: string, reason: string | undefined, ip?: string, expectedStatus?: AuctionStatus) {
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
    // Optimistic guard (MAZAD-025): the caller states the status it last saw;
    // if the auction has moved on, fail rather than cancel under stale
    // assumptions (e.g. SCHEDULED -> ACTIVE changes the reason requirement).
    if (expectedStatus && auction.status !== expectedStatus) {
      throw new ConflictException({ message: 'تغيرت حالة المزاد؛ أعد التحميل', code: AuctionErrorCode.STATE_CONFLICT });
    }
    assertValidAuctionTransition(auction.status, AuctionStatus.CANCELLED);
    if (this.clock.now().getTime() >= auction.currentEndAt.getTime()) {
      throw new ConflictException({ message: "انتهى وقت المزاد؛ لم يعد إلغاؤه ممكنًا", code: AuctionErrorCode.TRANSITION_INVALID });
    }

    const trimmedReason = reason?.trim();
    if (auction.status === AuctionStatus.ACTIVE && !trimmedReason) {
      throw new BadRequestException({ message: 'يجب ذكر سبب إلغاء المزاد النشط', code: AuctionErrorCode.CANCELLATION_REASON_REQUIRED });
    }

    const updated = await this.commitCancellation({
      auctionId,
      fromStatus: auction.status,
      actorId,
      ip,
      set: {
        ...(trimmedReason ? { cancellationReason: trimmedReason } : {}),
        cancellationReasonCode: SystemAuctionCancellationCode.SELLER_CANCELLED,
        cancelledBySource: AuctionCancellationSource.SELLER,
      },
      auditReason: trimmedReason || 'auction cancelled',
      auditMetadata: { source: AuctionCancellationSource.SELLER },
      propertyId: auction.propertyId.toString(),
      notifyAdvertiser: true,
      requireUnexpired: true,
    });
    return { message: 'تم إلغاء المزاد بنجاح', auction: this.toSummary(updated.toObject()) };
  }

  /**
   * MAZAD-035 Admin cancellation (Product decision 8): SCHEDULED or ACTIVE
   * only, a structured reason code is mandatory and OTHER needs a note. The
   * note is Admin-only. Bids are never touched and no winner is chosen.
   * `expectedStatus` is mandatory so a stale Admin screen cannot cancel an
   * auction that has since moved on.
   */
  async cancelByAdmin(
    adminActorId: string,
    auctionId: string,
    input: { reasonCode: unknown; note?: string; expectedStatus: AuctionStatus },
    ip?: string,
  ) {
    if (!Types.ObjectId.isValid(auctionId)) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    const actor = await this.users.findById(adminActorId).lean().exec();
    if (!actor) throw new NotFoundException({ message: 'الحساب غير موجود', code: AuctionErrorCode.ACTOR_INVALID });
    AuthorizationPolicyService.assert(actor, Capability.ADMIN_AUCTION_CANCEL);
    const { reasonCode, note } = assertReasonWithNote(input.reasonCode, Object.values(AdminAuctionCancellationCode), input.note);

    const auction = await this.auctions.findById(auctionId).exec();
    if (!auction) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    if (auction.status !== input.expectedStatus) {
      throw new ConflictException({ message: 'تغيرت حالة المزاد؛ أعد التحميل', code: AuctionErrorCode.STATE_CONFLICT });
    }
    assertValidAuctionTransition(auction.status, AuctionStatus.CANCELLED);

    const updated = await this.commitCancellation({
      auctionId,
      fromStatus: auction.status,
      actorId: adminActorId,
      ip,
      set: {
        cancellationReasonCode: reasonCode,
        cancelledBySource: AuctionCancellationSource.ADMIN,
        ...(note ? { cancellationInternalNote: note } : {}),
      },
      auditReason: `admin cancelled auction: ${reasonCode}`,
      auditMetadata: { source: AuctionCancellationSource.ADMIN, reasonCode, ...(note ? { note } : {}) },
      propertyId: auction.propertyId.toString(),
      notifyAdvertiser: true,
      requireUnexpired: false,
    });
    return { message: 'تم إلغاء المزاد', auction: this.toSummary(updated.toObject()) };
  }

  /**
   * MAZAD-035 (Product decision 6), called inside the seller's revision
   * transaction: the approved auction must not have started, and it is
   * cancelled as TERMS_REVISED so the old approval can never activate. Fails
   * closed — and so aborts the whole revision — when any payment attempt,
   * reconciliation flag or entitlement exists: changing terms under a
   * financial obligation is a policy question, not something to guess.
   * Payment initiation writes the Auction document (`entryPaymentAttemptCount`),
   * so a concurrently opened attempt conflicts with this write instead of
   * slipping past the check.
   */
  async supersedeForRevisionWithinTransaction(session: ClientSession, input: { auctionId: Types.ObjectId; actorId: string; now: Date }) {
    const updated = await this.auctions
      .findOneAndUpdate(
        { _id: input.auctionId, status: AuctionStatus.SCHEDULED, scheduledStartAt: { $gt: input.now } },
        {
          $set: {
            status: AuctionStatus.CANCELLED,
            cancelledByActorId: new Types.ObjectId(input.actorId),
            cancelledAt: input.now,
            cancellationReasonCode: SystemAuctionCancellationCode.TERMS_REVISED,
            cancelledBySource: AuctionCancellationSource.SELLER,
          },
        },
        { new: true, session },
      )
      .exec();
    if (!updated) {
      const current = await this.auctions.findById(input.auctionId).session(session).lean().exec();
      if (current && current.status !== AuctionStatus.SCHEDULED) {
        throw new ConflictException({ message: 'لا يمكن تعديل شروط مزاد بدأ أو انتهى أو أُلغي', code: AuctionErrorCode.ALREADY_STARTED });
      }
      throw new ConflictException({ message: 'حان موعد بدء المزاد؛ لم يعد تعديل شروطه ممكنًا', code: AuctionErrorCode.ALREADY_STARTED });
    }
    const activity = await this.participants.financialActivity(input.auctionId.toString(), session);
    if (activity.livePayments || activity.flaggedPayments || activity.entitlements) {
      throw new ConflictException({
        message: 'لا يمكن تعديل شروط المزاد بعد بدء المشاركين في دفع رسوم الاشتراك؛ تواصل مع الإدارة',
        code: AuctionErrorCode.REVISION_BLOCKED_BY_PAYMENTS,
      });
    }
    await this.audit.logRequired(
      {
        action: AuditAction.AUCTION_CANCELLED,
        actorUserId: input.actorId,
        targetResourceId: updated._id.toString(),
        reason: 'approved auction superseded by a seller revision before start',
        metadata: { fromStatus: AuctionStatus.SCHEDULED, source: AuctionCancellationSource.SELLER, reasonCode: SystemAuctionCancellationCode.TERMS_REVISED, propertyId: updated.propertyId.toString() },
      },
      session,
    );
    // Public subscribers of this auction learn it is gone; the seller (who asked for it) is not notified.
    await this.outbox.recordRequired(auctionCancelledEvent({
      auctionId: updated._id.toString(), occurredAt: input.now, previousStatus: AuctionStatus.SCHEDULED,
      participantAccountIds: await this.participants.forCancellation(updated._id.toString(), session),
    }), session);
    return updated;
  }

  private async commitCancellation(input: {
    auctionId: string; fromStatus: AuctionStatus; actorId: string; ip?: string; set: Record<string, unknown>;
    auditReason: string; auditMetadata: Record<string, unknown>; propertyId: string; notifyAdvertiser: boolean; requireUnexpired: boolean;
  }): Promise<AuctionDocument> {
    const session = await this.connection.startSession();
    try {
      let updated: AuctionDocument | null = null;
      await session.withTransaction(async () => {
        const cancelledAt = this.clock.now();
        updated = await this.auctions
          .findOneAndUpdate(
            { _id: input.auctionId, status: input.fromStatus, ...(input.requireUnexpired ? { currentEndAt: { $gt: cancelledAt } } : {}) },
            { $set: { status: AuctionStatus.CANCELLED, cancelledByActorId: new Types.ObjectId(input.actorId), cancelledAt, ...input.set } },
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
            actorUserId: input.actorId,
            targetResourceId: input.auctionId,
            reason: input.auditReason,
            ip: input.ip,
            metadata: { fromStatus: input.fromStatus, propertyId: input.propertyId, ...input.auditMetadata },
          },
          session,
        );
        // MAZAD-031: the domain event commits with the cancellation and its audit row (the reason is not in it).
        // MAZAD-035: paid/entitled bidders and bidders are routed privately for the cancellation notification.
        const participantAccountIds = await this.participants.forCancellation(input.auctionId, session);
        await this.outbox.recordRequired(auctionCancelledEvent({
          auctionId: updated!._id.toString(), occurredAt: cancelledAt, previousStatus: input.fromStatus,
          ...(input.notifyAdvertiser ? { advertiserAccountId: updated!.advertiserAccountId.toString() } : {}),
          participantAccountIds,
        }), session);
      });
      return updated!;
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
    // Inside a caller's transaction (MAZAD-027 bid acceptance) the caller audits transactionally, once, as part
    // of its own event; a best-effort audit here could log an extension a later rollback or retry still discards.
    // The AUCTION_END_EXTENDED outbox event, by contrast, is written in EVERY case in the transaction that moves
    // `currentEndAt` (MAZAD-031), so it commits or rolls back with the extension itself.
    if (context.session) {
      const { extended, currentEndAt } = await this.extendWithinTransaction(auctionId, bidAt, context.session);
      return { extended, currentEndAt };
    }
    // Standalone use: the extension and its event are their own transaction.
    const result = await runTransactionWithRetry(
      this.connection,
      (session) => this.extendWithinTransaction(auctionId, bidAt, session),
      { retryExhausted: retryConflict('تحديث وقت انتهاء المزاد قيد المعالجة؛ أعد المحاولة', AuctionErrorCode.STATE_CONFLICT) },
    );
    if (result.extended) {
      await this.audit.logSystemAction(
        AuditAction.AUCTION_END_TIME_EXTENDED,
        auctionId,
        'auction end time extended (anti-sniping)',
        { from: result.previousEndAt, to: result.currentEndAt },
      );
    }
    return { extended: result.extended, currentEndAt: result.currentEndAt };
  }

  private async extendWithinTransaction(
    auctionId: string,
    bidAt: Date,
    session: ClientSession,
  ): Promise<{ extended: boolean; currentEndAt: Date; previousEndAt: Date }> {
    const auction = await this.auctions.findById(auctionId).session(session).exec();
    if (!auction) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    if (auction.status !== AuctionStatus.ACTIVE) {
      return { extended: false, currentEndAt: auction.currentEndAt, previousEndAt: auction.currentEndAt };
    }

    const observedEndAt = auction.currentEndAt;
    const windowMs = auction.ruleSnapshot.antiSnipingWindowSeconds * 1000;
    const remainingMs = observedEndAt.getTime() - bidAt.getTime();
    if (remainingMs > windowMs) {
      return { extended: false, currentEndAt: observedEndAt, previousEndAt: observedEndAt };
    }

    const extensionMs = auction.ruleSnapshot.antiSnipingExtensionSeconds * 1000;
    const newEndAt = new Date(observedEndAt.getTime() + extensionMs);
    const updated = await this.auctions
      .findOneAndUpdate(
        { _id: auctionId, status: AuctionStatus.ACTIVE, currentEndAt: observedEndAt },
        { $set: { currentEndAt: newEndAt } },
        { new: true, session },
      )
      .exec();
    if (!updated) {
      return { extended: false, currentEndAt: observedEndAt, previousEndAt: observedEndAt };
    }
    // After the auction write (the aggregate's serialisation point), in the same transaction.
    await this.outbox.recordRequired(
      auctionEndExtendedEvent({ auctionId: updated._id.toString(), occurredAt: bidAt, previousEndAt: observedEndAt, currentEndAt: updated.currentEndAt }),
      session,
    );
    return { extended: true, currentEndAt: updated.currentEndAt, previousEndAt: observedEndAt };
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
      cancellationReasonCode: item.cancellationReasonCode,
      cancelledBySource: item.cancelledBySource,
    };
  }
}
