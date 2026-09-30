import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { BidLedgerService } from '../bids/bid-ledger.service';
import { EntryPaymentStatus } from '../payments/payment.types';
import { AuctionBidEntitlement, AuctionBidEntitlementDocument } from '../payments/schemas/auction-bid-entitlement.schema';
import { AuctionEntryPayment, AuctionEntryPaymentDocument } from '../payments/schemas/auction-entry-payment.schema';

export type AuctionFinancialActivity = {
  /** INITIATED or SUCCEEDED attempts: money may be in flight or already taken. */
  livePayments: number;
  /** Attempts parked for operator reconciliation. */
  flaggedPayments: number;
  entitlements: number;
};

/**
 * MAZAD-035 read side over an auction's participants and money state, shared
 * by cancellation (who must be notified), the seller's pre-start revision
 * (fail closed when any financial obligation exists) and the Admin
 * projection. Read-only: it never changes a payment or entitlement.
 */
@Injectable()
export class AuctionParticipantsReader {
  constructor(
    @InjectModel(AuctionEntryPayment.name) private readonly payments: Model<AuctionEntryPaymentDocument>,
    @InjectModel(AuctionBidEntitlement.name) private readonly entitlements: Model<AuctionBidEntitlementDocument>,
    private readonly ledger: BidLedgerService,
  ) {}

  /** Bidders to tell about a cancellation: entitled, server-confirmed payers, and anyone with an accepted bid (free auctions). */
  async forCancellation(auctionId: string, session?: ClientSession): Promise<string[]> {
    const id = new Types.ObjectId(auctionId);
    const entitled = await this.entitlements.distinct('bidderAccountId', { auctionId: id }).session(session ?? null).exec();
    const paid = await this.payments.distinct('bidderAccountId', { auctionId: id, status: EntryPaymentStatus.SUCCEEDED }).session(session ?? null).exec();
    const bidders = await this.ledger.distinctBidderAccountIdsForAuction(auctionId, { session });
    return [...new Set([...entitled, ...paid].map((value) => value.toString()).concat(bidders))].sort();
  }

  async financialActivity(auctionId: string, session?: ClientSession): Promise<AuctionFinancialActivity> {
    const id = new Types.ObjectId(auctionId);
    const livePayments = await this.payments.countDocuments({ auctionId: id, status: { $in: [EntryPaymentStatus.INITIATED, EntryPaymentStatus.SUCCEEDED] } }).session(session ?? null).exec();
    const flaggedPayments = await this.payments.countDocuments({ auctionId: id, reconciliationFlag: { $exists: true } }).session(session ?? null).exec();
    const entitlements = await this.entitlements.countDocuments({ auctionId: id }).session(session ?? null).exec();
    return { livePayments, flaggedPayments, entitlements };
  }

  /** Admin operational summary (counts only; no provider references or payloads). */
  async adminSummary(auctionId: string) {
    const id = new Types.ObjectId(auctionId);
    const [byStatus, flagged, entitlements] = await Promise.all([
      this.payments.aggregate([
        { $match: { auctionId: id } },
        { $group: { _id: '$status', count: { $sum: 1 }, amountMinor: { $sum: '$amountMinor' } } },
      ]).exec(),
      this.payments.countDocuments({ auctionId: id, reconciliationFlag: { $exists: true } }).exec(),
      this.entitlements.countDocuments({ auctionId: id }).exec(),
    ]);
    const counts = Object.fromEntries(Object.values(EntryPaymentStatus).map((status) => [status, 0])) as Record<EntryPaymentStatus, number>;
    let succeededAmountMinor = 0;
    for (const row of byStatus as Array<{ _id: EntryPaymentStatus; count: number; amountMinor: number }>) {
      counts[row._id] = row.count;
      if (row._id === EntryPaymentStatus.SUCCEEDED) succeededAmountMinor = row.amountMinor;
    }
    return {
      payments: { total: Object.values(counts).reduce((sum, value) => sum + value, 0), byStatus: counts, reconciliationRequired: flagged, succeededAmountMinor },
      entitlements: { total: entitlements },
    };
  }
}
