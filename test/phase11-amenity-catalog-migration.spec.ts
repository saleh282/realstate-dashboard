import { ObjectId } from 'mongodb';
import { phase11AmenityCatalogMigration } from '../src/migrations/framework/core-migrations';
import { MigrationRunner } from '../src/migrations/framework/migration.runner';
import {
  PHASE11_NEW_AMENITY_SEED,
  PHASE11_PRE_EXISTING_AMENITY_CODES,
  phase11AmenityDocument,
} from '../src/migrations/033-phase11-amenity-catalog';
import { MemoryDb, MemoryStore } from './support/memory-mongo';

/** Phase 11: the 5 new amenity catalog entries seed (033-phase11-amenity-catalog). */
const superAdminId = new ObjectId('64e0000000000000000000a1');
const snapshot = (db: MemoryDb, name: string) => JSON.stringify(db.docs(name));
const writesTo = (db: MemoryDb) => [...new Set(db.writes.map((write) => write.collection))].sort();
const runner = (db: MemoryDb, store = new MemoryStore(), batchSize = 250) => new MigrationRunner(db as any, store, { batchSize });

const withSuperAdmin = () => new MemoryDb().seed('users', [{ _id: superAdminId, systemRole: 'SUPER_ADMIN' }]);
const existingCatalog = () => PHASE11_PRE_EXISTING_AMENITY_CODES.map((code, index) => ({
  _id: new ObjectId(), code, nameAr: `اسم ${code}`, nameEn: code, iconKey: code, category: 'feature', isActive: true, sortOrder: index + 1, usageCount: 0,
}));

describe('Phase 11 amenity catalog seed (033-phase11-amenity-catalog)', () => {
  it('dry-runs, inserts exactly the 5 approved entries, and is idempotent', async () => {
    const db = withSuperAdmin().seed('amenities', existingCatalog());
    const dryRun = await runner(db).run(phase11AmenityCatalogMigration, 'dry-run');
    expect(dryRun.preflight).toMatchObject({ eligible: 5, alreadyApplied: 0, blockers: [] });
    expect(db.writes).toEqual([]);

    expect(await runner(db).run(phase11AmenityCatalogMigration, 'apply')).toMatchObject({ status: 'complete', modified: 5 });
    const stored = db.docs('amenities');
    const newCodes = stored.filter((doc) => PHASE11_NEW_AMENITY_SEED.some((seed) => seed.code === doc.code)).map((doc) => doc.code).sort();
    expect(newCodes).toEqual([...PHASE11_NEW_AMENITY_SEED.map((seed) => seed.code)].sort());
    expect(writesTo(db)).toEqual(['amenities']);
    // The 7 pre-existing amenities are untouched, exactly as seeded.
    expect(stored.filter((doc) => PHASE11_PRE_EXISTING_AMENITY_CODES.includes(doc.code))).toHaveLength(7);

    const before = snapshot(db, 'amenities');
    const store = new MemoryStore();
    store.markComplete('033-phase11-amenity-catalog');
    expect((await runner(db, store).run(phase11AmenityCatalogMigration, 'apply')).status).toBe('skipped-complete');
    expect(await runner(db).run(phase11AmenityCatalogMigration, 'apply')).toMatchObject({ status: 'complete', modified: 0, preflight: { eligible: 0, alreadyApplied: 5 } });
    expect(snapshot(db, 'amenities')).toBe(before);
  });

  it('never modifies an existing amenity code: identical re-seed is a no-op, an identity conflict blocks', async () => {
    const seeded = PHASE11_NEW_AMENITY_SEED.map((seed) => ({ _id: new ObjectId(), ...phase11AmenityDocument(seed, superAdminId, new Date('2026-01-01')) }));
    const db = withSuperAdmin().seed('amenities', [...existingCatalog(), ...seeded]);
    const result = await runner(db).run(phase11AmenityCatalogMigration, 'apply');
    // Upsert attempts happen (idempotent $setOnInsert), but nothing is actually inserted or changed.
    expect(result).toMatchObject({ modified: 0 });
    expect(db.docs('amenities')).toHaveLength(7 + 5);
    expect(db.docs('amenities').filter((doc) => PHASE11_NEW_AMENITY_SEED.some((seed) => seed.code === doc.code))).toEqual(seeded);

    const conflicting = withSuperAdmin().seed('amenities', [...existingCatalog(), { ...seeded[0], nameAr: 'اسم مختلف تماما' }]);
    await expect(runner(conflicting).run(phase11AmenityCatalogMigration, 'apply')).rejects.toThrow(/AMENITY_SEED_CONFLICT/);
    expect(conflicting.docs('amenities')).toHaveLength(1 + 7);
  });

  it('blocks (never writes) when no SUPER_ADMIN exists, even in dry-run', async () => {
    const db = new MemoryDb();
    await expect(runner(db).run(phase11AmenityCatalogMigration, 'dry-run')).rejects.toThrow(/AMENITY_SEED_NO_SUPER_ADMIN/);
    expect(db.writes).toEqual([]);
  });

  it('has no ledger dependency (additive, independent of the attribute-registry migrations)', () => {
    expect(phase11AmenityCatalogMigration.dependencies).toEqual([]);
  });

  it('seeds exactly the 5 approved amenities with the exact approved names, icon keys and categories', async () => {
    const db = withSuperAdmin().seed('amenities', existingCatalog());
    await runner(db).run(phase11AmenityCatalogMigration, 'apply');
    const stored = db.docs('amenities');
    const byCode = new Map(stored.map((doc) => [doc.code, doc]));
    expect(byCode.get('fire_safety')).toMatchObject({ nameAr: 'أنظمة السلامة ومكافحة الحريق', nameEn: 'Fire Safety', iconKey: 'fire_safety', category: 'feature', isActive: true, usageCount: 0 });
    expect(byCode.get('accessibility')).toMatchObject({ nameAr: 'سهولة الوصول لذوي الإعاقة', nameEn: 'Accessibility', iconKey: 'accessibility', category: 'feature', isActive: true, usageCount: 0 });
    expect(byCode.get('storage_yard')).toMatchObject({ nameAr: 'ساحة تخزين', nameEn: 'Storage Yard', iconKey: 'storage_yard', category: 'facility', isActive: true, usageCount: 0 });
    expect(byCode.get('fenced')).toMatchObject({ nameAr: 'مسوّر', nameEn: 'Fenced', iconKey: 'fenced', category: 'feature', isActive: true, usageCount: 0 });
    expect(byCode.get('drainage')).toMatchObject({ nameAr: 'نظام صرف', nameEn: 'Drainage', iconKey: 'drainage', category: 'feature', isActive: true, usageCount: 0 });
    // None of the forbidden, attribute-duplicating codes were ever introduced.
    for (const forbidden of ['loading_dock', 'truck_access', 'three_phase_power', 'electricity', 'water_connection', 'irrigation', 'road_access']) {
      expect(byCode.has(forbidden)).toBe(false);
    }
  });

  it('is a no-destructive-write migration: rollback is documented as "none", never automatic', () => {
    expect(phase11AmenityCatalogMigration.rollback.kind).toBe('none');
  });
});
