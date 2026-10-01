import type { Db } from 'mongodb';
import type { MigrationIndexSpec } from './036-mazad035-auction-review';

/**
 * MAZAD-028 (payment lifecycle, confirmation and reconciliation): additive,
 * production-safe indexes for the three payment collections.
 *
 * Two groups, both frozen literal copies of the schema declarations (a unit
 * test asserts they stay identical):
 *
 *  - the CRITICAL UNIQUE indexes the payment guarantees rest on — one live
 *    attempt per bidder/auction and per request, one payment per provider
 *    reference, one entitlement per (auction, bidder) and per payment. Until
 *    now they existed only if Mongoose `autoIndex` happened to build them; a
 *    database where it did not run silently lost "pays once" and "entitled
 *    once". They are now explicit, validated migration state;
 *  - the reconciliation worker's `(status, nextVerifyAt)` scan index and the
 *    small partial indexes behind the operational counts.
 *
 * It creates indexes only. No document is read-modified, moved or deleted,
 * there is no TTL index (payment history is retained forever), and no
 * backfill: an attempt written before this migration has no `nextVerifyAt`
 * and the worker treats it as due.
 */
export const MAZAD028_PAYMENT_INDEXES: readonly MigrationIndexSpec[] = [
  { collection: 'auction_entry_payments', key: { auctionId: 1, bidderAccountId: 1 }, options: { unique: true, partialFilterExpression: { isLive: true }, name: 'entry_payment_one_live_per_bidder_auction' } },
  { collection: 'auction_entry_payments', key: { provider: 1, providerReference: 1 }, options: { unique: true, partialFilterExpression: { providerReference: { $type: 'string' } }, name: 'entry_payment_provider_reference' } },
  { collection: 'auction_entry_payments', key: { status: 1, initiatedAt: 1 }, options: { name: 'entry_payment_status_initiated' } },
  { collection: 'auction_entry_payments', key: { bidderAccountId: 1, createdAt: -1 }, options: { name: 'entry_payment_bidder_history' } },
  { collection: 'auction_entry_payments', key: { status: 1, nextVerifyAt: 1 }, options: { name: 'entry_payment_status_next_verify' } },
  { collection: 'auction_entry_payments', key: { reconciliationFlag: 1 }, options: { partialFilterExpression: { reconciliationFlag: { $exists: true } }, name: 'entry_payment_reconciliation_flag' } },
  { collection: 'auction_entry_payments', key: { lateConfirmation: 1 }, options: { partialFilterExpression: { lateConfirmation: true }, name: 'entry_payment_late_confirmation' } },
  { collection: 'auction_entry_payments', key: { auctionId: 1, status: 1 }, options: { name: 'entry_payment_auction_status' } },
  { collection: 'auction_bid_entitlements', key: { auctionId: 1, bidderAccountId: 1 }, options: { unique: true, name: 'entitlement_auction_bidder' } },
  { collection: 'auction_bid_entitlements', key: { paymentId: 1 }, options: { unique: true, name: 'entitlement_payment' } },
  { collection: 'auction_bid_entitlements', key: { bidderAccountId: 1, createdAt: -1 }, options: { name: 'entitlement_bidder_history' } },
  { collection: 'managed_marketing_payments', key: { requestId: 1 }, options: { unique: true, partialFilterExpression: { isLive: true }, name: 'mm_payment_one_live_per_request' } },
  { collection: 'managed_marketing_payments', key: { provider: 1, providerReference: 1 }, options: { unique: true, partialFilterExpression: { providerReference: { $type: 'string' } }, name: 'mm_payment_provider_reference' } },
  { collection: 'managed_marketing_payments', key: { status: 1, initiatedAt: 1 }, options: { name: 'mm_payment_status_initiated' } },
  { collection: 'managed_marketing_payments', key: { advertiserAccountId: 1, createdAt: -1 }, options: { name: 'mm_payment_advertiser_history' } },
  { collection: 'managed_marketing_payments', key: { status: 1, nextVerifyAt: 1 }, options: { name: 'mm_payment_status_next_verify' } },
  { collection: 'managed_marketing_payments', key: { reconciliationFlag: 1 }, options: { partialFilterExpression: { reconciliationFlag: { $exists: true } }, name: 'mm_payment_reconciliation_flag' } },
];

export type Mazad028DuplicateFinding = { index: string; sampleIds: string[] };

/**
 * Read-only: documents that would make a unique index of this migration
 * impossible to build (only possible where `autoIndex` never created it). They
 * are reported as blockers, never repaired here — which of two live attempts
 * or two entitlements is the real one is a money question for an operator.
 */
export async function scanMazad028Duplicates(db: Db): Promise<Mazad028DuplicateFinding[]> {
  const findings: Mazad028DuplicateFinding[] = [];
  for (const spec of MAZAD028_PAYMENT_INDEXES.filter((index) => index.options.unique)) {
    const group = Object.fromEntries(Object.keys(spec.key).map((field) => [field, `$${field}`]));
    const rows = await db.collection(spec.collection).aggregate([
      { $match: spec.options.partialFilterExpression ?? {} },
      { $group: { _id: group, count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ]).toArray().catch((error: { code?: number }) => { if (error?.code === 26) return []; throw error; });
    if (rows.length) findings.push({ index: spec.options.name, sampleIds: rows.flatMap((row) => (row.ids as unknown[]).slice(0, 2).map(String)).slice(0, 20) });
  }
  return findings;
}

/** Read-only report of what the lifecycle will meet: attempts without a reconciliation schedule yet (treated as due). */
export async function scanMazad028PaymentState(db: Db) {
  const count = (collection: string, filter: Record<string, unknown>) =>
    db.collection(collection).countDocuments(filter).catch((error: { code?: number }) => { if (error?.code === 26) return 0; throw error; });
  const [entryUnscheduled, marketingUnscheduled, entryInitiated, marketingInitiated] = await Promise.all([
    count('auction_entry_payments', { status: 'INITIATED', nextVerifyAt: { $exists: false } }),
    count('managed_marketing_payments', { status: 'INITIATED', nextVerifyAt: { $exists: false } }),
    count('auction_entry_payments', { status: 'INITIATED' }),
    count('managed_marketing_payments', { status: 'INITIATED' }),
  ]);
  return { initiated: { auctionEntry: entryInitiated, managedMarketing: marketingInitiated }, initiatedWithoutSchedule: { auctionEntry: entryUnscheduled, managedMarketing: marketingUnscheduled } };
}
