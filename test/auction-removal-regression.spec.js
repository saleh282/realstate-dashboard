'use strict';

const { selectMigrations } = require('../src/migrations/cli');
const { CORE_MIGRATIONS } = require('../src/migrations/framework/core-migrations');
const {
  managedMarketingPaymentIndexesMigration,
  MANAGED_MARKETING_PAYMENT_INDEXES,
} = require('../src/migrations/038-managed-marketing-payment-indexes');
const { MigrationRunner } = require('../src/migrations/framework/migration.runner');
const { MemoryDb, MemoryStore } = require('./support/memory-mongo');
describe('removed feature boundaries', () => {
  it('keeps property, auth, users, marketing and notifications reachable without registering auction controllers or modules', () => {
    const express = require('express');
    const app = express();
    require('../src/routes').registerRoutes(app, {});
    const paths = app._router.stack.filter((l) => l.name === 'router').map((l) => String(l.regexp));
    expect(paths.join(' ')).toMatch(/properties/);
    expect(paths.join(' ')).toMatch(/notifications/);
    expect(paths.join(' ')).not.toMatch(/auction|realtime/);
  });
  it('excludes frozen auction/mixed migrations from default runs and retains explicit historical access', () => {
    const defaults = selectMigrations(CORE_MIGRATIONS).map((migration) => migration.id);
    expect(defaults).toContain('038-managed-marketing-payment-indexes');
    expect(defaults).not.toContain('036-mazad035-auction-review-indexes');
    expect(defaults).not.toContain('037-mazad028-payment-lifecycle-indexes');
    expect(CORE_MIGRATIONS.find((migration) => migration.id.startsWith('036-'))).toMatchObject({
      version: 1,
      manualOnly: true,
    });
  });
});
describe('retained payment index migration', () => {
  function database(duplicates = false) {
    const db = new MemoryDb();
    const collection = db.collection.bind(db);
    db.collection = (name) => ({
      ...collection(name),
      aggregate: () => ({ toArray: async () => (duplicates ? [{ count: 2 }] : []) }),
    });
    return db;
  }
  it('dry-runs without writes, applies only marketing indexes, validates, and skips a completed rerun', async () => {
    const db = database();
    const store = new MemoryStore();
    const runner = new MigrationRunner(db, store);
    expect(
      (await runner.run(managedMarketingPaymentIndexesMigration, 'dry-run')).preflight.blockers,
    ).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(
      (await runner.run(managedMarketingPaymentIndexesMigration, 'apply')).validation.valid,
    ).toBe(true);
    expect(db.writes).toHaveLength(MANAGED_MARKETING_PAYMENT_INDEXES.length);
    expect(
      db.writes.every(
        (write) => write.collection === 'managed_marketing_payments' && write.op === 'createIndex',
      ),
    ).toBe(true);
    expect((await runner.run(managedMarketingPaymentIndexesMigration, 'apply')).status).toBe(
      'skipped-complete',
    );
  });
  it('blocks duplicates before creating safety indexes', async () => {
    const result = await managedMarketingPaymentIndexesMigration.preflight({
      db: database(true),
      runId: 'test',
      batchSize: 100,
    });
    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      'MARKETING_PAYMENT_DUPLICATE_KEY',
    );
  });
  it('blocks conflicting index options rather than replacing an existing safety index', async () => {
    const db = database();
    const spec = MANAGED_MARKETING_PAYMENT_INDEXES.find((index) => index.options.unique);
    db.indexes.set(spec.collection, [{ key: spec.key, name: spec.options.name, unique: false }]);
    const result = await managedMarketingPaymentIndexesMigration.preflight({
      db: db,
      runId: 'test',
      batchSize: 100,
    });
    expect(result.blockers.map((blocker) => blocker.code)).toContain(
      'MARKETING_PAYMENT_INDEX_CONFLICT',
    );
    expect(db.writes).toEqual([]);
  });
});
