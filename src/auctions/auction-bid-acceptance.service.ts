import { BadRequestException, ConflictException, Inject, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';
import { BidLedgerService } from '../bids/bid-ledger.service';
import { BidRequest, BidRequestDocument } from '../bids/schemas/bid-request.schema';
import { Bid, BidDocument } from '../bids/schemas/bid.schema';
import { IdempotencyErrorCode, sha256 } from '../common/idempotency/idempotency.service';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { BidErrorCode } from '../common/errors/bid-error-codes';
import { EGP_CURRENCY, MONEY_MINOR_MAX, isMoneyMinorAmount } from '../common/money/money';
import { ClockService } from '../common/time/clock.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { AUCTION_BID_ENTITLEMENT_PORT, AuctionBidEntitlementPort } from './auction-bid-entitlement.port';
import { AuctionLifecycleService } from './auction-lifecycle.service';
import { AuctionStatus } from './auction.types';
import { Auction, AuctionDocument } from './schemas/auction.schema';

/** Whole-transaction attempts before giving up with a retryable conflict. */
export const BID_ACCEPTANCE_MAX_ATTEMPTS = 8;
/** Upper bound of the randomised pause before retry N (N * this), de-synchronising bidders that just collided. */
const RETRY_JITTER_MS = 8;
/** Attempts to re-issue only the commit after an UnknownTransactionCommitResult (safe: never re-runs the work). */
const COMMIT_MAX_ATTEMPTS = 5;

/** Internal: this attempt decided from stale state and lost a race; a fresh attempt re-reads and decides again. */
export class BidAttemptConflict extends Error {}

/**
 * The internal authoritative outcome of an accepted bid (MAZAD-029 will map
 * it to an HTTP contract; nothing here is exposed publicly yet). `bid`
 * carries the bidder's identity and is internal — use `toAnonymizedBid` for
 * anything public.
 */
export type AcceptedBidResult = {
  bid: {
    id: string;
    auctionId: string;
    bidderAccountId: string;
    bidderAccountTypeSnapshot: string;
    sequence: number;
    amountMinor: number;
    currency: string;
    acceptedAt: Date;
  };
  auction: {
    id: string;
    status: AuctionStatus;
    /** The post-extension authoritative end time. */
    currentEndAt: Date;
    previousEndAt: Date;
    extended: boolean;
    acceptedBidCount: number;
  };
  /** The smallest amount the next bid must reach (this amount + step), or null if that would exceed the money ceiling. */
  nextMinimumBidMinor: number | null;
  /** True when this is the recorded result of an earlier identical request (MAZAD-029); nothing was written. */
  replayed: boolean;
};

/** Client idempotency context for one logical bid request (MAZAD-029). The raw key is hashed before it is stored. */
export type BidIdempotency = { key: string };

/**
 * MAZAD-027 — the authoritative atomic bid-acceptance path. Internal domain
 * service only: there is deliberately no controller (MAZAD-029), and with the
 * default fail-closed entitlement port (MAZAD-028 replaces it) no bid can be
 * accepted in a running application yet.
 *
 * Algorithm — ONE Mongo transaction per attempt, in this order:
 *  1. read the server clock ONCE (`now`); nothing client-supplied is time;
 *  2. read the Auction and the bidder (server actor id, never input);
 *  3. authorise: `assertBid` (capability, admin/suspended/broker rules, exact
 *     advertiser self-bid), then require status ACTIVE and `now < currentEndAt`
 *     (equality is REJECTED: a bid must commit strictly before the end);
 *  4. entitlement port (MAZAD-028);
 *  5. WRITE THE AUCTION FIRST — a compare-and-swap
 *     `{_id, status: ACTIVE, currentEndAt: <observed>}` with `$inc acceptedBidCount`;
 *  6. only then read the ledger: highest bid → required minimum → compare;
 *  7. `nextSequenceFor` (must equal the incremented counter) → append the Bid;
 *  8. anti-sniping via `AuctionLifecycleService.extendIfWithinAntiSnipingWindow`
 *     in the same session;
 *  9. transactional audit event; commit.
 * Any failure aborts the transaction: no Bid, counter increment or extension
 * survives.
 *
 * Why concurrent bids cannot both win: step 5 changes the Auction document,
 * and MongoDB allows only one in-flight transaction to modify a document — a
 * second writer gets a WriteConflict (TransientTransactionError) and, if it
 * started from an older snapshot, also fails once the first commits. The
 * loser therefore never reaches steps 6-7 with stale ledger data: it is
 * retried from scratch and re-reads the winner's bid, extension and status.
 * Because the ledger read and the sequence are taken after the write, the
 * sequence is dense and unique; the `(auctionId, sequence)` unique index is
 * the backstop, and a duplicate-key error is treated as a retryable race.
 *
 * Retries: only when the attempt provably did not commit (transient/write
 * conflict, duplicate sequence, lost CAS), bounded by
 * `BID_ACCEPTANCE_MAX_ATTEMPTS`, each in a fresh transaction. An
 * UnknownTransactionCommitResult re-issues only the commit, never the work,
 * so a retry can never create a second Bid. Request-level (client)
 * idempotency is NOT implemented here — it belongs to MAZAD-029.
 *
 * Worker race: the lifecycle worker expires with a conditional update on
 * `{status: ACTIVE, currentEndAt <= now}`. A valid bid extends `currentEndAt`
 * inside its own transaction, so once it commits the worker's filter no
 * longer matches; while it is in flight the worker's write waits on the
 * document; and if the worker commits first, the bid's write conflicts and
 * its retry sees a non-ACTIVE/ended auction and is rejected. An accepted Bid
 * therefore always has `acceptedAt < currentEndAt-as-of-its-decision`.
 */
@Injectable()
export class AuctionBidAcceptanceService {
  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<AuctionDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Bid.name) private readonly bids: Model<BidDocument>,
    @InjectModel(BidRequest.name) private readonly bidRequests: Model<BidRequestDocument>,
    private readonly ledger: BidLedgerService,
    private readonly lifecycle: AuctionLifecycleService,
    private readonly audit: AuditLogService,
    private readonly clock: ClockService,
    @Inject(AUCTION_BID_ENTITLEMENT_PORT) private readonly entitlement: AuctionBidEntitlementPort,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /** `actorId` MUST be the authenticated principal's id; it is the only source of bidder identity. */
  async acceptBid(actorId: string, auctionId: string, amountMinor: unknown, ip?: string, idempotency?: BidIdempotency): Promise<AcceptedBidResult> {
    const amount = this.validateAmountShape(amountMinor);
    if (!Types.ObjectId.isValid(auctionId)) {
      throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    }
    if (!Types.ObjectId.isValid(actorId)) {
      throw new NotFoundException({ message: 'الحساب غير موجود', code: AuctionErrorCode.ACTOR_INVALID });
    }

    for (let attempt = 1; attempt <= BID_ACCEPTANCE_MAX_ATTEMPTS; attempt++) {
      const session = await this.connection.startSession();
      try {
        session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        let result: AcceptedBidResult;
        try {
          result = await this.acceptWithinTransaction(session, actorId, auctionId, amount, ip, idempotency);
        } catch (error) {
          await this.abortQuietly(session);
          if (this.isRetryable(error)) { await this.pause(attempt); continue; }
          throw error;
        }
        try {
          await this.commit(session);
        } catch (error) {
          await this.abortQuietly(session);
          if (this.hasLabel(error, 'TransientTransactionError')) { await this.pause(attempt); continue; } // provably not committed
          throw error;
        }
        return result;
      } finally {
        await session.endSession();
      }
    }
    throw new ConflictException({
      message: 'المزايدة على هذا المزاد نشطة حالياً؛ أعد المحاولة',
      code: BidErrorCode.RETRY_EXHAUSTED,
      // A retryable conflict: nothing was written; the same request (same Idempotency-Key) may be retried.
      retryAfterSeconds: 1,
      details: { retryable: true },
    });
  }

  private async acceptWithinTransaction(
    session: ClientSession,
    actorId: string,
    auctionId: string,
    amount: number,
    ip: string | undefined,
    idempotency?: BidIdempotency,
  ): Promise<AcceptedBidResult> {
    const now = this.clock.now(); // the single authoritative instant for this attempt

    // (0) Request-level idempotency (MAZAD-029): a recorded request is replayed verbatim, before any decision is re-made.
    const idem = idempotency ? { keyHash: sha256(idempotency.key), fingerprint: sha256(`bid:v1:${amount}`) } : undefined;
    if (idem) {
      const recorded: any = await this.bidRequests
        .findOne({ bidderAccountId: new Types.ObjectId(actorId), auctionId: new Types.ObjectId(auctionId), keyHash: idem.keyHash })
        .session(session)
        .lean()
        .exec();
      if (recorded) {
        if (recorded.fingerprint !== idem.fingerprint) {
          throw new ConflictException({ message: 'تم استخدام مفتاح منع التكرار مع بيانات مختلفة', code: IdempotencyErrorCode.KEY_REUSED });
        }
        return { ...(recorded.result as Omit<AcceptedBidResult, 'replayed'>), replayed: true };
      }
    }

    // Sequential on purpose: operations on one transaction's session must not be issued concurrently.
    const auction = await this.auctions.findById(auctionId).session(session).exec();
    const actor = await this.users.findById(actorId).session(session).lean().exec();
    if (!auction) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    if (!actor) throw new NotFoundException({ message: 'الحساب غير موجود', code: AuctionErrorCode.ACTOR_INVALID });

    // Capability + admin/suspended/broker rules + exact-account self-bid.
    AuthorizationPolicyService.assertBid(actor, auction.advertiserAccountId.toString());

    if (auction.status !== AuctionStatus.ACTIVE) {
      throw new ConflictException({ message: 'المزاد غير نشط حالياً', code: BidErrorCode.AUCTION_NOT_ACTIVE });
    }
    const observedEndAt = auction.currentEndAt;
    if (now.getTime() >= observedEndAt.getTime()) {
      throw new ConflictException({ message: 'انتهى وقت المزاد', code: BidErrorCode.AUCTION_ENDED });
    }

    await this.entitlement.assertEntitled({ auctionId, bidderAccountId: actorId, session });

    // (5) Write the Auction first: CAS on the exact state the decision rests on.
    const acquired = await this.auctions
      .findOneAndUpdate(
        { _id: auction._id, status: AuctionStatus.ACTIVE, currentEndAt: observedEndAt },
        { $inc: { acceptedBidCount: 1 } },
        { new: true, session },
      )
      .exec();
    if (!acquired) throw new BidAttemptConflict('auction changed since it was read');

    // (6) Decide from the ledger — only now that the Auction is ours.
    const highest = await this.ledger.getHighestForAuction(auctionId, { session });
    const minimum = this.requiredMinimum(auction.startingPriceMinor, auction.minimumBidStepMinor, highest?.amountMinor);
    if (amount < minimum) {
      throw new BadRequestException({
        message: 'قيمة المزايدة أقل من الحد الأدنى المطلوب',
        code: BidErrorCode.BELOW_MINIMUM,
        details: { minimumBidMinor: minimum },
      });
    }

    // (7) Sequence, strictly after the Auction write; then append exactly one Bid.
    const sequence = await this.ledger.nextSequenceFor(auctionId, { session });
    if (sequence !== acquired.acceptedBidCount) {
      throw new InternalServerErrorException({ message: 'تعذر تسجيل المزايدة', code: BidErrorCode.LEDGER_INCONSISTENT });
    }
    const [bid] = await this.bids.create(
      [{
        auctionId: auction._id,
        bidderAccountId: new Types.ObjectId(actorId),
        bidderAccountTypeSnapshot: (actor as any).accountType,
        sequence,
        amountMinor: amount,
        currency: EGP_CURRENCY,
        acceptedAt: now,
      }],
      { session },
    );

    // (8) Anti-sniping, same session. If the bid is inside the window the extension MUST happen.
    const windowMs = auction.ruleSnapshot.antiSnipingWindowSeconds * 1000;
    const extension = await this.lifecycle.extendIfWithinAntiSnipingWindow(auctionId, now, { session });
    const mustExtend = observedEndAt.getTime() - now.getTime() <= windowMs;
    if (mustExtend && !extension.extended) throw new BidAttemptConflict('anti-sniping extension lost a race');

    // (9) One transactional audit event for the whole acceptance.
    await this.audit.logRequired(
      {
        action: AuditAction.AUCTION_BID_ACCEPTED,
        actorUserId: actorId,
        targetResourceId: auctionId,
        reason: 'bid accepted',
        ip,
        metadata: {
          bidId: bid._id.toString(),
          sequence,
          amountMinor: amount,
          extended: extension.extended,
          previousEndAt: observedEndAt,
          currentEndAt: extension.currentEndAt,
        },
      },
      session,
    );

    const result: AcceptedBidResult = {
      bid: {
        id: bid._id.toString(),
        auctionId,
        bidderAccountId: actorId,
        bidderAccountTypeSnapshot: bid.bidderAccountTypeSnapshot,
        sequence,
        amountMinor: amount,
        currency: EGP_CURRENCY,
        acceptedAt: now,
      },
      auction: {
        id: auctionId,
        status: AuctionStatus.ACTIVE,
        currentEndAt: extension.currentEndAt,
        previousEndAt: observedEndAt,
        extended: extension.extended,
        acceptedBidCount: acquired.acceptedBidCount,
      },
      nextMinimumBidMinor: this.safeAdd(amount, auction.minimumBidStepMinor),
      replayed: false,
    };

    // (10) Record the logical request in the SAME transaction as the Bid: both commit, or neither does.
    if (idem) {
      const { replayed: _replayed, ...stored } = result;
      void _replayed;
      await this.bidRequests.create(
        [{ bidderAccountId: new Types.ObjectId(actorId), auctionId: auction._id, keyHash: idem.keyHash, fingerprint: idem.fingerprint, bidId: bid._id, result: stored }],
        { session },
      );
    }
    return result;
  }

  /** Overflow-safe: never adds past the money ceiling. */
  private safeAdd(a: number, b: number): number | null {
    return a > MONEY_MINOR_MAX - b ? null : a + b;
  }

  private requiredMinimum(startingPriceMinor: number, stepMinor: number, highestMinor: number | undefined): number {
    if (highestMinor === undefined) return startingPriceMinor;
    const minimum = this.safeAdd(highestMinor, stepMinor);
    if (minimum === null) {
      throw new BadRequestException({ message: 'لا يمكن قبول مزايدة جديدة ضمن الحد الأقصى المسموح للمبالغ', code: BidErrorCode.MONEY_RANGE_EXCEEDED });
    }
    return minimum;
  }

  private validateAmountShape(value: unknown): number {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > MONEY_MINOR_MAX) {
      throw new BadRequestException({ message: 'قيمة المزايدة تتجاوز الحد الأقصى المسموح', code: BidErrorCode.MONEY_RANGE_EXCEEDED });
    }
    if (!isMoneyMinorAmount(value, { positive: true })) {
      throw new BadRequestException({ message: 'قيمة المزايدة يجب أن تكون رقماً صحيحاً موجباً بوحدات العملة الصغرى', code: BidErrorCode.AMOUNT_INVALID });
    }
    return value;
  }

  private hasLabel(error: unknown, label: string): boolean {
    return typeof (error as any)?.hasErrorLabel === 'function' && (error as any).hasErrorLabel(label);
  }

  /** Errors that prove the attempt did not commit and a fresh attempt may decide differently. */
  private isRetryable(error: unknown): boolean {
    const e = error as any;
    if (error instanceof BidAttemptConflict) return true;
    if (this.hasLabel(error, 'TransientTransactionError')) return true;
    if (e?.code === 112) return true; // WriteConflict
    if (e?.code === 11000) {
      // Duplicate (auctionId, sequence): a racing acceptance took this position.
      const keys = Object.keys(e.keyPattern ?? {});
      const text = String(e.message ?? '');
      return (keys.includes('auctionId') && keys.includes('sequence')) || text.includes('bid_auction_sequence') || text.includes('bid_request_actor_auction_key') || keys.includes('keyHash');
    }
    return false;
  }

  /** Commit; on UnknownTransactionCommitResult re-issue ONLY the commit (the work is never re-run). */
  private async commit(session: ClientSession): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await session.commitTransaction();
        return;
      } catch (error) {
        if (this.hasLabel(error, 'UnknownTransactionCommitResult') && attempt < COMMIT_MAX_ATTEMPTS) continue;
        throw error;
      }
    }
  }

  private pause(attempt: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.random() * RETRY_JITTER_MS * attempt));
  }

  private async abortQuietly(session: ClientSession): Promise<void> {
    try {
      if (session.inTransaction()) await session.abortTransaction();
    } catch {
      /* the attempt already failed; the original error is what matters */
    }
  }
}
