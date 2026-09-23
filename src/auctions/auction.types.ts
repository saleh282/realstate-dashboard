/**
 * Auction lifecycle vocabulary (MAZAD-023 foundation).
 *
 * Only the statuses required to represent the frozen V1 outcomes are
 * defined here; the *transitions* between them (starting a scheduled
 * auction, closing an ended one, cancelling, finalizing a winner) are
 * explicitly deferred to MAZAD-024's scheduling/closing workers. A status
 * is "terminal" once bids can never be accepted again.
 */
export enum AuctionStatus {
  /** Created, waiting for `scheduledStartAt`. Bids are not yet accepted. */
  SCHEDULED = 'scheduled',
  /** Between start and `currentEndAt` (which anti-sniping may keep pushing out). Accepting bids. */
  ACTIVE = 'active',
  /**
   * `currentEndAt` has passed and at least one valid bid exists, but the
   * closing worker (MAZAD-024) has not yet finalized a winner. Kept
   * distinct from ACTIVE (still open) and COMPLETED (winner finalized) so
   * "time is up, awaiting automatic winner determination" is representable.
   */
  ENDED_PENDING_CLOSE = 'ended_pending_close',
  /** `currentEndAt` passed with zero bids. Terminal; no winner. */
  ENDED_NO_BIDS = 'ended_no_bids',
  /** Closing worker finalized the highest valid bid as the winner. Terminal. */
  COMPLETED = 'completed',
  /** Cancelled before completion. Terminal; preserves bid history; no winner; no second-place promotion. */
  CANCELLED = 'cancelled',
}

/** Terminal statuses a lifecycle worker (MAZAD-024+) must never transition out of. */
export const AUCTION_TERMINAL_STATUSES: ReadonlySet<AuctionStatus> = new Set([
  AuctionStatus.ENDED_NO_BIDS,
  AuctionStatus.COMPLETED,
  AuctionStatus.CANCELLED,
]);
