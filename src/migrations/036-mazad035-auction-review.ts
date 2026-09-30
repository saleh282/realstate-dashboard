import type { Db } from 'mongodb';

/**
 * MAZAD-035 (auction review workflow): additive, production-safe indexes.
 * Frozen literal copies of the schema declarations (a unit test asserts they
 * stay identical), so this migration never changes meaning if a schema file
 * later evolves. It creates indexes only — no document is read-modified,
 * moved or deleted, and pre-review ("legacy") auctions are reported, never
 * rewritten: they fail closed at activation (no fee) and can be cancelled
 * from Admin.
 */
export type MigrationIndexSpec = { collection: string; key: Record<string, 1 | -1>; options: { name: string; unique?: boolean; partialFilterExpression?: Record<string, unknown> } };

export const MAZAD035_INDEXES: readonly MigrationIndexSpec[] = [
  { collection: 'auction_requests', key: { liveKey: 1 }, options: { unique: true, partialFilterExpression: { liveKey: { $exists: true } }, name: 'auction_request_live_property' } },
  { collection: 'auction_requests', key: { status: 1, submittedAt: 1, _id: 1 }, options: { name: 'auction_request_review_queue' } },
  { collection: 'auction_requests', key: { advertiserAccountId: 1, createdAt: -1 }, options: { name: 'auction_request_advertiser_history' } },
  { collection: 'auction_requests', key: { propertyId: 1, createdAt: -1 }, options: { name: 'auction_request_property_history' } },
  { collection: 'auction_requests', key: { auctionId: 1 }, options: { partialFilterExpression: { auctionId: { $exists: true } }, name: 'auction_request_auction' } },
  { collection: 'auctions', key: { originRequestId: 1, originRequestRevision: 1 }, options: { unique: true, partialFilterExpression: { originRequestId: { $exists: true } }, name: 'auction_origin_request_revision' } },
  { collection: 'auction_entry_payments', key: { auctionId: 1, status: 1 }, options: { name: 'entry_payment_auction_status' } },
];

/** Read-only report of pre-review auctions (no fee / no originating request) — what an operator may want to cancel. */
export async function scanMazad035LegacyAuctions(db: Db) {
  const auctions = db.collection('auctions');
  const liveWithoutFee = await auctions.find({ status: { $in: ['scheduled', 'active'] }, entryFee: { $exists: false } }, { projection: { _id: 1, status: 1 } }).limit(1000).toArray();
  const ids = liveWithoutFee.map((row) => row._id);
  const [withBids, withPayments, withoutOrigin, duplicateLiveKeys] = await Promise.all([
    ids.length ? db.collection('bids').distinct('auctionId', { auctionId: { $in: ids } }) : Promise.resolve([]),
    ids.length ? db.collection('auction_entry_payments').distinct('auctionId', { auctionId: { $in: ids } }) : Promise.resolve([]),
    auctions.countDocuments({ originRequestId: { $exists: false } }),
    db.collection('auction_requests').aggregate([
      { $match: { liveKey: { $exists: true } } },
      { $group: { _id: '$liveKey', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ]).toArray().catch((error: { code?: number }) => { if (error?.code === 26) return []; throw error; }),
  ]);
  return {
    liveWithoutFee: liveWithoutFee.length,
    liveWithoutFeeScheduled: liveWithoutFee.filter((row) => row.status === 'scheduled').length,
    liveWithoutFeeActive: liveWithoutFee.filter((row) => row.status === 'active').length,
    liveWithoutFeeWithBids: withBids.length,
    liveWithoutFeeWithPayments: withPayments.length,
    sampleIds: ids.slice(0, 20).map(String),
    auctionsWithoutOriginRequest: withoutOrigin,
    duplicateLiveKeys: duplicateLiveKeys.map((row) => String(row._id)),
  };
}
