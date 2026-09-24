/**
 * Privacy-preserving view of a ledger bid, for a future public/bidder-facing
 * history (MAZAD-026 exposes no HTTP route for it). Built as a whitelist: the
 * bidder's account id and account-type snapshot are never emitted. The
 * requesting bidder can still be told which bids are theirs via `isMine`,
 * computed server-side from the authenticated principal.
 */
export function toAnonymizedBid(bid: any, viewerAccountId?: string) {
  return {
    sequence: bid.sequence as number,
    amountMinor: bid.amountMinor as number,
    currency: bid.currency as string,
    acceptedAt: bid.acceptedAt as Date,
    isMine: Boolean(viewerAccountId) && bid.bidderAccountId?.toString?.() === viewerAccountId,
  };
}
