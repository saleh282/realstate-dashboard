import { MONEY_MINOR_MAX } from '../common/money/money';

/**
 * Read-side price derivation (MAZAD-029), computed only from accepted ledger
 * bids and the auction's frozen terms — never from a cached or client value.
 * No bids: the next minimum is the starting price (which is NOT a bid).
 * With bids: highest + step, or null when that would exceed the platform
 * money ceiling (no further bid is representable). The authoritative
 * acceptance check remains MAZAD-027's own computation.
 */
export function computeNextMinimumBidMinor(startingPriceMinor: number, stepMinor: number, highestMinor: number | undefined): number | null {
  if (highestMinor === undefined) return startingPriceMinor;
  return highestMinor > MONEY_MINOR_MAX - stepMinor ? null : highestMinor + stepMinor;
}
