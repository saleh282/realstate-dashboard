import { ObjectId } from 'mongodb';
import { phase8AttributeRegistryMigration, propertyAttributeRegistryMigration } from '../src/migrations/framework/core-migrations';
import { MigrationRunner } from '../src/migrations/framework/migration.runner';
import { phase8RegistryDocument, PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED } from '../src/migrations/029-non-residential-attribute-registry';
import { registryDocument } from '../src/migrations/025-property-form-foundation';
import { LEGACY_PROPERTY_ATTRIBUTE_SEED } from '../src/property-attributes/property-attribute.constants';
import { MemoryDb, MemoryStore } from './support/memory-mongo';

/** DPF-044 (Phase 8): the shop/factory/agricultural_land Attribute Registry seed (029). */
const oid = (n: number) => new ObjectId(`64c00000000000000000${String(n).padStart(4, '0')}`);
const snapshot = (db: MemoryDb, name: string) => JSON.stringify(db.docs(name));
const writesTo = (db: MemoryDb) => [...new Set(db.writes.map((write) => write.collection))].sort();
const runner = (db: MemoryDb, store = new MemoryStore(), batchSize = 250) => new MigrationRunner(db as any, store, { batchSize });
const completed = (...ids: string[]) => { const store = new MemoryStore(); for (const id of ids) store.markComplete(id); return store; };

const byKey = (key: string) => PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.find((seed) => seed.key === key)!;

describe('Phase 8 M-A registry seed (029-phase8-attribute-registry)', () => {
  it('dry-runs, inserts exactly the 17 approved non-residential registry entries, and is idempotent', async () => {
    const db = new MemoryDb();
    const dryRun = await runner(db).run(phase8AttributeRegistryMigration, 'dry-run');
    expect(dryRun.preflight).toMatchObject({ eligible: 17, alreadyApplied: 0, blockers: [] });
    expect(db.writes).toEqual([]);

    const store = completed('025-property-attribute-registry');
    expect(await runner(db, store).run(phase8AttributeRegistryMigration, 'apply')).toMatchObject({ status: 'complete', modified: 17 });
    const stored = db.docs('property_attributes');
    expect(stored.map((entry) => entry.key).sort()).toEqual([...PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.map((seed) => seed.key)].sort());
    for (const entry of stored) {
      const expected = phase8RegistryDocument(byKey(entry.key), entry.createdAt);
      expect({ ...entry, _id: undefined }).toEqual({ ...expected, _id: undefined });
    }
    expect(writesTo(db)).toEqual(['property_attributes']);

    const before = snapshot(db, 'property_attributes');
    expect((await runner(db, store).run(phase8AttributeRegistryMigration, 'apply')).status).toBe('skipped-complete');
    expect(await runner(db, completed('025-property-attribute-registry')).run(phase8AttributeRegistryMigration, 'apply')).toMatchObject({ status: 'complete', modified: 0, preflight: { eligible: 0, alreadyApplied: 17 } });
    expect(snapshot(db, 'property_attributes')).toBe(before);
  });

  it('never modifies an existing key: a relabelled entry is kept, an identity conflict blocks', async () => {
    const relabelled = { _id: oid(10), ...phase8RegistryDocument(byKey('shopFloorLevel'), new Date('2026-01-01')), labelAr: 'دور المحل' };
    const db = new MemoryDb().seed('property_attributes', [relabelled]);
    await runner(db, completed('025-property-attribute-registry')).run(phase8AttributeRegistryMigration, 'apply');
    expect(db.docs('property_attributes').find((entry) => entry.key === 'shopFloorLevel')!.labelAr).toBe('دور المحل');

    const conflicting = new MemoryDb().seed('property_attributes', [{ ...relabelled, dataType: 'text' }]);
    await expect(runner(conflicting, completed('025-property-attribute-registry')).run(phase8AttributeRegistryMigration, 'apply')).rejects.toThrow(/PROPERTY_ATTRIBUTE_SEED_CONFLICT/);
    expect(conflicting.docs('property_attributes')).toHaveLength(1);
  });

  it('flags a conflict when an existing entry has the same identity but a different option set', async () => {
    const stale = { _id: oid(11), ...phase8RegistryDocument(byKey('powerSource'), new Date('2026-01-01')), options: [{ code: 'grid', labelAr: 'كهرباء عامة', labelEn: 'Grid Power', status: 'active' }] };
    const db = new MemoryDb().seed('property_attributes', [stale]);
    await expect(runner(db, completed('025-property-attribute-registry')).run(phase8AttributeRegistryMigration, 'apply')).rejects.toThrow(/PROPERTY_ATTRIBUTE_SEED_CONFLICT/);
  });

  it('sets each field dataType/unit/optionSource exactly as approved, with no facetKey (no Phase 8 search promotion)', () => {
    expect(byKey('shopFloorLevel')).toMatchObject({ dataType: 'singleSelect' });
    expect(phase8RegistryDocument(byKey('shopFloorLevel'), new Date())).toMatchObject({ optionSource: 'inline' });
    expect(phase8RegistryDocument(byKey('frontageWidthM'), new Date())).toMatchObject({ dataType: 'decimal', unit: 'm' });
    expect(phase8RegistryDocument(byKey('builtAreaSqm'), new Date())).toMatchObject({ dataType: 'decimal', unit: 'sqm' });
    expect(phase8RegistryDocument(byKey('electricalCapacityKw'), new Date())).toMatchObject({ dataType: 'decimal', unit: 'kw' });
    expect(phase8RegistryDocument(byKey('hasStorefront'), new Date())).toMatchObject({ dataType: 'boolean' });
    expect(phase8RegistryDocument(byKey('commercialUseTypes'), new Date())).toMatchObject({ dataType: 'multiSelect', optionSource: 'inline' });
    for (const seed of PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED) {
      expect((phase8RegistryDocument(seed, new Date()) as any).facetKey).toBeUndefined();
    }
    expect(PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED).toHaveLength(17);
  });

  it('applies each approved inline option set exactly, with human labels (never raw codes as labels)', () => {
    const shopUses = phase8RegistryDocument(byKey('commercialUseTypes'), new Date()).options as Array<{ code: string; labelAr: string; labelEn: string }>;
    expect(shopUses.map((option) => option.code)).toEqual(['retail', 'food', 'pharmacy', 'services', 'showroom', 'other']);
    for (const option of shopUses) {
      expect(option.labelAr).not.toBe(option.code);
      expect(option.labelEn).not.toBe(option.code);
    }
    const soil = phase8RegistryDocument(byKey('soilType'), new Date()).options as Array<{ code: string }>;
    expect(soil.map((option) => option.code)).toEqual(['clay', 'sandy', 'loamy', 'mixed', 'other']);
    const water = phase8RegistryDocument(byKey('waterSource'), new Date()).options as Array<{ code: string }>;
    expect(water.map((option) => option.code)).toEqual(['well', 'canal', 'municipal', 'none']);
  });

  it('applies broad, non-restrictive hard bounds on numeric fields and a maxItems ceiling equal to each multiSelect option count', () => {
    expect(byKey('frontageWidthM').hardBounds).toEqual({ min: 0, max: 1000, scale: 2 });
    expect(byKey('builtAreaSqm').hardBounds).toEqual({ min: 0, max: 1_000_000, scale: 2 });
    expect(byKey('ceilingHeightM').hardBounds).toEqual({ min: 0, max: 1000, scale: 2 });
    expect(byKey('electricalCapacityKw').hardBounds).toEqual({ min: 0, max: 100_000, scale: 2 });
    expect(byKey('roadFrontageM').hardBounds).toEqual({ min: 0, max: 1000, scale: 2 });
    expect(byKey('commercialUseTypes').hardBounds).toEqual({ maxItems: 6 });
    expect(byKey('irrigationTypes').hardBounds).toEqual({ maxItems: 5 });
    expect(byKey('hasStorefront').hardBounds).toEqual({});
  });

  it('depends on 025-property-attribute-registry and does not require the legacy definitions migration', () => {
    expect(phase8AttributeRegistryMigration.dependencies).toEqual(['025-property-attribute-registry']);
  });

  it('runs cleanly after the legacy M-A seed has already applied, without touching legacy keys', async () => {
    const db = new MemoryDb();
    await runner(db, completed()).run(propertyAttributeRegistryMigration, 'apply');
    const store = completed('025-property-attribute-registry');
    await runner(db, store).run(phase8AttributeRegistryMigration, 'apply');
    const stored = db.docs('property_attributes');
    expect(stored).toHaveLength(9 + 17);
    for (const legacySeed of LEGACY_PROPERTY_ATTRIBUTE_SEED) {
      const entry = stored.find((doc) => doc.key === legacySeed.key)!;
      expect({ ...entry, _id: undefined }).toEqual({ ...registryDocument(legacySeed, entry.createdAt), _id: undefined });
    }
  });
});
