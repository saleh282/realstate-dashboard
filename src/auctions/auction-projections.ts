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
    createdAt: item.createdAt,
    property,
  };
}

/** Read-only operational view for staff: attribution and cancellation actors included, no bid/payment/winner data (none exists yet). */
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
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
