/**
 * Auction lifecycle vocabulary (MAZAD-023 foundation).
 *
 * Only the statuses required to represent the frozen V1 outcomes are
 * defined here. The *transitions* between them (starting a scheduled
 * auction, expiring an ended one, cancelling) are implemented by
 * `AuctionLifecycleService` against the matrix in `auction-transitions.ts`
 * (MAZAD-024); finalizing a winner (ENDED_PENDING_CLOSE -> COMPLETED) is
 * still deferred to a later closing worker (MAZAD-025+). A status is
 * "terminal" once bids can never be accepted again.
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

/**
 * Statuses intended for public discovery (MAZAD-025). Cancelled auctions,
 * ended-with-no-bids auctions and (later) completed ones are deliberately
 * not browsable; whether a finished auction should stay visible as a
 * "sold" listing is a later product decision, not one this task invents.
 * ENDED_PENDING_CLOSE stays visible so a client following an auction that
 * just ended sees "closing" rather than a sudden 404.
 */
export const PUBLIC_AUCTION_STATUSES: readonly AuctionStatus[] = [
  AuctionStatus.SCHEDULED,
  AuctionStatus.ACTIVE,
  AuctionStatus.ENDED_PENDING_CLOSE,
];

/**
 * Statuses whose OUTCOME may be read directly by id (`GET /auctions/:id/outcome`,
 * realtime hardening): the public ones plus the terminal ones. This is DIRECT
 * RESYNC visibility, never DISCOVERY visibility — the public list, its status
 * filter, `GET /auctions/:id`, `/bid-state`, `/bids` and realtime subscription keep
 * using `PUBLIC_AUCTION_STATUSES`. It exists so a client that missed a terminal
 * realtime event can still learn the authoritative end of the auction's public life.
 */
export const OUTCOME_READABLE_AUCTION_STATUSES: readonly AuctionStatus[] = [
  ...PUBLIC_AUCTION_STATUSES,
  AuctionStatus.ENDED_NO_BIDS,
  AuctionStatus.COMPLETED,
  AuctionStatus.CANCELLED,
];

/** What `GET /auctions` shows when no `status` filter is given: auctions still open to browsing or bidding. */
export const DEFAULT_PUBLIC_LIST_STATUSES: readonly AuctionStatus[] = [AuctionStatus.SCHEDULED, AuctionStatus.ACTIVE];
