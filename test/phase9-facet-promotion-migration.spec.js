'use strict';

const { ObjectId } = require('mongodb');
const { phase9FacetPromotionMigration } = require('../src/migrations/framework/core-migrations');
const { MigrationRunner } = require('../src/migrations/framework/migration.runner');
const {
  phase8RegistryDocument,
  PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED,
} = require('../src/migrations/029-non-residential-attribute-registry');
const { PHASE9_PROMOTED_FACET_KEYS } = require('../src/migrations/030-phase9-facet-promotion');
const { MemoryDb, MemoryStore } = require('./support/memory-mongo');
/** Phase 9 (Search & Facets): promotes exactly 7 Phase 8 attributes to typed search facets (030-phase9-facet-promotion). */
const snapshot = (db, name) => JSON.stringify(db.docs(name));
const writesTo = (db) => [...new Set(db.writes.map((write) => write.collection))].sort();
const runner = (db, store = new MemoryStore(), batchSize = 250) =>
  new MigrationRunner(db, store, { batchSize });
const completed = (...ids) => {
  const store = new MemoryStore();
  for (const id of ids) store.markComplete(id);
  return store;
};
const byKey = (key) => PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.find((seed) => seed.key === key);
const NON_PROMOTED_PHASE8_KEYS = PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.map(
  (seed) => seed.key,
).filter((key) => !PHASE9_PROMOTED_FACET_KEYS.includes(key));
/** Seeds the 17 Phase 8 registry entries (as migration 029 would leave them: no facetKey set on any). */
function seedPhase8Registry(db) {
  const now = new Date('2026-01-01');
  db.seed(
    'property_attributes',
    PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.map((seed, index) => ({
      _id: new ObjectId(`64c0000000000000000030${String(index).padStart(2, '0')}`),
      ...phase8RegistryDocument(seed, now),
    })),
  );
  return db;
}
describe('Phase 9 facet promotion (030-phase9-facet-promotion)', () => {
  it('has exactly the 7 approved promotion keys', () => {
    expect(PHASE9_PROMOTED_FACET_KEYS).toEqual([
      'shopFloorLevel',
      'commercialUseTypes',
      'builtAreaSqm',
      'powerSource',
      'industrialUseType',
      'soilType',
      'waterSource',
    ]);
    expect(NON_PROMOTED_PHASE8_KEYS).toHaveLength(10);
  });
  it('depends on 029-phase8-attribute-registry', () => {
    expect(phase9FacetPromotionMigration.dependencies).toEqual(['029-phase8-attribute-registry']);
  });
  it('blocks with PROPERTY_ATTRIBUTE_MISSING when the Phase 8 registry has not been seeded yet', async () => {
    const db = new MemoryDb();
    await expect(
      runner(db, completed('029-phase8-attribute-registry')).run(
        phase9FacetPromotionMigration,
        'apply',
      ),
    ).rejects.toThrow(/PROPERTY_ATTRIBUTE_MISSING/);
    expect(db.writes).toEqual([]);
  });
  it('is blocked by the runner when its own dependency (029) is not complete, even if the registry happens to be seeded', async () => {
    const db = seedPhase8Registry(new MemoryDb());
    await expect(
      runner(db, new MemoryStore()).run(phase9FacetPromotionMigration, 'apply'),
    ).rejects.toThrow(/Dependency 029-phase8-attribute-registry is not complete/);
  });
  it('dry-runs, promotes exactly the 7 approved keys, and is idempotent', async () => {
    const db = seedPhase8Registry(new MemoryDb());
    const dryRun = await runner(db, completed('029-phase8-attribute-registry')).run(
      phase9FacetPromotionMigration,
      'dry-run',
    );
    expect(dryRun.preflight).toMatchObject({ eligible: 7, alreadyApplied: 0, blockers: [] });
    expect(db.writes).toEqual([]);
    const store = completed('029-phase8-attribute-registry');
    expect(await runner(db, store).run(phase9FacetPromotionMigration, 'apply')).toMatchObject({
      status: 'complete',
      modified: 7,
    });
    const promoted = db
      .docs('property_attributes')
      .filter((entry) => PHASE9_PROMOTED_FACET_KEYS.includes(entry.key));
    expect(promoted).toHaveLength(7);
    for (const entry of promoted) expect(entry.facetKey).toBe(entry.key);
    const before = snapshot(db, 'property_attributes');
    expect((await runner(db, store).run(phase9FacetPromotionMigration, 'apply')).status).toBe(
      'skipped-complete',
    );
    expect(
      await runner(db, completed('029-phase8-attribute-registry')).run(
        phase9FacetPromotionMigration,
        'apply',
      ),
    ).toMatchObject({
      status: 'complete',
      modified: 0,
      preflight: { eligible: 0, alreadyApplied: 7 },
    });
    expect(snapshot(db, 'property_attributes')).toBe(before);
    expect(writesTo(db)).toEqual(['property_attributes']);
  });
  it('leaves the 10 presentation-only Phase 8 attributes with facetKey absent', async () => {
    const db = seedPhase8Registry(new MemoryDb());
    await runner(db, completed('029-phase8-attribute-registry')).run(
      phase9FacetPromotionMigration,
      'apply',
    );
    for (const key of NON_PROMOTED_PHASE8_KEYS) {
      expect(
        db.docs('property_attributes').find((entry) => entry.key === key).facetKey,
      ).toBeUndefined();
    }
  });
  it('never touches any identity field (dataType/unit/options/hardBounds) on a promoted entry', async () => {
    const db = seedPhase8Registry(new MemoryDb());
    const before = db.docs('property_attributes').find((entry) => entry.key === 'shopFloorLevel');
    const { facetKey: _omit, ...beforeIdentity } = before;
    await runner(db, completed('029-phase8-attribute-registry')).run(
      phase9FacetPromotionMigration,
      'apply',
    );
    const after = db.docs('property_attributes').find((entry) => entry.key === 'shopFloorLevel');
    const { facetKey: _omit2, ...afterIdentity } = after;
    expect(afterIdentity).toEqual(beforeIdentity);
    expect(after.facetKey).toBe('shopFloorLevel');
  });
  it('never touches unrelated (legacy or non-promoted Phase 8) registry entries', async () => {
    const db = seedPhase8Registry(new MemoryDb());
    const beforeByKey = new Map(
      db.docs('property_attributes').map((entry) => [entry.key, JSON.stringify(entry)]),
    );
    await runner(db, completed('029-phase8-attribute-registry')).run(
      phase9FacetPromotionMigration,
      'apply',
    );
    for (const key of NON_PROMOTED_PHASE8_KEYS) {
      const currentEntry = db.docs('property_attributes').find((entry) => entry.key === key);
      expect(JSON.stringify(currentEntry)).toBe(beforeByKey.get(key));
    }
  });
  it('compatible rerun: an entry whose facetKey already equals its own key is left untouched and counted as already applied', async () => {
    const db = seedPhase8Registry(new MemoryDb());
    db.docs('property_attributes').find((entry) => entry.key === 'soilType').facetKey = 'soilType';
    const result = await runner(db, completed('029-phase8-attribute-registry')).run(
      phase9FacetPromotionMigration,
      'apply',
    );
    expect(result).toMatchObject({
      status: 'complete',
      modified: 6,
      preflight: { eligible: 6, alreadyApplied: 1 },
    });
    expect(db.docs('property_attributes').find((entry) => entry.key === 'soilType').facetKey).toBe(
      'soilType',
    );
  });
  it('fails closed on an incompatible existing facetKey (never overwrites it)', async () => {
    const db = seedPhase8Registry(new MemoryDb());
    db.docs('property_attributes').find((entry) => entry.key === 'waterSource').facetKey =
      'bedrooms';
    await expect(
      runner(db, completed('029-phase8-attribute-registry')).run(
        phase9FacetPromotionMigration,
        'apply',
      ),
    ).rejects.toThrow(/PROPERTY_ATTRIBUTE_FACET_KEY_CONFLICT/);
    expect(
      db.docs('property_attributes').find((entry) => entry.key === 'waterSource').facetKey,
    ).toBe('bedrooms');
  });
  it('validate() fails while any approved key remains unpromoted or missing', async () => {
    const db = seedPhase8Registry(new MemoryDb());
    const scanned = await phase9FacetPromotionMigration.preflight({
      db: db,
      runId: 'r',
      batchSize: 250,
    });
    expect(scanned.summary).toMatchObject({ eligible: PHASE9_PROMOTED_FACET_KEYS });
    const validationBefore = await phase9FacetPromotionMigration.validate({
      db: db,
      runId: 'r',
      batchSize: 250,
    });
    expect(validationBefore.valid).toBe(false);
    await runner(db, completed('029-phase8-attribute-registry')).run(
      phase9FacetPromotionMigration,
      'apply',
    );
    const validationAfter = await phase9FacetPromotionMigration.validate({
      db: db,
      runId: 'r',
      batchSize: 250,
    });
    expect(validationAfter.valid).toBe(true);
  });
});
