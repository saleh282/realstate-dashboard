'use strict';

const { brokerLifecycleIndexesMigration } = require('../src/migrations/framework/core-migrations');
describe('MAZAD-012 additive broker index migration', () => {
  function setup() {
    const indexNames = new Map();
    const touchedCollections = [];
    const collection = jest.fn((name) => {
      touchedCollections.push(name);
      const names = indexNames.get(name) ?? new Set(['_id_']);
      indexNames.set(name, names);
      return {
        aggregate: jest.fn(() => ({
          toArray: jest.fn().mockResolvedValue([{ versions: [], pending: [], idempotency: [] }]),
        })),
        createIndex: jest.fn(async (_key, options) => {
          names.add(options.name);
          return options.name;
        }),
        indexes: jest.fn(async () => [...names].map((indexName) => ({ name: indexName }))),
      };
    });
    return { db: { collection }, collection, touchedCollections };
  }
  it('is dry-run safe and never infers or mutates existing user identity', async () => {
    const { db, touchedCollections } = setup();
    const report = await brokerLifecycleIndexesMigration.preflight({
      db,
      runId: 'dry-run',
      batchSize: 100,
    });
    expect(report.blockers).toEqual([]);
    expect(report.summary).toMatchObject({ existingUsersModified: 0 });
    expect(touchedCollections).not.toContain('users');
  });
  it('creates only additive broker indexes and validates them', async () => {
    const { db, touchedCollections } = setup();
    const batch = await brokerLifecycleIndexesMigration.migrateBatch({
      db,
      runId: 'apply-run',
      batchSize: 100,
    });
    expect(batch).toMatchObject({ scanned: 8, modified: 8, done: true });
    await expect(
      brokerLifecycleIndexesMigration.validate({
        db,
        runId: 'apply-run',
        batchSize: 100,
      }),
    ).resolves.toMatchObject({ valid: true, errors: [] });
    expect(new Set(touchedCollections)).toEqual(
      new Set([
        'broker_applications',
        'broker_verification_documents',
        'broker_verification_requirements',
      ]),
    );
  });
});
