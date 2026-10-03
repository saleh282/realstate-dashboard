import { ObjectId } from 'mongodb';

import { MAZAD035_INDEXES } from '../src/migrations/036-mazad035-auction-review';
import { MAZAD028_PAYMENT_INDEXES, scanMazad028Duplicates } from '../src/migrations/037-mazad028-payment-lifecycle';
import { CORE_MIGRATIONS, mazad028PaymentLifecycleMigration } from '../src/migrations/framework/core-migrations';
import { MigrationRunner } from '../src/migrations/framework/migration.runner';
import { selectMigrations } from '../src/migrations/cli';

import { OperationalStatusService } from '../src/operations/operational-status.service';
import { EntryPaymentStatus, PaymentReconciliationFlag } from '../src/payments/payment.types';
import { ManagedMarketingPaymentSchema } from '../src/payments/schemas/managed-marketing-payment.schema';
import { MemoryDb, MemoryStore } from './support/memory-mongo';

/**
 * MAZAD-028 — migration 037 (payment lifecycle indexes), the additive schema,
 * operational visibility and the cancellation routing of pending payers.
 */
const context = (db: MemoryDb) => ({ db: db as any, runId: 'run', batchSize: 100 });
/** MemoryDb models no `$group` accumulators: the duplicate scan's aggregate is answered directly (its pipeline is asserted separately). */
const withDuplicateScan = (db: MemoryDb, answer: (name: string, pipeline: any[]) => any[] = () => []) => {
  const collection = db.collection.bind(db);
  db.collection = ((name: string) => ({ ...collection(name), aggregate: (pipeline: any[]) => ({ toArray: async () => answer(name, pipeline) }) })) as any;
  return db;
};
const UNIQUE = ['entry_payment_one_live_per_bidder_auction', 'entry_payment_provider_reference', 'entitlement_auction_bidder', 'entitlement_payment', 'mm_payment_one_live_per_request', 'mm_payment_provider_reference'];

describe('migration 037 — payment lifecycle indexes', () => {
  it('is a frozen copy of EXACTLY the indexes the three payment schemas declare', () => {
    const declared = (schema: any) => schema.indexes().map(([key, options]: any) => ({ key, name: options.name, unique: Boolean(options.unique), partial: options.partialFilterExpression ?? null }));
    const fromMigration = (collection: string) => MAZAD028_PAYMENT_INDEXES.filter((index) => index.collection === collection)
      .map((index) => ({ key: index.key, name: index.options.name, unique: Boolean(index.options.unique), partial: index.options.partialFilterExpression ?? null }));
    const byName = (list: any[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));
    expect(byName(fromMigration('managed_marketing_payments'))).toEqual(byName(declared(ManagedMarketingPaymentSchema)));
  });

  it('migration-manages every critical unique index (no longer autoIndex-only) and the reconciliation scan indexes', () => {
    const names = MAZAD028_PAYMENT_INDEXES.map((index) => index.options.name);
    expect(MAZAD028_PAYMENT_INDEXES.filter((index) => index.options.unique).map((index) => index.options.name).sort()).toEqual([...UNIQUE].sort());
    expect(MAZAD028_PAYMENT_INDEXES.find((index) => index.options.name === 'entry_payment_status_next_verify')).toMatchObject({ collection: 'auction_entry_payments', key: { status: 1, nextVerifyAt: 1 } });
    expect(MAZAD028_PAYMENT_INDEXES.find((index) => index.options.name === 'mm_payment_status_next_verify')).toMatchObject({ collection: 'managed_marketing_payments', key: { status: 1, nextVerifyAt: 1 } });
    expect(new Set(names).size).toBe(names.length);
    // The index 036 already created keeps the identical definition here (createIndex is then a no-op).
    const shared = MAZAD035_INDEXES.find((index) => index.options.name === 'entry_payment_auction_status');
    expect(MAZAD028_PAYMENT_INDEXES.find((index) => index.options.name === 'entry_payment_auction_status')).toEqual(shared);
  });

  it('declares no TTL index anywhere: payment history is never deleted by the database', () => {
    for (const schema of [ManagedMarketingPaymentSchema]) {
      for (const [, options] of schema.indexes() as any[]) expect(options.expireAfterSeconds).toBeUndefined();
    }
    for (const index of MAZAD028_PAYMENT_INDEXES) expect((index.options as any).expireAfterSeconds).toBeUndefined();
  });

  it('is registered last, versioned, non-manual and passes registry validation', () => {
    expect(mazad028PaymentLifecycleMigration).toMatchObject({ id: '037-mazad028-payment-lifecycle-indexes', version: 1, rollback: { kind: 'none' } });
    expect(mazad028PaymentLifecycleMigration.manualOnly).toBe(true);
    expect(selectMigrations(CORE_MIGRATIONS).map((migration) => migration.id)).not.toContain('037-mazad028-payment-lifecycle-indexes');
  });

  it('dry-run writes nothing; apply creates every index; a rerun is an idempotent no-op; validation passes', async () => {
    const db = withDuplicateScan(new MemoryDb());
    const payment = { _id: new ObjectId(), auctionId: new ObjectId(), bidderAccountId: new ObjectId(), status: 'INITIATED', isLive: true, provider: 'fake', providerReference: 'r1', amountMinor: 100 };
    db.seed('auction_entry_payments', [payment]);
    const before = JSON.stringify(db.docs('auction_entry_payments'));
    const store = new MemoryStore();

    const run = (mode: 'dry-run' | 'apply') => new MigrationRunner(db as any, store).run(mazad028PaymentLifecycleMigration, mode);
    const dry = await run('dry-run');
    expect(dry).toMatchObject({ status: 'dry-run-complete', modified: 0 });
    expect(dry.preflight).toMatchObject({ eligible: MAZAD028_PAYMENT_INDEXES.length, alreadyApplied: 0, blockers: [] });
    expect((dry.preflight!.summary as any).paymentState).toMatchObject({ initiated: { auctionEntry: 1, managedMarketing: 0 }, initiatedWithoutSchedule: { auctionEntry: 1 } });
    expect(db.writes).toEqual([]);

    const applied = await run('apply');
    expect(applied).toMatchObject({ status: 'complete' });
    expect(applied.validation).toMatchObject({ valid: true, errors: [] });
    expect(db.writes.every((write) => write.op === 'createIndex')).toBe(true);
    expect(db.writes).toHaveLength(MAZAD028_PAYMENT_INDEXES.length);
    for (const index of MAZAD028_PAYMENT_INDEXES) {
      const created = (db.indexes.get(index.collection) ?? []).find((item) => item.name === index.options.name) as any;
      expect(created).toMatchObject({ key: index.key });
      expect(Boolean(created.unique)).toBe(Boolean(index.options.unique));
      expect(created.partialFilterExpression ?? null).toEqual(index.options.partialFilterExpression ?? null);
    }
    // No document was rewritten, moved or deleted.
    expect(JSON.stringify(db.docs('auction_entry_payments'))).toBe(before);

    db.writes.length = 0;
    const rerun = await run('apply');
    expect(rerun.status).toBe('skipped-complete');
    expect(db.writes).toEqual([]);
    expect(await mazad028PaymentLifecycleMigration.preflight(context(db))).toMatchObject({ eligible: 0, alreadyApplied: MAZAD028_PAYMENT_INDEXES.length, blockers: [] });
    // Applying the batch again by hand (a second node, an interrupted run) is equally harmless.
    await mazad028PaymentLifecycleMigration.migrateBatch(context(db));
    expect((await mazad028PaymentLifecycleMigration.validate(context(db))).valid).toBe(true);
    expect(JSON.stringify(db.docs('auction_entry_payments'))).toBe(before);
  });

  it('refuses a same-name index that lost its uniqueness or partial filter, and validation fails while one is missing', async () => {
    const db = withDuplicateScan(new MemoryDb());
    await mazad028PaymentLifecycleMigration.migrateBatch(context(db));
    const live = db.indexes.get('auction_entry_payments')!.find((index) => index.name === 'entry_payment_one_live_per_bidder_auction') as any;
    delete live.unique;
    expect((await mazad028PaymentLifecycleMigration.preflight(context(db))).blockers.map((blocker) => blocker.code)).toEqual(['MAZAD028_INDEX_CONFLICT']);
    expect((await mazad028PaymentLifecycleMigration.validate(context(db))).valid).toBe(false);
    live.unique = true; delete live.partialFilterExpression;
    expect((await mazad028PaymentLifecycleMigration.validate(context(db))).valid).toBe(false);
    live.partialFilterExpression = { isLive: true };
    expect((await mazad028PaymentLifecycleMigration.validate(context(db))).valid).toBe(true);
    db.indexes.set('auction_bid_entitlements', db.indexes.get('auction_bid_entitlements')!.filter((index) => index.name !== 'entitlement_auction_bidder'));
    const validation = await mazad028PaymentLifecycleMigration.validate(context(db));
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toEqual(['MAZAD028_INDEX_MISSING']);
  });

  it('the unique indexes cover exactly the duplicates a missing autoIndex could have let through (scan is read-only)', async () => {
    const pipelines: any[] = [];
    const db = withDuplicateScan(new MemoryDb(), (name, pipeline) => { pipelines.push({ name, pipeline }); return []; });
    expect(await scanMazad028Duplicates(db as any)).toEqual([]);
    expect(pipelines).toHaveLength(UNIQUE.length);
    expect(pipelines[0]).toMatchObject({ name: 'auction_entry_payments', pipeline: [{ $match: { isLive: true } }, { $group: { _id: { auctionId: '$auctionId', bidderAccountId: '$bidderAccountId' } } }, { $match: { count: { $gt: 1 } } }, { $limit: 20 }] });
    expect(db.writes).toEqual([]);
  });

  it('a duplicate under a unique index that still has to be built is a BLOCKER, never auto-repaired', async () => {
    const db = withDuplicateScan(new MemoryDb(), (name, pipeline) => (name === 'auction_bid_entitlements' && pipeline[1].$group._id.paymentId ? [{ _id: {}, count: 2, ids: ['e1', 'e2'] }] : []));
    const preflight = await mazad028PaymentLifecycleMigration.preflight(context(db));
    expect(preflight.blockers).toEqual([expect.objectContaining({ code: 'MAZAD028_DUPLICATE_KEY', sampleIds: ['e1', 'e2'] })]);
    expect(preflight.blockers[0].message).toContain('entitlement_payment');
    expect(db.writes).toEqual([]);
  });
});

describe('additive, backward-compatible schema (MAZAD-028)', () => {
  it('adds only optional fields; identity/amount fields stay immutable', () => {
    for (const schema of [ManagedMarketingPaymentSchema] as any[]) {
      for (const field of ['expiredAt', 'nextVerifyAt', 'verifyAttempts', 'clientHandoff', 'initiationClaimedAt']) {
        expect(schema.path(field)).toBeDefined();
        expect((schema.path(field) as any).isRequired).toBeFalsy();
      }
      expect([...(schema.path('status') as any).enumValues].sort()).toEqual(['EXPIRED', 'FAILED', 'INITIATED', 'SUCCEEDED']);
      expect((schema.path('reconciliationFlag') as any).enumValues).toContain('CONFIRMED_AFTER_EXPIRY');
      expect((schema.path('amountMinor') as any).options.immutable).toBe(true);
      expect((schema.path('clientHandoff') as any).options.maxlength).toBe(2000);
    }
    expect(Object.values(EntryPaymentStatus)).toEqual(['INITIATED', 'SUCCEEDED', 'FAILED', 'EXPIRED']);
    expect(PaymentReconciliationFlag.CONFIRMED_AFTER_EXPIRY).toBe('CONFIRMED_AFTER_EXPIRY');
  });
});

describe('operational visibility of payments (counts only)', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
  const match = (row: Record<string, any>, filter: Record<string, any>) => Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && '$exists' in expected) return (row[key] !== undefined) === expected.$exists;
    if (expected && typeof expected === 'object' && '$lte' in expected) return row[key] !== undefined && row[key].getTime() <= expected.$lte.getTime();
    return row[key] === expected;
  });
  const service = (payments: Record<string, any[]>, values: Record<string, unknown> = {}) => new OperationalStatusService({
    db: {
      collection: (name: string) => {
        if (name === 'migration_ledger') return { find: () => ({ toArray: async () => [] }) };
        if (name === 'migration_locks') return { findOne: async () => null };
        if (name in payments || name === 'managed_marketing_payments') return { countDocuments: async (filter: any) => (payments[name] ?? []).filter((row) => match(row, filter)).length };
        return { countDocuments: async () => 0, find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) };
      },
    },
  } as any, { get: (key: string) => ({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production', ...values } as Record<string, unknown>)[key] } as any, { providerKey: 'unconfigured', configured: false } as any);

  it('is quiet with no payments', async () => {
    const status = await service({}).status(now);
    expect(status.payments).toEqual({ pending: 0, due: 0, stale: 0, expired: 0, flagged: 0, confirmedAfterExpiry: 0 });
    expect(status.attention).toEqual([]);
  });

  it('counts pending, due, stale, expired, flagged, confirmed-after-expiry and late-confirmed for managed marketing', async () => {
    const status = await service({
      managed_marketing_payments: [
        { status: 'INITIATED', initiatedAt: ago(30), nextVerifyAt: ago(5) },                       // pending + due
        { status: 'INITIATED', initiatedAt: ago(30), nextVerifyAt: new Date(now.getTime() + 60_000) }, // pending, not due
        { status: 'INITIATED', initiatedAt: ago(7200), nextVerifyAt: ago(10) },                    // pending + due + stale
        { status: 'EXPIRED', initiatedAt: ago(9000) },
        { status: 'EXPIRED', initiatedAt: ago(9000), reconciliationFlag: 'CONFIRMED_AFTER_EXPIRY' },
        { status: 'INITIATED', initiatedAt: ago(40), reconciliationFlag: 'AMOUNT_MISMATCH', nextVerifyAt: new Date(now.getTime() + 60_000) },
        { status: 'SUCCEEDED', initiatedAt: ago(9000), lateConfirmation: true },
        { status: 'SUCCEEDED', initiatedAt: ago(9000) },

        { status: 'INITIATED', initiatedAt: ago(10), nextVerifyAt: ago(1) },
        { status: 'EXPIRED', initiatedAt: ago(9000) },
        { status: 'FAILED', initiatedAt: ago(9000), reconciliationFlag: 'CONFIRMED_AFTER_FAILURE' },
      ],
    }).status(now);
    expect(status.payments).toEqual({ pending: 5, due: 3, stale: 1, expired: 3, flagged: 3, confirmedAfterExpiry: 1 });
    expect(status.attention).toEqual(['payments_reconciliation_required', 'payments_stale']);
    // Counts only: no reference, amount, account or flag name leaves the service.
    expect(JSON.stringify(status.payments)).not.toMatch(/AMOUNT_MISMATCH|ref|account/i);
  });

  it('the stale threshold is configurable', async () => {
    const rows = { managed_marketing_payments: [{ status: 'INITIATED', initiatedAt: ago(600), nextVerifyAt: new Date(now.getTime() + 1) }] };
    expect((await service(rows).status(now)).payments.stale).toBe(0);
    expect((await service(rows, { PAYMENT_STALE_ALERT_SECONDS: '300' }).status(now)).payments.stale).toBe(1);
  });
});
