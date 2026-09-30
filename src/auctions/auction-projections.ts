import { AuctionStatus } from './auction.types';

/**
 * Whitelist projections for every auction HTTP surface (MAZAD-025). Each is
 * built by naming the fields to emit — never by deleting fields from the
 * document — so a field added to the `Auction` schema later is invisible to
 * clients until someone deliberately adds it here.
 */

type AuctionRecord = any;

/** The frozen, client-relevant facts of the rule snapshot. Contains no attribution or internal flags. */
function publicRules(item: AuctionRecord) {
  const rules = item.ruleSnapshot ?? {};
  return {
    version: rules.version,
    antiSnipingWindowSeconds: rules.antiSnipingWindowSeconds,
    antiSnipingExtensionSeconds: rules.antiSnipingExtensionSeconds,
    hasReservePrice: rules.hasReservePrice,
    advertiserSelfBidForbidden: rules.advertiserSelfBidForbidden,
  };
}

/**
 * The finalized outcome (MAZAD-030), present only once the auction is COMPLETED.
 * Deliberately identity-free: amount, sequence and time only — never the
 * winner's account id or any profile data. (COMPLETED auctions are not
 * publicly browsable today; this stays correct if that product decision changes.)
 */
function outcome(item: AuctionRecord) {
  if (item.status !== AuctionStatus.COMPLETED || item.winningBidId === undefined || item.winningBidId === null) return undefined;
  return {
    winningBidAmountMinor: item.winningBidAmountMinor,
    winningBidSequence: item.winningBidSequence,
    currency: item.currency,
    finalizedAt: item.completedAt,
  };
}

/**
 * MAZAD-035: the Admin-approved entry fee. `free` is true only for an explicitly
 * configured 0; an absent fee is `configured: false` (fails closed), never free.
 */
export function entryFeeView(item: AuctionRecord) {
  const fee = item.entryFee;
  if (!fee || typeof fee.amountMinor !== 'number') return { configured: false, free: false, amountMinor: null, currency: item.currency };
  return { configured: true, free: fee.amountMinor === 0, amountMinor: fee.amountMinor, currency: fee.currency };
}

function core(item: AuctionRecord) {
  return {
    id: item._id.toString(),
    status: item.status as AuctionStatus,
    startingPriceMinor: item.startingPriceMinor,
    minimumBidStepMinor: item.minimumBidStepMinor,
    currency: item.currency,
    scheduledStartAt: item.scheduledStartAt,
    scheduledEndAt: item.scheduledEndAt,
    currentEndAt: item.currentEndAt,
    rules: publicRules(item),
    entryFee: entryFeeView(item),
    ...(outcome(item) ? { result: outcome(item) } : {}),
  };
}

/**
 * Anonymous marketplace view. `property` is the safe public projection of the
 * revision the auction is anchored to (already free of evidence, advertiser
 * account ids and moderation data). No advertiser account id, actor ids,
 * cancellation details, audit/worker fields, bid or payment data.
 */
export function toPublicAuction(item: AuctionRecord, property: unknown) {
  return { ...core(item), property };
}

/**
 * The advertiser's own view: everything public plus their own lifecycle
 * details (cancellation reason/time) and the auction's creation time. Actor
 * ids stay out — the caller already knows who they are — and `property` may
 * be null when the property has since stopped being publicly visible.
 */
export function toOwnAuction(item: AuctionRecord, property: unknown | null) {
  return {
    ...core(item),
    propertyId: item.propertyId.toString(),
    propertyRevisionId: item.propertyRevisionId.toString(),
    advertiserAccountTypeSnapshot: item.advertiserAccountTypeSnapshot,
    cancelledAt: item.cancelledAt,
    cancellationReason: item.cancellationReason,
    cancellationReasonCode: item.cancellationReasonCode,
    cancelledBySource: item.cancelledBySource,
    originRequestId: item.originRequestId?.toString?.() ?? null,
    createdAt: item.createdAt,
    property,
  };
}

/** Operational view for staff: attribution, approval, activation hold and cancellation details (incl. the Admin-only note). */
export function toAdminAuction(item: AuctionRecord) {
  return {
    ...core(item),
    propertyId: item.propertyId.toString(),
    propertyRevisionId: item.propertyRevisionId.toString(),
    advertiserAccountId: item.advertiserAccountId.toString(),
    advertiserAccountTypeSnapshot: item.advertiserAccountTypeSnapshot,
    createdByActorId: item.createdByActorId?.toString?.(),
    cancelledByActorId: item.cancelledByActorId?.toString?.(),
    cancelledAt: item.cancelledAt,
    cancellationReason: item.cancellationReason,
    cancellationReasonCode: item.cancellationReasonCode,
    cancelledBySource: item.cancelledBySource,
    cancellationInternalNote: item.cancellationInternalNote,
    acceptedBidCount: item.acceptedBidCount ?? 0,
    originRequestId: item.originRequestId?.toString?.() ?? null,
    approvedByActorId: item.approvedByActorId?.toString?.(),
    approvedAt: item.approvedAt,
    activationHold: item.activationHold ? { code: item.activationHold.code, at: item.activationHold.at } : null,
    // Staff-only winner references (MAZAD-030): read-only; nobody can choose or override the winner.
    ...(outcome(item)
      ? { winner: { accountId: item.winnerAccountId?.toString?.(), accountTypeSnapshot: item.winnerAccountTypeSnapshot, bidId: item.winningBidId?.toString?.(), acceptedAt: item.winningBidAcceptedAt } }
      : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * The public OUTCOME of an auction (realtime hardening: `GET /auctions/:id/outcome`).
 * The authoritative answer a client reads when it may have missed a terminal realtime
 * event (`AUCTION_CANCELLED` / `AUCTION_ENDED_NO_BIDS` / `AUCTION_FINALIZED`). It
 * carries exactly the facts those frames already carried to every subscriber — and
 * nothing else: no property, no identities (bidder, winner, seller, actors), no
 * payment/provider data, no cancellation reason or code, no Admin note, no review data.
 * Named fields only: a field added to the schema is invisible here until added on purpose.
 */
export function toPublicOutcome(item: AuctionRecord) {
  const status = item.status as AuctionStatus;
  const winning = outcome(item);
  return {
    auctionId: item._id.toString(),
    status,
    currentEndAt: item.currentEndAt,
    acceptedBidCount: item.acceptedBidCount ?? 0,
    ...(status === AuctionStatus.CANCELLED && item.cancelledAt ? { cancelledAt: item.cancelledAt } : {}),
    ...(winning ? {
      finalizedAt: winning.finalizedAt,
      result: { winningBidSequence: winning.winningBidSequence, winningBidAmountMinor: winning.winningBidAmountMinor, currency: winning.currency },
    } : {}),
  };
}
