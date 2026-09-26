import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { BidLedgerService } from '../bids/bid-ledger.service';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { BidErrorCode } from '../common/errors/bid-error-codes';
import { isMoneyMinorAmount } from '../common/money/money';
import { TransactionAttemptConflict, retryConflict, runTransactionWithRetry } from '../common/mongo/transaction-runner';
import { ClockService } from '../common/time/clock.service';
import { auctionFinalizedEvent } from '../outbox/outbox-events';
import { OutboxService } from '../outbox/outbox.service';
import { assertValidAuctionTransition } from './auction-transitions';
import { AuctionStatus } from './auction.types';
import { Auction, AuctionDocument } from './schemas/auction.schema';

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 200;
/** How long a worker leaves an auction that failed finalization alone (scheduling optimisation only — never correctness). */
const FAILURE_BACKOFF_MS = 5 * 60_000;
const MAX_TRACKED_FAILURES = 1_000;

export type AuctionFinalizationResult = {
  auctionId: string;
  outcome: 'FINALIZED' | 'ALREADY_FINALIZED';
  winningBidSequence: number;
  winningBidAmountMinor: number;
  currency: string;
  finalizedAt: Date;
};

export type AuctionFinalizationRunSummary = { finalized: number; alreadyFinalized: number; failed: number; skippedInBackoff: number };

/**
 * MAZAD-030 — the authoritative close: `ENDED_PENDING_CLOSE → COMPLETED` with
 * an immutable winner determined ONLY from the accepted Bid ledger.
 *
 * Internal service. There is deliberately no controller and the only input is
 * an auction id: no caller — seller, Admin, worker — can name, choose or
 * override a winner. Lifecycle expiry (`AuctionLifecycleService`) stays
 * responsible for `ACTIVE → ENDED_*`; this service never closes an ACTIVE
 * auction (the state machine rejects `ACTIVE → COMPLETED`) and never decides
 * that "time is probably up".
 *
 * One Mongo transaction per attempt:
 *  1. read the Auction; already COMPLETED with a winner → return it (no write,
 *     no audit: repeated close converges); any other non-ENDED_PENDING_CLOSE
 *     status → `assertValidAuctionTransition` rejects it (ACTIVE, CANCELLED,
 *     ENDED_NO_BIDS, SCHEDULED);
 *  2. reconcile the ledger (see `assertLedgerTrustworthy`): fail CLOSED on any
 *     disagreement, leaving the auction ENDED_PENDING_CLOSE for investigation;
 *  3. winner = highest `amountMinor`, ties → earliest `sequence`
 *     (`BidLedgerService.getHighestForAuction`);
 *  4. ONE conditional write `{_id, status: ENDED_PENDING_CLOSE, winningBidId
 *     absent, acceptedBidCount: <verified>}` → COMPLETED + winner fields,
 *     `completedAt` from the server clock;
 *  5. the `AUCTION_FINALIZED` audit event and (MAZAD-031) the `AUCTION_FINALIZED`
 *     outbox event in the same transaction; commit.
 *
 * Why two finalizers cannot both win: both write the Auction document, so
 * MongoDB conflicts one of them (retried by `runTransactionWithRetry`); on
 * retry it reads COMPLETED and returns the first result. A stale finalizer's
 * conditional write cannot match a COMPLETED document, so it can never
 * overwrite a winner. Once ENDED_PENDING_CLOSE no bid can be accepted (bid
 * acceptance's compare-and-swap requires ACTIVE), so the ledger read is
 * stable for the whole transaction.
 *
 * COMPLETED means the bidding lifecycle is finalized and the winning bid
 * determined — NOT that payment or ownership transfer happened. There is no
 * second-place promotion, no re-opening and no penalty logic here.
 */
@Injectable()
export class AuctionFinalizationService {
  private readonly logger = new Logger(AuctionFinalizationService.name);
  /** auctionId -> earliest next attempt. Process-local scheduling hint only; correctness never depends on it. */
  private readonly backoff = new Map<string, number>();

  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<AuctionDocument>,
    private readonly ledger: BidLedgerService,
    private readonly audit: AuditLogService,
    private readonly clock: ClockService,
    @InjectConnection() private readonly connection: Connection,
    private readonly outbox: OutboxService,
  ) {}

  async finalize(auctionId: string): Promise<AuctionFinalizationResult> {
    if (!Types.ObjectId.isValid(auctionId)) {
      throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    }
    return runTransactionWithRetry(this.connection, (session) => this.finalizeWithinTransaction(session, auctionId), {
      retryExhausted: retryConflict('إنهاء المزاد قيد المعالجة؛ أعد المحاولة', AuctionErrorCode.STATE_CONFLICT),
    });
  }

  /**
   * Finalizes up to `limit` ENDED_PENDING_CLOSE auctions, oldest end first
   * (`currentEndAt`, then `_id`), one independent transaction each, so one
   * failing auction never blocks the rest. Safe to run from any number of
   * overlapping workers: the per-auction transaction is the arbiter.
   */
  async finalizeDueAuctions(limit = DEFAULT_BATCH_SIZE): Promise<AuctionFinalizationRunSummary> {
    const batchSize = Math.min(Math.max(Math.trunc(limit) || DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE);
    const now = this.clock.now().getTime();
    for (const [id, until] of this.backoff) if (until <= now) this.backoff.delete(id);
    const cooling = [...this.backoff.keys()].map((id) => new Types.ObjectId(id));

    const filter: Record<string, unknown> = { status: AuctionStatus.ENDED_PENDING_CLOSE };
    if (cooling.length) filter._id = { $nin: cooling };
    const candidates = await this.auctions.find(filter).sort({ currentEndAt: 1, _id: 1 }).limit(batchSize).select('_id').lean().exec();

    const summary: AuctionFinalizationRunSummary = { finalized: 0, alreadyFinalized: 0, failed: 0, skippedInBackoff: cooling.length };
    for (const candidate of candidates) {
      const id = (candidate._id as Types.ObjectId).toString();
      try {
        const result = await this.finalize(id);
        if (result.outcome === 'FINALIZED') summary.finalized += 1;
        else summary.alreadyFinalized += 1;
      } catch (error) {
        summary.failed += 1;
        if (this.backoff.size < MAX_TRACKED_FAILURES) this.backoff.set(id, now + FAILURE_BACKOFF_MS);
        // No PII: ids and error identity only.
        this.logger.error(JSON.stringify({
          event: 'auction_finalization_failed',
          auctionId: id,
          code: (error as any)?.getResponse?.()?.code ?? (error as Error)?.name,
        }));
      }
    }
    return summary;
  }

  private async finalizeWithinTransaction(session: ClientSession, auctionId: string): Promise<AuctionFinalizationResult> {
    const now = this.clock.now();
    const auction: any = await this.auctions.findById(auctionId).session(session).lean().exec();
    if (!auction) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });

    if (auction.status === AuctionStatus.COMPLETED) {
      // Idempotent replay: return the persisted result; write and audit nothing.
      if (!auction.winningBidId || !isMoneyMinorAmount(auction.winningBidAmountMinor, { positive: true }) || !auction.completedAt) {
        throw this.inconsistent('completed auction has no winner');
      }
      return this.toResult(auctionId, 'ALREADY_FINALIZED', auction);
    }
    // ACTIVE / SCHEDULED / CANCELLED / ENDED_NO_BIDS are all rejected by the single transition matrix.
    assertValidAuctionTransition(auction.status, AuctionStatus.COMPLETED);

    const winner = await this.determineWinner(session, auctionId, auction);
    const winnerAccountId = winner.bidderAccountId.toString();
    const losingBidderAccountIds = (await this.ledger.distinctBidderAccountIdsForAuction(auctionId, { session }))
      .filter((accountId) => accountId !== winnerAccountId);

    const won = await this.auctions
      .findOneAndUpdate(
        { _id: auction._id, status: AuctionStatus.ENDED_PENDING_CLOSE, winningBidId: { $exists: false }, acceptedBidCount: auction.acceptedBidCount ?? 0 },
        {
          $set: {
            status: AuctionStatus.COMPLETED,
            completedAt: now,
            winnerAccountId: winner.bidderAccountId,
            winnerAccountTypeSnapshot: winner.bidderAccountTypeSnapshot,
            winningBidId: winner._id,
            winningBidSequence: winner.sequence,
            winningBidAmountMinor: winner.amountMinor,
            winningBidAcceptedAt: winner.acceptedAt,
          },
        },
        { new: true, session },
      )
      .lean()
      .exec();
    if (!won) throw new TransactionAttemptConflict('auction changed since it was read'); // a fresh attempt re-reads (likely COMPLETED)

    await this.audit.logSystemRequired(
      {
        action: AuditAction.AUCTION_FINALIZED,
        targetResourceId: auctionId,
        reason: 'auction finalized: winner determined from accepted bids',
        // Identifiers and amounts only — no bidder or profile data.
        metadata: { winningBidId: winner._id.toString(), winningBidSequence: winner.sequence, winningBidAmountMinor: winner.amountMinor, currency: winner.currency, acceptedBidCount: auction.acceptedBidCount ?? 0, finalizedAt: now },
      },
      session,
    );
    // MAZAD-031: the AUCTION_FINALIZED domain event commits with the winner write and its audit row. It sits on
    // the FINALIZED path only: the ALREADY_FINALIZED replay above returned before any write, so repeated or
    // concurrent finalization can never emit a second one, and a failed consistency check (thrown before the
    // CAS) leaves none. The winner's account id is private routing, not payload.
    await this.outbox.recordRequired(
      auctionFinalizedEvent({
        auctionId: auction._id.toString(),
        occurredAt: now,
        winningBidSequence: winner.sequence,
        winningBidAmountMinor: winner.amountMinor,
        currency: winner.currency,
        acceptedBidCount: auction.acceptedBidCount ?? 0,
        winnerAccountId,
        losingBidderAccountIds,
      }),
      session,
    );
    return this.toResult(auctionId, 'FINALIZED', won);
  }

  /**
   * Reconciles the facts the winner depends on. The auction is no longer
   * ACTIVE, so nothing can change them mid-transaction; any disagreement is a
   * real inconsistency: fail closed (500 BID_LEDGER_INCONSISTENT, transaction
   * aborted, auction stays ENDED_PENDING_CLOSE) — never guess, never convert to
   * ENDED_NO_BIDS.
   */
  private async determineWinner(session: ClientSession, auctionId: string, auction: any) {
    const counter: number = auction.acceptedBidCount ?? 0;
    const count = await this.ledger.countForAuction(auctionId, { session });
    const latest = await this.ledger.getLatestForAuction(auctionId, { session });
    const winner: any = await this.ledger.getHighestForAuction(auctionId, { session });

    if (count === 0 || !winner || !latest) throw this.inconsistent('no accepted bids for an ENDED_PENDING_CLOSE auction');
    if (counter !== count) throw this.inconsistent('acceptedBidCount disagrees with the ledger');
    // Sequences are unique and 1-based, so latest === count proves they are exactly 1..count (dense).
    if (latest.sequence !== count) throw this.inconsistent('ledger sequences are not dense');
    if (String(winner.auctionId) !== auctionId) throw this.inconsistent('winning bid belongs to another auction');
    if (winner.currency !== auction.currency) throw this.inconsistent('winning bid currency disagrees with the auction');
    if (!isMoneyMinorAmount(winner.amountMinor, { positive: true }) || winner.amountMinor < auction.startingPriceMinor) {
      throw this.inconsistent('winning bid amount is invalid');
    }
    return winner;
  }

  private inconsistent(reason: string) {
    this.logger.error(JSON.stringify({ event: 'auction_finalization_inconsistent', reason }));
    return new InternalServerErrorException({ message: 'تعذر إنهاء المزاد', code: BidErrorCode.LEDGER_INCONSISTENT });
  }

  private toResult(auctionId: string, outcome: AuctionFinalizationResult['outcome'], doc: any): AuctionFinalizationResult {
    return {
      auctionId,
      outcome,
      winningBidSequence: doc.winningBidSequence,
      winningBidAmountMinor: doc.winningBidAmountMinor,
      currency: doc.currency,
      finalizedAt: doc.completedAt,
    };
  }
}
