'use strict';

const { ObjectId } = require('mongodb');
const {
  phase8AttributeRegistryMigration,
  phase10UnitFloorLevelRegistryMigration,
  propertyAttributeRegistryMigration,
} = require('../src/migrations/framework/core-migrations');
const { MigrationRunner } = require('../src/migrations/framework/migration.runner');
const {
  PHASE10_NEW_ATTRIBUTE_SEED,
  phase10RegistryDocument,
} = require('../src/migrations/032-phase10-unit-floor-level-registry');
const {
  phase8RegistryDocument,
  PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED,
} = require('../src/migrations/029-non-residential-attribute-registry');
const { registryDocument } = require('../src/migrations/025-property-form-foundation');
const {
  LEGACY_PROPERTY_ATTRIBUTE_SEED,
} = require('../src/domain/property-attributes/property-attribute.constants');
const { MemoryDb, MemoryStore } = require('./support/memory-mongo');
/** Phase 10: the `unitFloorLevel` Attribute Registry seed (032). */
const oid = (n) => new ObjectId(`64d00000000000000000${String(n).padStart(4, '0')}`);
const snapshot = (db, name) => JSON.stringify(db.docs(name));
const writesTo = (db) => [...new Set(db.writes.map((write) => write.collection))].sort();
const runner = (db, store = new MemoryStore(), batchSize = 250) =>
  new MigrationRunner(db, store, { batchSize });
const completed = (...ids) => {
  const store = new MemoryStore();
  for (const id of ids) store.markComplete(id);
  return store;
};
const seed = PHASE10_NEW_ATTRIBUTE_SEED[0];
describe('Phase 10 unitFloorLevel registry seed (032-phase10-unit-floor-level-registry)', () => {
  it('dry-runs, inserts exactly the 1 approved entry, and is idempotent', async () => {
    const db = new MemoryDb();
    const dryRun = await runner(db).run(phase10UnitFloorLevelRegistryMigration, 'dry-run');
    expect(dryRun.preflight).toMatchObject({ eligible: 1, alreadyApplied: 0, blockers: [] });
    expect(db.writes).toEqual([]);
    const store = completed('029-phase8-attribute-registry');
    expect(
      await runner(db, store).run(phase10UnitFloorLevelRegistryMigration, 'apply'),
    ).toMatchObject({ status: 'complete', modified: 1 });
    const stored = db.docs('property_attributes');
    expect(stored.map((entry) => entry.key)).toEqual(['unitFloorLevel']);
    const expected = phase10RegistryDocument(seed, stored[0].createdAt);
    expect({ ...stored[0], _id: undefined }).toEqual({ ...expected, _id: undefined });
    expect(writesTo(db)).toEqual(['property_attributes']);
    const before = snapshot(db, 'property_attributes');
    expect(
      (await runner(db, store).run(phase10UnitFloorLevelRegistryMigration, 'apply')).status,
    ).toBe('skipped-complete');
    expect(
      await runner(db, completed('029-phase8-attribute-registry')).run(
        phase10UnitFloorLevelRegistryMigration,
        'apply',
      ),
    ).toMatchObject({
      status: 'complete',
      modified: 0,
      preflight: { eligible: 0, alreadyApplied: 1 },
    });
    expect(snapshot(db, 'property_attributes')).toBe(before);
  });
  it('never modifies an existing key: a relabelled entry is kept, an identity conflict blocks', async () => {
    const relabelled = {
      _id: oid(10),
      ...phase10RegistryDocument(seed, new Date('2026-01-01')),
      labelAr: 'مستوى مختلف',
    };
    const db = new MemoryDb().seed('property_attributes', [relabelled]);
    await runner(db, completed('029-phase8-attribute-registry')).run(
      phase10UnitFloorLevelRegistryMigration,
      'apply',
    );
    expect(
      db.docs('property_attributes').find((entry) => entry.key === 'unitFloorLevel').labelAr,
    ).toBe('مستوى مختلف');
    const conflicting = new MemoryDb().seed('property_attributes', [
      { ...relabelled, dataType: 'text' },
    ]);
    await expect(
      runner(conflicting, completed('029-phase8-attribute-registry')).run(
        phase10UnitFloorLevelRegistryMigration,
        'apply',
      ),
    ).rejects.toThrow(/PROPERTY_ATTRIBUTE_SEED_CONFLICT/);
    expect(conflicting.docs('property_attributes')).toHaveLength(1);
  });
  it('flags a conflict when an existing entry has the same identity but a different option set', async () => {
    const stale = {
      _id: oid(11),
      ...phase10RegistryDocument(seed, new Date('2026-01-01')),
      options: [
        { code: 'ground', labelAr: 'الدور الأرضي', labelEn: 'Ground Floor', status: 'active' },
      ],
    };
    const db = new MemoryDb().seed('property_attributes', [stale]);
    await expect(
      runner(db, completed('029-phase8-attribute-registry')).run(
        phase10UnitFloorLevelRegistryMigration,
        'apply',
      ),
    ).rejects.toThrow(/PROPERTY_ATTRIBUTE_SEED_CONFLICT/);
  });
  it('sets dataType/optionSource exactly as approved, with no facetKey (no Phase 10 search promotion) and no unit', () => {
    expect(seed).toMatchObject({ key: 'unitFloorLevel', dataType: 'singleSelect' });
    const document = phase10RegistryDocument(seed, new Date());
    expect(document).toMatchObject({ optionSource: 'inline' });
    expect(document.facetKey).toBeUndefined();
    expect(document.unit).toBeUndefined();
    expect(PHASE10_NEW_ATTRIBUTE_SEED).toHaveLength(1);
  });
  it('applies the approved option set exactly, with professional human labels (never raw codes as labels) and deterministic order', () => {
    const document = phase10RegistryDocument(seed, new Date());
    const options = document.options;
    expect(options.map((option) => option.code)).toEqual([
      'ground',
      'basement',
      'mezzanine',
      'upper',
    ]);
    expect(options).toEqual([
      { code: 'ground', labelAr: 'الدور الأرضي', labelEn: 'Ground Floor', status: 'active' },
      { code: 'basement', labelAr: 'البدروم', labelEn: 'Basement', status: 'active' },
      { code: 'mezzanine', labelAr: 'الميزانين', labelEn: 'Mezzanine', status: 'active' },
      { code: 'upper', labelAr: 'دور علوي', labelEn: 'Upper Floor', status: 'active' },
    ]);
    for (const option of options) {
      expect(option.labelAr).not.toBe(option.code);
      expect(option.labelEn).not.toBe(option.code);
    }
    expect(document.labelAr).toBe('مستوى الوحدة');
    expect(document.labelEn).toBe('Unit Floor Level');
  });
  it('depends on 029-phase8-attribute-registry and does not require the Phase 9 migrations', () => {
    expect(phase10UnitFloorLevelRegistryMigration.dependencies).toEqual([
      '029-phase8-attribute-registry',
    ]);
  });
  it('coexists with the legacy (9) and Phase 8 (17) registry entries without touching them: 27 total', async () => {
    const db = new MemoryDb();
    await runner(db, completed()).run(propertyAttributeRegistryMigration, 'apply');
    await runner(db, completed('025-property-attribute-registry')).run(
      phase8AttributeRegistryMigration,
      'apply',
    );
    const store = completed('025-property-attribute-registry', '029-phase8-attribute-registry');
    await runner(db, store).run(phase10UnitFloorLevelRegistryMigration, 'apply');
    const stored = db.docs('property_attributes');
    expect(stored).toHaveLength(9 + 17 + 1);
    for (const legacySeed of LEGACY_PROPERTY_ATTRIBUTE_SEED) {
      const entry = stored.find((doc) => doc.key === legacySeed.key);
      expect({ ...entry, _id: undefined }).toEqual({
        ...registryDocument(legacySeed, entry.createdAt),
        _id: undefined,
      });
    }
    for (const phase8Seed of PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED) {
      const entry = stored.find((doc) => doc.key === phase8Seed.key);
      expect({ ...entry, _id: undefined }).toEqual({
        ...phase8RegistryDocument(phase8Seed, entry.createdAt),
        _id: undefined,
      });
    }
    const unitFloorLevel = stored.find((doc) => doc.key === 'unitFloorLevel');
    expect(unitFloorLevel.facetKey).toBeUndefined();
  });
});
