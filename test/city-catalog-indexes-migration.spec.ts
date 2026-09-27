import { cityCatalogIndexesMigration } from '../src/migrations/framework/core-migrations';
import { MigrationRunner } from '../src/migrations/framework/migration.runner';
import { MemoryDb, MemoryStore } from './support/memory-mongo';

/**
 * 021-city-catalog-indexes recovery (post-reset hardening): a reset that
 * preserves indexes can leave an equivalent index under a different name.
 * That must satisfy the migration as-is, never trigger a rename/drop, and a
 * genuinely incompatible same-key index must fail closed instead of silently
 * weakening uniqueness.
 */
const runner = (db: MemoryDb, store = new MemoryStore()) => new MigrationRunner(db as any, store, {});
const completed = (...ids: string[]) => { const store = new MemoryStore(); for (const id of ids) store.markComplete(id); return store; };
const withDependency = () => completed('015-property-domain-indexes');

const NAMED = {
  codeUnique: 'city_governorate_code_unique',
  nameArUnique: 'city_governorate_name_ar_unique',
  publicOrder: 'city_public_catalog_order',
};

describe('021-city-catalog-indexes', () => {
  it('index absent: creates all three indexes under their intended names on a fresh database', async () => {
    const db = new MemoryDb().seed('cities', []);
    const dryRun = await runner(db).run(cityCatalogIndexesMigration, 'dry-run');
    expect(dryRun.preflight).toMatchObject({ eligible: 3, alreadyApplied: 0, blockers: [] });
    expect(db.writes).toEqual([]);

    expect(await runner(db, withDependency()).run(cityCatalogIndexesMigration, 'apply')).toMatchObject({ status: 'complete', modified: 3 });
    const names = (db.indexes.get('cities') ?? []).map((index) => index.name);
    expect(names).toEqual(expect.arrayContaining(Object.values(NAMED)));
    expect(db.indexes.get('cities')!.find((index) => index.name === NAMED.codeUnique)).toMatchObject({ unique: true });
  });

  it('expected named index already exists: no-op, reported as already applied', async () => {
    const db = new MemoryDb().seed('cities', []);
    db.indexes.set('cities', [
      { name: NAMED.codeUnique, key: { governorateId: 1, code: 1 }, unique: true },
      { name: NAMED.nameArUnique, key: { governorateId: 1, nameAr: 1 }, unique: true },
      { name: NAMED.publicOrder, key: { governorateId: 1, isActive: 1, sortOrder: 1, nameAr: 1 } },
    ]);
    const dryRun = await runner(db).run(cityCatalogIndexesMigration, 'dry-run');
    expect(dryRun.preflight).toMatchObject({ eligible: 0, alreadyApplied: 3, blockers: [] });

    expect(await runner(db, withDependency()).run(cityCatalogIndexesMigration, 'apply')).toMatchObject({ status: 'complete', modified: 0 });
    expect(db.writes.filter((write) => write.op === 'createIndex')).toEqual([]);
  });

  it('same key/spec under a different name: treated as already satisfied, never dropped or renamed', async () => {
    const db = new MemoryDb().seed('cities', []);
    // Preserved-from-before-reset index: identical key and uniqueness, but an old name.
    db.indexes.set('cities', [{ name: 'governorateId_1_code_1', key: { governorateId: 1, code: 1 }, unique: true }]);

    const dryRun = await runner(db).run(cityCatalogIndexesMigration, 'dry-run');
    expect(dryRun.preflight).toMatchObject({ eligible: 2, alreadyApplied: 1, blockers: [] });

    expect(await runner(db, withDependency()).run(cityCatalogIndexesMigration, 'apply')).toMatchObject({ status: 'complete', modified: 2 });
    const cityIndexes = db.indexes.get('cities')!;
    // The old-named index is untouched: still present, still under its original name.
    expect(cityIndexes.find((index) => index.name === 'governorateId_1_code_1')).toMatchObject({ key: { governorateId: 1, code: 1 }, unique: true });
    expect(db.writes.some((write) => write.op === 'dropIndex')).toBe(false);
    // No second, differently-named index was created for the same key.
    expect(cityIndexes.filter((index) => JSON.stringify(index.key) === JSON.stringify({ governorateId: 1, code: 1 }))).toHaveLength(1);
    expect(cityIndexes.find((index) => index.name === NAMED.nameArUnique)).toBeDefined();
    expect(cityIndexes.find((index) => index.name === NAMED.publicOrder)).toBeDefined();
  });

  it('same keys but incompatible unique option: fails closed with a clear blocker, in both dry-run and apply', async () => {
    const db = new MemoryDb().seed('cities', []);
    // Same key as the intended unique index, but NOT unique: a real semantic conflict.
    db.indexes.set('cities', [{ name: 'governorateId_1_code_1', key: { governorateId: 1, code: 1 } }]);

    await expect(runner(db).run(cityCatalogIndexesMigration, 'dry-run')).rejects.toThrow(/CITY_CATALOG_INDEX_INCOMPATIBLE/);
    await expect(runner(db, withDependency()).run(cityCatalogIndexesMigration, 'apply')).rejects.toThrow(/CITY_CATALOG_INDEX_INCOMPATIBLE/);
    // Fails closed: the non-conflicting indexes are never created either, and nothing is dropped/weakened.
    expect(db.writes).toEqual([]);
    expect(db.indexes.get('cities')).toEqual([{ name: 'governorateId_1_code_1', key: { governorateId: 1, code: 1 } }]);
  });

  it('rerun/idempotency: re-executing the migration logic itself (not just the ledger skip) is a pure no-op', async () => {
    const db = new MemoryDb().seed('cities', []);
    db.indexes.set('cities', [{ name: 'governorateId_1_code_1', key: { governorateId: 1, code: 1 }, unique: true }]);
    // A fresh store each time (021 itself never marked complete) forces a real re-run of
    // preflight+migrateBatch+validate, proving the migration's own logic is idempotent —
    // not merely that the ledger short-circuits a repeat call.
    await runner(db, withDependency()).run(cityCatalogIndexesMigration, 'apply');
    const before = JSON.stringify(db.indexes.get('cities'));

    expect(await runner(db, withDependency()).run(cityCatalogIndexesMigration, 'apply')).toMatchObject({ status: 'complete', modified: 0 });
    expect(JSON.stringify(db.indexes.get('cities'))).toBe(before);
    expect(db.writes.filter((write) => write.op === 'createIndex')).toHaveLength(2); // only the two genuinely-missing indexes, once each
  });

  it('a genuinely failed prior ledger entry can be retried safely once the underlying conflict is resolved', async () => {
    const store = withDependency();
    const db = new MemoryDb().seed('cities', []);
    // Same shape as the real incompatible-option failure this migration recorded post-reset.
    db.indexes.set('cities', [{ name: 'governorateId_1_code_1', key: { governorateId: 1, code: 1 } }]);
    await expect(runner(db, store).run(cityCatalogIndexesMigration, 'apply')).rejects.toThrow(/CITY_CATALOG_INDEX_INCOMPATIBLE/);
    expect((await store.get(cityCatalogIndexesMigration.id))!.status).toBe('failed');

    // Reconciled: the pre-existing index is now equivalent (unique), matching the fixed migration's expectations.
    db.indexes.set('cities', [{ name: 'governorateId_1_code_1', key: { governorateId: 1, code: 1 }, unique: true }]);
    expect(await runner(db, store).run(cityCatalogIndexesMigration, 'apply')).toMatchObject({ status: 'complete', modified: 2 });
    expect((await store.get(cityCatalogIndexesMigration.id))!.status).toBe('complete');
  });

  it('validate reports the equivalent-key case as satisfied, and the incompatible case as unsatisfied', async () => {
    const satisfied = new MemoryDb().seed('cities', []);
    satisfied.indexes.set('cities', [
      { name: 'governorateId_1_code_1', key: { governorateId: 1, code: 1 }, unique: true },
      { name: NAMED.nameArUnique, key: { governorateId: 1, nameAr: 1 }, unique: true },
      { name: NAMED.publicOrder, key: { governorateId: 1, isActive: 1, sortOrder: 1, nameAr: 1 } },
    ]);
    const validation = await cityCatalogIndexesMigration.validate({ db: satisfied as any, runId: 'direct', batchSize: 250 });
    expect(validation.valid).toBe(true);

    const incompatible = new MemoryDb().seed('cities', []);
    incompatible.indexes.set('cities', [{ name: 'governorateId_1_code_1', key: { governorateId: 1, code: 1 } }]);
    const invalidValidation = await cityCatalogIndexesMigration.validate({ db: incompatible as any, runId: 'direct', batchSize: 250 });
    expect(invalidValidation.valid).toBe(false);
    expect(invalidValidation.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CITY_CATALOG_INDEX_INCOMPATIBLE' })]));
  });
});
