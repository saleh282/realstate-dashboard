import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { toAnonymizedBid } from '../bids/bid-projections';
import { BidLedgerService } from '../bids/bid-ledger.service';
import { computeNextMinimumBidMinor } from '../bids/bid-pricing';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { BidErrorCode } from '../common/errors/bid-error-codes';
import { ClockService } from '../common/time/clock.service';
import { AuctionsQueryService } from './auctions-query.service';
import { Auction, AuctionDocument } from './schemas/auction.schema';

const DEFAULT_HISTORY_LIMIT = 50;
const CONSISTENCY_READ_ATTEMPTS = 3;

/**
 * Read side of bidding (MAZAD-029): authoritative current bid state and the
 * public anonymised bid history. Both go through the SAME visibility gate as
 * `GET /auctions/:id` (`AuctionsQueryService.getPubliclyVisible`), so these
 * endpoints can never reveal an auction the public API hides. Nothing here
 * writes, and nothing is cached: every value is derived from the immutable
 * ledger and the auction's frozen terms at read time.
 */
@Injectable()
export class AuctionBiddingReadService {
  private readonly logger = new Logger(AuctionBiddingReadService.name);

  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<AuctionDocument>,
    private readonly ledger: BidLedgerService,
    private readonly queries: AuctionsQueryService,
    private readonly clock: ClockService,
  ) {}

  /** Public current bid state for a publicly visible auction. */
  async getPublicBidState(auctionId: string) {
    await this.queries.getPubliclyVisible(auctionId);
    return { bidding: await this.readBidState(auctionId), serverTime: this.clock.now() };
  }

  /**
   * Public anonymised history, `sequence` ascending, cursor-paginated.
   * `viewerAccountId` (from the verified token, never the request) only marks
   * that viewer's own rows with `isMine`; guests get `isMine: false` on every
   * row, which reveals nothing. No identity is ever emitted.
   */
  async getPublicBidHistory(auctionId: string, query: { afterSequence?: number; limit?: number } = {}, viewerAccountId?: string) {
    await this.queries.getPubliclyVisible(auctionId);
    const limit = Number.isFinite(query.limit) ? Math.min(Math.max(query.limit!, 1), 100) : DEFAULT_HISTORY_LIMIT;
    const rows = await this.ledger.listForAuction(auctionId, { afterSequence: query.afterSequence, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      items: page.map((bid) => toAnonymizedBid(bid, viewerAccountId)),
      pagination: { limit, hasMore, nextAfterSequence: hasMore ? page[page.length - 1].sequence : null },
      serverTime: this.clock.now(),
    };
  }

  /**
   * Current state derived from the ledger. The auction's `acceptedBidCount`,
   * the ledger's row count and its latest sequence must all agree (they change
   * together, atomically, in MAZAD-027's transaction). Reads are separate
   * queries, so a bid landing between them can look like a mismatch: it is
   * re-read a bounded number of times, and only a STABLE disagreement is
   * reported (BID_LEDGER_INCONSISTENT, logged) instead of returning a wrong price.
   */
  private async readBidState(auctionId: string) {
    for (let attempt = 1; attempt <= CONSISTENCY_READ_ATTEMPTS; attempt++) {
      const auction: any = await this.auctions.findById(auctionId).lean().exec();
      if (!auction) throw new InternalServerErrorException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
      const count = await this.ledger.countForAuction(auctionId);
      const latest = await this.ledger.getLatestForAuction(auctionId);
      const highest = await this.ledger.getHighestForAuction(auctionId);
      const counter: number = auction.acceptedBidCount ?? 0;
      const consistent = counter === count && (count === 0 ? !latest && !highest : latest?.sequence === count && Boolean(highest));
      if (!consistent) {
        if (attempt < CONSISTENCY_READ_ATTEMPTS) continue;
        this.logger.error(JSON.stringify({ event: 'bid_state_inconsistent', auctionId, counter, count, latestSequence: latest?.sequence ?? null }));
        throw new InternalServerErrorException({ message: 'تعذر عرض حالة المزايدة', code: BidErrorCode.LEDGER_INCONSISTENT });
      }
      const fee = auction.entryFee;
      return {
        hasBids: count > 0,
        acceptedBidCount: count,
        /** The highest accepted bid, or null — the starting price is never reported as a bid. */
        currentBidMinor: highest ? (highest.amountMinor as number) : null,
        currency: auction.currency as string,
        startingPriceMinor: auction.startingPriceMinor as number,
        minimumBidStepMinor: auction.minimumBidStepMinor as number,
        /** Smallest valid next bid, or null when the platform money ceiling makes another bid unrepresentable. */
        nextMinimumBidMinor: computeNextMinimumBidMinor(auction.startingPriceMinor, auction.minimumBidStepMinor, highest?.amountMinor),
        status: auction.status,
        currentEndAt: auction.currentEndAt as Date,
        /**
         * Whether a bidder must pay an entry fee (and how much). Safe, server-owned; no provider detail.
         * MAZAD-035: `required` means "a payment is required"; an explicit 0 fee is a configured FREE auction
         * (`required: false, configured: true, free: true`), never confused with a missing fee (`configured: false`).
         */
        entryFee: fee
          ? (fee.amountMinor === 0
            ? { required: false, configured: true, free: true, amountMinor: 0, currency: fee.currency as string }
            : { required: true, configured: true, free: false, amountMinor: fee.amountMinor as number, currency: fee.currency as string })
          : { required: false, configured: false, free: false },
      };
    }
    /* unreachable: the loop returns or throws */
    throw new InternalServerErrorException({ message: 'تعذر عرض حالة المزايدة', code: BidErrorCode.LEDGER_INCONSISTENT });
  }
}

