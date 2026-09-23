import { ConflictException } from '@nestjs/common';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { AuctionStatus } from './auction.types';

/**
 * The single authoritative map of legal `Auction.status` transitions
 * (MAZAD-024). Every place that ever changes an auction's status — the
 * scheduling/closing worker (`AuctionLifecycleService.activateDueAuctions` /
 * `expireDueAuctions`) and cancellation (`AuctionLifecycleService.cancel`) —
 * routes through `assertValidAuctionTransition` rather than setting
 * `status` directly, so there is exactly one place that can ever answer
 * "is X -> Y allowed?". Nothing in this codebase should ever write
 * `Auction.status` outside `AuctionLifecycleService` (creation is the sole
 * exception: it sets the initial SCHEDULED status, which is not a
 * transition).
 *
 * `ENDED_PENDING_CLOSE -> COMPLETED` is declared here as a legal edge, but
 * MAZAD-024 never performs it — winner determination is a later closing
 * worker's job (MAZAD-025+). Declaring it now (rather than leaving it out)
 * means that closing worker only has to call `assertValidAuctionTransition`
 * like everything else; it never has to touch this matrix.
 *
 * CANCELLED, COMPLETED and ENDED_NO_BIDS are terminal: their transition
 * sets are empty, so any attempted move out of them is rejected here.
 */
export const AUCTION_TRANSITIONS: Readonly<Record<AuctionStatus, ReadonlySet<AuctionStatus>>> = Object.freeze({
  [AuctionStatus.SCHEDULED]: new Set([AuctionStatus.ACTIVE, AuctionStatus.CANCELLED]),
  [AuctionStatus.ACTIVE]: new Set([AuctionStatus.ENDED_PENDING_CLOSE, AuctionStatus.ENDED_NO_BIDS, AuctionStatus.CANCELLED]),
  [AuctionStatus.ENDED_PENDING_CLOSE]: new Set([AuctionStatus.COMPLETED]),
  [AuctionStatus.ENDED_NO_BIDS]: new Set<AuctionStatus>(),
  [AuctionStatus.COMPLETED]: new Set<AuctionStatus>(),
  [AuctionStatus.CANCELLED]: new Set<AuctionStatus>(),
});

export function isValidAuctionTransition(from: AuctionStatus, to: AuctionStatus): boolean {
  return AUCTION_TRANSITIONS[from]?.has(to) ?? false;
}

/** Throws a stable, client-visible error for any transition not declared in AUCTION_TRANSITIONS. */
export function assertValidAuctionTransition(from: AuctionStatus, to: AuctionStatus): void {
  if (!isValidAuctionTransition(from, to)) {
    throw new ConflictException({
      message: 'حالة المزاد الحالية لا تسمح بهذا الإجراء',
      code: AuctionErrorCode.TRANSITION_INVALID,
    });
  }
}
