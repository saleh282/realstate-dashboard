export enum AuctionErrorCode {
  ACTOR_INVALID = 'AUCTION_ACTOR_INVALID',
  PROPERTY_INVALID = 'AUCTION_PROPERTY_INVALID',
  PROPERTY_NOT_ELIGIBLE = 'AUCTION_PROPERTY_NOT_ELIGIBLE',
  STARTING_PRICE_INVALID = 'AUCTION_STARTING_PRICE_INVALID',
  MINIMUM_BID_STEP_INVALID = 'AUCTION_MINIMUM_BID_STEP_INVALID',
  SCHEDULE_INVALID = 'AUCTION_SCHEDULE_INVALID',
  // --- MAZAD-024 lifecycle ---
  NOT_FOUND = 'AUCTION_NOT_FOUND',
  /** A requested status change is not a legal edge in AUCTION_TRANSITIONS (see auction-transitions.ts). */
  TRANSITION_INVALID = 'AUCTION_TRANSITION_INVALID',
  /** The auction's status changed between validation and the atomic write (a genuine race an actor-facing call must surface, unlike a worker's silent no-op). */
  STATE_CONFLICT = 'AUCTION_STATE_CONFLICT',
  CANCELLATION_REASON_REQUIRED = 'AUCTION_CANCELLATION_REASON_REQUIRED',
  // --- MAZAD-025 HTTP contract ---
  ID_INVALID = 'AUCTION_ID_INVALID',
  /** Malformed/unknown query string filter or pagination value. */
  QUERY_INVALID = 'AUCTION_QUERY_INVALID',
  /** Malformed request body (unknown/missing/invalid field). */
  REQUEST_INVALID = 'AUCTION_REQUEST_INVALID',
  /** The auction exists but is not (or no longer) publicly discoverable: wrong status, or its property is no longer public. */
  PUBLIC_UNAVAILABLE = 'AUCTION_PUBLIC_UNAVAILABLE',
}
