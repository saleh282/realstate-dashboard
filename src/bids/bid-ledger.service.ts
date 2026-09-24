import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { Bid, BidDocument } from './schemas/bid.schema';

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 500;

type ReadOptions = { session?: ClientSession };

/**
 * Read-side primitives over the append-only bid ledger (MAZAD-026).
 *
 * There is intentionally NO write method here — no append, edit, withdraw or
 * delete. The only writer will be the MAZAD-027 acceptance transaction, which
 * validates every business rule first and then inserts a `Bid` itself using
 * the same `session` it passes to these reads. Keeping the ledger service
 * read-only means no normal application path can alter history.
 *
 * All methods take an optional `session` so MAZAD-027 can run them inside its
 * transaction and read its own writes/snapshot.
 *
 * Returned documents are internal (they carry `bidderAccountId`); use
 * `toAnonymizedBid` before anything leaves the service layer.
 */
@Injectable()
export class BidLedgerService {
  constructor(@InjectModel(Bid.name) private readonly bids: Model<BidDocument>) {}

  /** Whether at least one accepted bid exists for the auction. Malformed ids never query and report false. */
  async hasAcceptedBids(auctionId: string, options: ReadOptions = {}): Promise<boolean> {
    if (!Types.ObjectId.isValid(auctionId)) return false;
    const found = await this.bids.exists({ auctionId: new Types.ObjectId(auctionId) }).session(options.session ?? null).exec();
    return Boolean(found);
  }

  async countForAuction(auctionId: string, options: ReadOptions = {}): Promise<number> {
    if (!Types.ObjectId.isValid(auctionId)) return 0;
    return this.bids.countDocuments({ auctionId: new Types.ObjectId(auctionId) }).session(options.session ?? null).exec();
  }

  /**
   * The auction's bids in ledger order (`sequence` ascending), bounded.
   * `afterSequence` gives stable cursor pagination that stays correct while
   * new bids are appended.
   */
  async listForAuction(auctionId: string, options: ReadOptions & { afterSequence?: number; limit?: number } = {}) {
    if (!Types.ObjectId.isValid(auctionId)) return [];
    const limit = Number.isFinite(options.limit) ? Math.min(Math.max(options.limit!, 1), MAX_HISTORY_LIMIT) : DEFAULT_HISTORY_LIMIT;
    const filter: Record<string, unknown> = { auctionId: new Types.ObjectId(auctionId) };
    if (options.afterSequence !== undefined) filter.sequence = { $gt: options.afterSequence };
    return this.bids.find(filter).sort({ sequence: 1 }).limit(limit).session(options.session ?? null).lean().exec();
  }

  /** The most recently accepted bid (highest sequence), or null. */
  async getLatestForAuction(auctionId: string, options: ReadOptions = {}) {
    if (!Types.ObjectId.isValid(auctionId)) return null;
    return this.bids
      .findOne({ auctionId: new Types.ObjectId(auctionId) })
      .sort({ sequence: -1 })
      .session(options.session ?? null)
      .lean()
      .exec();
  }

  /**
   * The highest-amount bid, or null. Ties (impossible once MAZAD-027 enforces
   * "at least highest + step", but defined anyway) resolve to the earliest
   * sequence, i.e. the bidder who reached the amount first.
   */
  async getHighestForAuction(auctionId: string, options: ReadOptions = {}) {
    if (!Types.ObjectId.isValid(auctionId)) return null;
    return this.bids
      .findOne({ auctionId: new Types.ObjectId(auctionId) })
      .sort({ amountMinor: -1, sequence: 1 })
      .session(options.session ?? null)
      .lean()
      .exec();
  }

  /**
   * The next free ledger position: latest sequence + 1, or 1 for an empty
   * auction. Only race-safe when called inside the acceptance transaction
   * AFTER that transaction has written to the Auction document (its
   * compare-and-swap on status/`currentEndAt`), because two concurrent
   * transactions then conflict on the auction and one retries. The unique
   * `(auctionId, sequence)` index is the backstop: even if that were ever
   * missed, two bids can never share a position.
   */
  async nextSequenceFor(auctionId: string, options: ReadOptions = {}): Promise<number> {
    const latest = await this.getLatestForAuction(auctionId, options);
    return latest ? latest.sequence + 1 : 1;
  }

  /** A bidder's own bids across auctions, newest first — internal; bounded pagination. */
  async listForBidder(bidderAccountId: string, options: { page?: number; limit?: number } = {}) {
    if (!Types.ObjectId.isValid(bidderAccountId)) return [];
    const page = Number.isFinite(options.page) ? Math.max(options.page!, 1) : 1;
    const limit = Number.isFinite(options.limit) ? Math.min(Math.max(options.limit!, 1), 50) : 20;
    return this.bids
      .find({ bidderAccountId: new Types.ObjectId(bidderAccountId) })
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean()
      .exec();
  }
}
