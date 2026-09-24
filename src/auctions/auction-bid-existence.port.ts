import { Injectable } from '@nestjs/common';
import { BidLedgerService } from '../bids/bid-ledger.service';

/**
 * Boundary the auction lifecycle worker uses to decide whether an expired
 * ACTIVE auction ends as ENDED_NO_BIDS or ENDED_PENDING_CLOSE (MAZAD-024).
 *
 * MAZAD-024 introduced this port before the Bid collection existed;
 * MAZAD-026 bound it to the real ledger (`BidLedgerAuctionBidExistencePort`
 * below) without any change to `AuctionLifecycleService`.
 *
 * Mirrors the existing `AccountDeletionBlockerProvider` token pattern
 * (`src/account-deletion/account-deletion.types.ts`): an interface plus a
 * `Symbol` DI token, so the consumer never depends on a concrete provider.
 */
export interface AuctionBidExistencePort {
  /** Whether at least one valid bid has been recorded for this auction. */
  hasValidBids(auctionId: string): Promise<boolean>;
}

export const AUCTION_BID_EXISTENCE_PORT = Symbol('AUCTION_BID_EXISTENCE_PORT');

/**
 * Bid-backed implementation (MAZAD-026): a valid bid exists exactly when the
 * append-only ledger holds at least one row for the auction. Only accepted
 * bids are ever persisted, so no status filtering is needed.
 */
@Injectable()
export class BidLedgerAuctionBidExistencePort implements AuctionBidExistencePort {
  constructor(private readonly ledger: BidLedgerService) {}

  hasValidBids(auctionId: string): Promise<boolean> {
    return this.ledger.hasAcceptedBids(auctionId);
  }
}
