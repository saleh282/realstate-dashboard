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
  // --- MAZAD-035 review workflow (AuctionRequest) ---
  /** Direct seller creation of a SCHEDULED auction is retired: submit an AuctionRequest for Admin review instead. */
  REVIEW_REQUIRED = 'AUCTION_REVIEW_REQUIRED',
  REQUEST_NOT_FOUND = 'AUCTION_REQUEST_NOT_FOUND',
  REQUEST_ID_INVALID = 'AUCTION_REQUEST_ID_INVALID',
  /** The caller's expectedRevision is stale: the request changed (edit, review, withdrawal) since it was read. */
  REQUEST_VERSION_CONFLICT = 'AUCTION_REQUEST_VERSION_CONFLICT',
  /** The request's current status does not allow the requested action. */
  REQUEST_TRANSITION_INVALID = 'AUCTION_REQUEST_TRANSITION_INVALID',
  /** The property already has an open (pending review or rejected) auction request. */
  REQUEST_ALREADY_OPEN = 'AUCTION_REQUEST_ALREADY_OPEN',
  /** The property already has a scheduled or active auction. */
  PROPERTY_BUSY = 'AUCTION_PROPERTY_BUSY',
  /** V1 auctions are for SALE listings only. */
  PROPERTY_NOT_SALE = 'AUCTION_PROPERTY_NOT_SALE',
  /** The property has a revision pending moderation; the auctioned revision would be ambiguous. */
  PROPERTY_REVISION_PENDING = 'AUCTION_PROPERTY_REVISION_PENDING',
  /** The property's public revision changed since the request was submitted; the seller must resubmit against the current listing. */
  PROPERTY_CHANGED = 'AUCTION_PROPERTY_CHANGED',
  /** The seller's account is no longer allowed to run auctions (suspended, unapproved broker, ...). */
  SELLER_NOT_ELIGIBLE = 'AUCTION_SELLER_NOT_ELIGIBLE',
  /** The proposed start time is not in the future (at submission or at approval). Never shifted automatically. */
  SCHEDULE_EXPIRED = 'AUCTION_SCHEDULE_EXPIRED',
  DURATION_TOO_SHORT = 'AUCTION_DURATION_TOO_SHORT',
  DURATION_TOO_LONG = 'AUCTION_DURATION_TOO_LONG',
  /** A structured review/cancellation reason code is required. */
  REASON_CODE_REQUIRED = 'AUCTION_REASON_CODE_REQUIRED',
  /** reasonCode OTHER requires an explanatory note. */
  NOTE_REQUIRED = 'AUCTION_NOTE_REQUIRED',
  /** The approved auction has already started (or its start time has arrived); its terms can no longer change. */
  ALREADY_STARTED = 'AUCTION_ALREADY_STARTED',
  /** An approved, not-yet-started auction cannot be revised because entry payments/entitlements exist for it. */
  REVISION_BLOCKED_BY_PAYMENTS = 'AUCTION_REVISION_BLOCKED_BY_PAYMENTS',
}
