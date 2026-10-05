'use strict';

const { MAZAD028_PAYMENT_INDEXES } = require('./037-mazad028-payment-lifecycle');
const { indexKeyMatches } = require('./022-property-type-selection');
// Copy the frozen historical definitions, selecting only the retained purpose.
const MANAGED_MARKETING_PAYMENT_INDEXES = MAZAD028_PAYMENT_INDEXES.filter(
  (index) => index.collection === 'managed_marketing_payments',
);
async function problems(db) {
  const existing = await db
    .collection('managed_marketing_payments')
    .indexes()
    .catch((error) => {
      if (error.code === 26) return [];
      throw error;
    });
  const missing = [];
  const conflicting = [];
  for (const spec of MANAGED_MARKETING_PAYMENT_INDEXES) {
    const found = existing.find((index) => index.name === spec.options.name);
    if (!found) missing.push(spec.options.name);
    else if (
      !indexKeyMatches(found, spec.key) ||
      Boolean(found.unique) !== Boolean(spec.options.unique) ||
      JSON.stringify(found.partialFilterExpression ?? null) !==
        JSON.stringify(spec.options.partialFilterExpression ?? null)
    ) {
      conflicting.push(spec.options.name);
    }
  }
  return { missing, conflicting };
}
const managedMarketingPaymentIndexesMigration = {
  id: '038-managed-marketing-payment-indexes',
  version: 1,
  description:
    'Create the retained managed-marketing payment safety and reconciliation indexes independently of retired payment purposes',
  dependencies: [],
  rollback: {
    kind: 'none',
    remediation:
      'Additive indexes only. Preserve unique payment indexes while payments are enabled. No domain documents are changed.',
    restoreProcedure:
      'Compare indexes with the pre-migration backup before any reviewed rollback. Never delete payment history.',
  },
  async preflight({ db }) {
    const { missing, conflicting } = await problems(db);
    const blockers = conflicting.map((name) => ({
      code: 'MARKETING_PAYMENT_INDEX_CONFLICT',
      message: `Index ${name} has a conflicting definition`,
    }));
    for (const spec of MANAGED_MARKETING_PAYMENT_INDEXES.filter(
      (index) => index.options.unique && missing.includes(index.options.name),
    )) {
      const rows = await db
        .collection(spec.collection)
        .aggregate([
          { $match: spec.options.partialFilterExpression ?? {} },
          {
            $group: {
              _id: Object.fromEntries(Object.keys(spec.key).map((key) => [key, `$${key}`])),
              count: { $sum: 1 },
            },
          },
          { $match: { count: { $gt: 1 } } },
          { $limit: 1 },
        ])
        .toArray();
      if (rows.length)
        blockers.push({
          code: 'MARKETING_PAYMENT_DUPLICATE_KEY',
          message: `Existing payments violate ${spec.options.name}; resolve before applying`,
        });
    }
    return {
      eligible: missing.length,
      alreadyApplied:
        MANAGED_MARKETING_PAYMENT_INDEXES.length - missing.length - conflicting.length,
      blockers,
      summary: { missing, conflicting },
    };
  },
  async migrateBatch({ db }) {
    for (const spec of MANAGED_MARKETING_PAYMENT_INDEXES)
      await db.collection(spec.collection).createIndex(spec.key, spec.options);
    return {
      scanned: MANAGED_MARKETING_PAYMENT_INDEXES.length,
      modified: MANAGED_MARKETING_PAYMENT_INDEXES.length,
      done: true,
    };
  },
  async validate({ db }) {
    const { missing, conflicting } = await problems(db);
    return {
      valid: !missing.length && !conflicting.length,
      errors: [...missing, ...conflicting].map((name) => ({
        code: 'MARKETING_PAYMENT_INDEX_INVALID',
        message: `Index ${name} is missing or conflicting`,
      })),
    };
  },
};

Object.assign(exports, {
  MANAGED_MARKETING_PAYMENT_INDEXES,
  managedMarketingPaymentIndexesMigration,
});
