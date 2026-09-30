import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { AuctionBidEntitlementPort } from '../auctions/auction-bid-entitlement.port';
import { BidErrorCode } from '../common/errors/bid-error-codes';
import { EGP_CURRENCY } from '../common/money/money';
import { AuctionBidEntitlement, AuctionBidEntitlementDocument } from './schemas/auction-bid-entitlement.schema';

/**
 * MAZAD-028's real `AUCTION_BID_ENTITLEMENT_PORT`: a persisted, server-
 * confirmed entitlement for exactly `(auctionId, bidderAccountId)`, read with
 * MAZAD-027's transaction session. Absent → `BID_ENTITLEMENT_REQUIRED`.
 * Any lookup error propagates (never treated as "entitled").
 */
@Injectable()
export class PersistentBidEntitlementPort implements AuctionBidEntitlementPort {
  constructor(@InjectModel(AuctionBidEntitlement.name) private readonly entitlements: Model<AuctionBidEntitlementDocument>) {}

  async assertEntitled(context: { auctionId: string; bidderAccountId: string; session: ClientSession; entryFee?: { amountMinor?: unknown; currency?: unknown } | null }): Promise<void> {
    const { auctionId, bidderAccountId, session } = context;
    // MAZAD-035: an EXPLICITLY configured 0 fee (FREE auction) needs no payment entitlement. An absent fee is NOT
    // free and falls through to the entitlement lookup, which fails closed. Every other bidding rule (ACTIVE, time,
    // capability, self-bid, amount) is enforced by the acceptance transaction before this port is called.
    if (isFreeEntryFee(context.entryFee)) return;
    const found = Types.ObjectId.isValid(auctionId) && Types.ObjectId.isValid(bidderAccountId)
      ? await this.entitlements
          .exists({ auctionId: new Types.ObjectId(auctionId), bidderAccountId: new Types.ObjectId(bidderAccountId) })
          .session(session)
          .exec()
      : null;
    if (!found) {
      throw new ForbiddenException({ message: 'لا يوجد اشتراك مؤكد للمشاركة في هذا المزاد', code: BidErrorCode.ENTITLEMENT_REQUIRED });
    }
  }
}

/** True only for a configured fee whose amount is exactly 0 EGP (never for a missing or malformed fee). */
export function isFreeEntryFee(fee: { amountMinor?: unknown; currency?: unknown } | null | undefined): boolean {
  return Boolean(fee) && fee!.amountMinor === 0 && fee!.currency === EGP_CURRENCY;
}
