export enum BidErrorCode {
  /** An application path attempted to edit or delete an accepted bid. Bids are an append-only ledger. */
  LEDGER_IMMUTABLE = 'BID_LEDGER_IMMUTABLE',
  // --- MAZAD-027 acceptance ---
  /** The auction is not ACTIVE (scheduled, ended, cancelled, completed...). */
  AUCTION_NOT_ACTIVE = 'BID_AUCTION_NOT_ACTIVE',
  /** The authoritative server time is at or past the auction's currentEndAt. */
  AUCTION_ENDED = 'BID_AUCTION_ENDED',
  /** amountMinor is missing, non-numeric, non-integer, zero or negative. */
  AMOUNT_INVALID = 'BID_AMOUNT_INVALID',
  /** amountMinor, or the computed minimum, is outside the platform money ceiling. */
  MONEY_RANGE_EXCEEDED = 'BID_MONEY_RANGE_EXCEEDED',
  /** amountMinor is below the server-computed minimum (starting price, or highest + step). */
  BELOW_MINIMUM = 'BID_BELOW_MINIMUM',
  /** No server-confirmed entry entitlement exists for this bidder and auction (MAZAD-028 supplies it). */
  ENTITLEMENT_REQUIRED = 'BID_ENTITLEMENT_REQUIRED',
  /** Concurrent bidding kept invalidating the attempt; the caller may safely retry. */
  RETRY_EXHAUSTED = 'BID_RETRY_EXHAUSTED',
  /** The ledger and the auction's counter disagree; never expected, never retried. */
  LEDGER_INCONSISTENT = 'BID_LEDGER_INCONSISTENT',
}
