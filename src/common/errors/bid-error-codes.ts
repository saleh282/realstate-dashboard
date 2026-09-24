export enum BidErrorCode {
  /** An application path attempted to edit or delete an accepted bid. Bids are an append-only ledger. */
  LEDGER_IMMUTABLE = 'BID_LEDGER_IMMUTABLE',
}
