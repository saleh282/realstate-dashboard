import { ForbiddenException, Injectable } from '@nestjs/common';
import { ClientSession } from 'mongoose';
import { BidErrorCode } from '../common/errors/bid-error-codes';

/**
 * Server-side seam for "this bidder has a server-confirmed entry entitlement
 * for this auction" (MAZAD-028 supplies the real rule).
 *
 * Bid acceptance calls `assertEntitled` inside its transaction, after the
 * bidder/auction checks and before anything is written, passing the same
 * `session` so an entitlement lookup reads a consistent snapshot. MAZAD-028
 * plugs in by rebinding `AUCTION_BID_ENTITLEMENT_PORT` in `AuctionsModule` to
 * an implementation that looks up its own server-confirmed payment record
 * (and throws `BID_ENTITLEMENT_REQUIRED` when there is none); the acceptance
 * algorithm itself does not change.
 *
 * Mirrors the `AUCTION_BID_EXISTENCE_PORT` token pattern.
 */
export interface AuctionBidEntitlementPort {
  /** `entryFee` is the auction's configured fee as read in the acceptance transaction (MAZAD-035: 0 = FREE). */
  assertEntitled(context: { auctionId: string; bidderAccountId: string; session: ClientSession; entryFee?: { amountMinor?: unknown; currency?: unknown } | null }): Promise<void>;
}

export const AUCTION_BID_ENTITLEMENT_PORT = Symbol('AUCTION_BID_ENTITLEMENT_PORT');

/**
 * Default until MAZAD-028: FAIL CLOSED. No payment/entitlement source exists,
 * so nobody is entitled and no bid can be accepted in a running application.
 * This deliberately does not pretend payment was verified — there is no
 * "paid" flag, no client-controlled bypass, and no HTTP bid route either.
 * Tests exercise acceptance by injecting an explicit test port.
 */
@Injectable()
export class FailClosedBidEntitlementPort implements AuctionBidEntitlementPort {
  async assertEntitled(): Promise<void> {
    throw new ForbiddenException({
      message: 'لا يوجد اشتراك مؤكد للمشاركة في هذا المزاد',
      code: BidErrorCode.ENTITLEMENT_REQUIRED,
    });
  }
}
