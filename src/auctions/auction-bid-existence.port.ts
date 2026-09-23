/**
 * Boundary the auction lifecycle worker uses to decide whether an expired
 * ACTIVE auction ends as ENDED_NO_BIDS or ENDED_PENDING_CLOSE (MAZAD-024).
 *
 * The Bid collection does not exist yet — it is MAZAD-026. This port exists
 * so the closing decision can be built, wired and tested today without
 * inventing that schema or faking bid data. MAZAD-026 supplies the real
 * implementation (querying its own Bid collection for at least one valid
 * bid on the auction) and rebinds the `AUCTION_BID_EXISTENCE_PORT` token in
 * `AuctionsModule` — nothing in `AuctionLifecycleService` has to change.
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
 * Safe default until MAZAD-026 exists: no bid-acceptance path exists
 * anywhere in this codebase yet, so every auction that reaches its end
 * today genuinely has zero bids. Returning `false` unconditionally is
 * therefore not a guess or a stub of a future rule — it is the correct
 * answer for every auction MAZAD-024 can actually observe. The moment
 * MAZAD-026 lands and rebinds the token, expired auctions with real bids
 * correctly start landing in ENDED_PENDING_CLOSE instead.
 */
export class NoBidsYetAuctionBidExistencePort implements AuctionBidExistencePort {
  async hasValidBids(_auctionId: string): Promise<boolean> {
    return false;
  }
}
