import { ObjectId } from 'mongodb';
import { selectMigrations } from '../src/migrations/cli';
import {
  CORE_MIGRATIONS,
  legacyPropertyDataReportMigration,
  legacyPropertyFormDefinitionsMigration,
  propertyAreaBackfillMigration,
  propertyAttributeRegistryMigration,
  validateMigrationRegistry,
} from '../src/migrations/framework/core-migrations';
import { MigrationRunner } from '../src/migrations/framework/migration.runner';
import { registryDocument, storedContentHash } from '../src/migrations/025-property-form-foundation';
import { LEGACY_PROPERTY_ATTRIBUTE_SEED } from '../src/property-attributes/property-attribute.constants';
import { LEGACY_RESIDENTIAL_CONTENT, LEGACY_RESIDENTIAL_CONTENT_HASH } from '../src/property-form-definitions/property-form-definition.constants';
import { MemoryDb, MemoryStore, type Doc } from './support/memory-mongo';

/** DPF-013/014 migrations M-A..M-D through the real MigrationRunner. */
const oid = (n: number) => new ObjectId(`64c00000000000000000${String(n).padStart(4, '0')}`);
const snapshot = (db: MemoryDb, name: string) => JSON.stringify(db.docs(name));
const writesTo = (db: MemoryDb) => [...new Set(db.writes.map((write) => write.collection))].sort();
const runner = (db: MemoryDb, store = new MemoryStore(), batchSize = 250) => new MigrationRunner(db as any, store, { batchSize });
const completed = (...ids: string[]) => { const store = new MemoryStore(); for (const id of ids) store.markComplete(id); return store; };

describe('DPF-013 M-A registry seed (025-property-attribute-registry)', () => {
  it('dry-runs, inserts exactly the legacy registry entries with their unique key index, and is idempotent', async () => {
    const db = new MemoryDb().seed('properties', [{ _id: oid(1), area: 1 }]).seed('property_revisions', [{ _id: oid(2) }]);
    const dryRun = await runner(db).run(propertyAttributeRegistryMigration, 'dry-run');
    expect(dryRun.preflight).toMatchObject({ eligible: 9, alreadyApplied: 0, blockers: [] });
    expect(db.writes).toEqual([]);

    const store = new MemoryStore();
    expect(await runner(db, store).run(propertyAttributeRegistryMigration, 'apply')).toMatchObject({ status: 'complete', modified: 9 });
    const stored = db.docs('property_attributes');
    expect(stored.map((entry) => entry.key)).toEqual(LEGACY_PROPERTY_ATTRIBUTE_SEED.map((seed) => seed.key));
    for (const entry of stored) {
      const expected = registryDocument(LEGACY_PROPERTY_ATTRIBUTE_SEED.find((seed) => seed.key === entry.key)!, entry.createdAt);
      expect({ ...entry, _id: undefined }).toEqual({ ...expected, _id: undefined });
    }
    expect(stored.find((entry) => entry.key === 'finishingStatus')).toMatchObject({ dataType: 'singleSelect', optionSource: 'catalog', catalogGroup: 'finishing_status' });
    expect(stored.find((entry) => entry.key === 'bedrooms')).toMatchObject({ dataType: 'integer', hardBounds: { min: 0, max: 100 }, facetKey: 'bedrooms' });
    expect(db.indexes.get('property_attributes')).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'key_1', key: { key: 1 }, unique: true })]));
    expect(writesTo(db)).toEqual(['property_attributes']);

    const before = snapshot(db, 'property_attributes');
    expect((await runner(db, store).run(propertyAttributeRegistryMigration, 'apply')).status).toBe('skipped-complete');
    expect(await runner(db).run(propertyAttributeRegistryMigration, 'apply')).toMatchObject({ status: 'complete', modified: 0, preflight: { eligible: 0, alreadyApplied: 9 } });
    expect(snapshot(db, 'property_attributes')).toBe(before);
  });

  it('never modifies an existing key: a relabelled entry is kept, an identity conflict blocks', async () => {
    const relabelled = { _id: oid(10), ...registryDocument(LEGACY_PROPERTY_ATTRIBUTE_SEED[0], new Date('2026-01-01')), labelAr: 'عدد الغرف' };
    const db = new MemoryDb().seed('property_attributes', [relabelled]);
    await runner(db).run(propertyAttributeRegistryMigration, 'apply');
    expect(db.docs('property_attributes').find((entry) => entry.key === 'bedrooms')!.labelAr).toBe('عدد الغرف');

    const conflicting = new MemoryDb().seed('property_attributes', [{ ...relabelled, dataType: 'decimal' }]);
    await expect(runner(conflicting).run(propertyAttributeRegistryMigration, 'apply')).rejects.toThrow(/PROPERTY_ATTRIBUTE_SEED_CONFLICT/);
    expect(conflicting.docs('property_attributes')).toHaveLength(1);
  });
});

describe('DPF-013 M-B legacy definitions (026-legacy-property-form-definitions)', () => {
  const RESIDENTIAL = oid(900);
  const COMMERCIAL = oid(901);
  const INDUSTRIAL = oid(902);
  const AGRICULTURAL = oid(903);
  const adminHeadId = oid(800);
  const purposeCategories = [
    { _id: RESIDENTIAL, code: 'residential', nameAr: 'سكني' },
    { _id: COMMERCIAL, code: 'commercial', nameAr: 'تجاري' },
  ];
  const legacyDb = () => new MemoryDb()
    .seed('property_purpose_categories', purposeCategories)
    .seed('property_types', [
      { _id: oid(101), code: 'apartment', isActive: true, purposeCategoryId: RESIDENTIAL },
      { _id: oid(102), code: 'old_type', isActive: false, purposeCategoryId: RESIDENTIAL },
      { _id: oid(103), code: 'unmapped', isActive: true }, // no purposeCategoryId at all: not residential
      { _id: oid(104), code: 'admin_managed', isActive: true, purposeCategoryId: RESIDENTIAL },
      { _id: oid(105), code: 'shop', isActive: true, purposeCategoryId: COMMERCIAL },
    ])
    .seed('property_form_definitions', [{ _id: adminHeadId, purposeSubcategoryId: oid(104), status: 'active', currentVersionId: oid(801), currentVersion: 3, nextVersionNumber: 4, version: 7, createdBy: oid(1) }])
    .seed('properties', [{ _id: oid(500), purposeSubcategoryId: oid(101) }])
    .seed('property_revisions', [{ _id: oid(600), purposeSubcategoryId: oid(101) }]);
  const withRegistry = async (db: MemoryDb) => { await runner(db).run(propertyAttributeRegistryMigration, 'apply'); db.writes.length = 0; return db; };

  it('requires M-A: its registry keys must exist', async () => {
    await expect(runner(legacyDb()).run(legacyPropertyFormDefinitionsMigration, 'apply')).rejects.toThrow(/Dependency 025-property-attribute-registry is not complete/);
    await expect(runner(legacyDb(), completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply')).rejects.toThrow(/PROPERTY_ATTRIBUTE_REGISTRY_INCOMPLETE/);
  });

  it('creates a head plus an identical published legacy v1 for every RESIDENTIAL type without one, and leaves every non-residential type (mapped or not) formless', async () => {
    const db = await withRegistry(legacyDb());
    const dryRun = await runner(db).run(legacyPropertyFormDefinitionsMigration, 'dry-run');
    expect(dryRun.preflight).toMatchObject({ eligible: 2, alreadyApplied: 3, blockers: [], summary: { propertyTypes: 5, residentialTypes: 3, legacyContentHash: LEGACY_RESIDENTIAL_CONTENT_HASH } });
    expect(db.writes).toEqual([]);

    const report = await runner(db, completed('025-property-attribute-registry'), 2).run(legacyPropertyFormDefinitionsMigration, 'apply');
    expect(report).toMatchObject({ status: 'complete', modified: 4, batches: 2 });
    const heads = db.docs('property_form_definitions');
    const versions = db.docs('property_form_definition_versions');
    // 1 pre-existing admin head (104) + 2 newly-seeded residential heads (101, 102). Neither
    // the purposeless type (103) nor the commercial type (105) ever get a head.
    expect(heads).toHaveLength(3);
    expect(versions).toHaveLength(2);
    for (const typeId of [oid(101), oid(102)]) {
      const head = heads.find((entry) => String(entry.purposeSubcategoryId) === String(typeId))!;
      const version = versions.find((entry) => String(entry._id) === String(head.currentVersionId))!;
      expect(head).toMatchObject({ status: 'active', currentVersion: 1, nextVersionNumber: 2, version: 1 });
      expect(head.createdBy).toBeUndefined();
      expect(version).toMatchObject({
        definitionId: head._id, purposeSubcategoryId: typeId, version: 1, state: 'published', mediaProfile: 'residential_rooms', amenitiesEnabled: true,
        rendererVersion: 1, legacyWritable: true, contentHash: LEGACY_RESIDENTIAL_CONTENT_HASH, draftRevision: 0,
      });
      expect(version.fields).toEqual(LEGACY_RESIDENTIAL_CONTENT.fields);
      expect(storedContentHash(version)).toBe(LEGACY_RESIDENTIAL_CONTENT_HASH);
    }
    expect(heads.find((head) => String(head.purposeSubcategoryId) === String(oid(103)))).toBeUndefined();
    expect(heads.find((head) => String(head.purposeSubcategoryId) === String(oid(105)))).toBeUndefined();
    expect(new Set(versions.map((version) => version.contentHash)).size).toBe(1);
    expect(heads.find((head) => String(head._id) === String(adminHeadId))).toMatchObject({ currentVersion: 3, version: 7 });
    expect(db.indexes.get('property_form_definitions')!.map((index) => index.name)).toEqual(expect.arrayContaining(['property_form_definition_subcategory_unique']));
    expect(db.indexes.get('property_form_definition_versions')!.map((index) => index.name)).toEqual(expect.arrayContaining([
      'property_form_version_number_unique', 'property_form_version_one_draft', 'property_form_version_one_published', 'property_form_version_subcategory_state',
    ]));
    expect(writesTo(db)).toEqual(['property_form_definition_versions', 'property_form_definitions']);

    const before = snapshot(db, 'property_form_definitions') + snapshot(db, 'property_form_definition_versions');
    expect(await runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply')).toMatchObject({ status: 'complete', modified: 0 });
    expect(snapshot(db, 'property_form_definitions') + snapshot(db, 'property_form_definition_versions')).toBe(before);
  });

  it('is inactive-agnostic: an inactive residential type is just as eligible as an active one (only purpose gates it)', async () => {
    const db = await withRegistry(legacyDb());
    await runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply');
    const oldTypeHead = db.docs('property_form_definitions').find((entry) => String(entry.purposeSubcategoryId) === String(oid(102)));
    expect(oldTypeHead).toBeDefined();
    expect(oldTypeHead).toMatchObject({ status: 'active', currentVersion: 1 });
  });

  it('resolves residential purely through the purpose relationship, never by type or purpose name/code text', async () => {
    // The COMMERCIAL purpose's nameAr is literally "تجاري" (Arabic for commercial) and its
    // code is "commercial" — nothing about it should ever be mistaken for residential text.
    const db = await withRegistry(legacyDb());
    await runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply');
    expect(db.docs('property_form_definitions').find((entry) => String(entry.purposeSubcategoryId) === String(oid(105)))).toBeUndefined();
  });

  it('treats a type with no purposeCategoryId at all as non-residential (never defaults it to residential)', async () => {
    const db = await withRegistry(legacyDb());
    const dryRun = await runner(db).run(legacyPropertyFormDefinitionsMigration, 'dry-run');
    expect((dryRun.preflight!.summary as Doc).residentialTypes).toBe(3); // 101, 102, 104 — never 103
    await runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply');
    expect(db.docs('property_form_definitions').find((entry) => String(entry.purposeSubcategoryId) === String(oid(103)))).toBeUndefined();
  });

  it('is a no-op on a residential-only database when every type already has its legacy form', async () => {
    const db = await withRegistry(new MemoryDb()
      .seed('property_purpose_categories', [{ _id: RESIDENTIAL, code: 'residential', nameAr: 'سكني' }])
      .seed('property_types', [
        { _id: oid(201), code: 'villa', isActive: true, purposeCategoryId: RESIDENTIAL },
        { _id: oid(202), code: 'studio', isActive: true, purposeCategoryId: RESIDENTIAL },
      ]));
    expect(await runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply')).toMatchObject({ status: 'complete', modified: 4 });
    const before = snapshot(db, 'property_form_definitions') + snapshot(db, 'property_form_definition_versions');
    expect(await runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply')).toMatchObject({ status: 'complete', modified: 0 });
    expect(snapshot(db, 'property_form_definitions') + snapshot(db, 'property_form_definition_versions')).toBe(before);
  });

  it('spans all four purposes: only the residential ones ever receive the legacy form', async () => {
    const db = await withRegistry(new MemoryDb()
      .seed('property_purpose_categories', [
        { _id: RESIDENTIAL, code: 'residential', nameAr: 'سكني' }, { _id: COMMERCIAL, code: 'commercial', nameAr: 'تجاري' },
        { _id: INDUSTRIAL, code: 'industrial', nameAr: 'صناعي' }, { _id: AGRICULTURAL, code: 'agricultural', nameAr: 'زراعي' },
      ])
      .seed('property_types', [
        { _id: oid(301), code: 'apartment', isActive: true, purposeCategoryId: RESIDENTIAL },
        { _id: oid(302), code: 'villa', isActive: true, purposeCategoryId: RESIDENTIAL },
        { _id: oid(303), code: 'shop', isActive: true, purposeCategoryId: COMMERCIAL },
        { _id: oid(304), code: 'factory', isActive: true, purposeCategoryId: INDUSTRIAL },
        { _id: oid(305), code: 'farm', isActive: true, purposeCategoryId: AGRICULTURAL },
      ]));
    await runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply');
    const seededFor = (typeId: any) => db.docs('property_form_definitions').find((entry) => String(entry.purposeSubcategoryId) === String(typeId));
    expect(seededFor(oid(301))).toBeDefined();
    expect(seededFor(oid(302))).toBeDefined();
    expect(seededFor(oid(303))).toBeUndefined();
    expect(seededFor(oid(304))).toBeUndefined();
    expect(seededFor(oid(305))).toBeUndefined();
    expect(db.docs('property_form_definitions')).toHaveLength(2);
  });

  it('never overwrites an existing NON-residential head/version, even one authored to look exactly like a seeded legacy v1', async () => {
    const realFactoryHead = { _id: oid(850), purposeSubcategoryId: oid(105), status: 'active', currentVersionId: oid(851), currentVersion: 1, nextVersionNumber: 2, version: 1, createdBy: oid(1) };
    const realFactoryVersion = { _id: oid(851), definitionId: oid(850), purposeSubcategoryId: oid(105), version: 1, state: 'published', mediaProfile: 'generic', amenitiesEnabled: true, fields: [{ key: 'deliveryStatus' }], contentHash: 'not-the-legacy-hash' };
    const db = await withRegistry(legacyDb()
      .seed('property_form_definitions', [
        { _id: adminHeadId, purposeSubcategoryId: oid(104), status: 'active', currentVersionId: oid(801), currentVersion: 3, nextVersionNumber: 4, version: 7, createdBy: oid(1) },
        realFactoryHead,
      ])
      .seed('property_form_definition_versions', [realFactoryVersion]));
    const before = JSON.stringify(realFactoryHead) + JSON.stringify(realFactoryVersion);
    const dryRun = await runner(db).run(legacyPropertyFormDefinitionsMigration, 'dry-run');
    expect(dryRun.preflight!.blockers).toEqual([]);
    await runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply');
    const headAfter = db.docs('property_form_definitions').find((entry) => String(entry._id) === String(oid(850)));
    const versionAfter = db.docs('property_form_definition_versions').find((entry) => String(entry._id) === String(oid(851)));
    expect(JSON.stringify(headAfter) + JSON.stringify(versionAfter)).toBe(before);
  });

  it('repairs an interrupted run with the head\'s own version id, orphaning nothing', async () => {
    const db = await withRegistry(legacyDb());
    await runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply');
    const head = db.docs('property_form_definitions').find((entry) => String(entry.purposeSubcategoryId) === String(oid(101)))!;
    db.data.set('property_form_definition_versions', db.docs('property_form_definition_versions').filter((version) => String(version._id) !== String(head.currentVersionId)));
    await expect(runner(db).run(legacyPropertyFormDefinitionsMigration, 'dry-run')).resolves.toMatchObject({ preflight: { eligible: 1 } });
    expect(await runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply')).toMatchObject({ status: 'complete', modified: 1 });
    expect(db.docs('property_form_definition_versions').find((version) => String(version._id) === String(head.currentVersionId))).toMatchObject({ definitionId: head._id, contentHash: LEGACY_RESIDENTIAL_CONTENT_HASH });
    expect(db.docs('property_form_definition_versions')).toHaveLength(2);
  });

  it('never writes the legacy form into a head an Admin authored, even one shaped like a seeded v1', async () => {
    const db = await withRegistry(new MemoryDb()
      .seed('property_purpose_categories', [{ _id: RESIDENTIAL, code: 'residential', nameAr: 'سكني' }])
      .seed('property_types', [{ _id: oid(101), code: 'apartment', isActive: true, purposeCategoryId: RESIDENTIAL }])
      .seed('property_form_definitions', [{ _id: oid(810), purposeSubcategoryId: oid(101), status: 'active', currentVersionId: oid(811), currentVersion: 1, nextVersionNumber: 2, version: 1, createdBy: oid(1) }]));
    await expect(runner(db).run(legacyPropertyFormDefinitionsMigration, 'dry-run')).resolves.toMatchObject({ preflight: { eligible: 0, alreadyApplied: 1 } });
    expect(await runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply')).toMatchObject({ status: 'complete', modified: 0 });
    expect(db.docs('property_form_definition_versions')).toEqual([]);
  });

  it('blocks when a seeded legacy version does not match the legacy content', async () => {
    const db = await withRegistry(legacyDb());
    await runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply');
    db.docs('property_form_definition_versions')[0].fields[0].labelAr = 'مختلف';
    await expect(runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply')).rejects.toThrow(/LEGACY_FORM_VERSION_MISMATCH/);
  });

  it('blocks at preflight, and fails validate() directly, when a non-residential type already carries a seeded-legacy-shaped head (bug-guard regression check)', async () => {
    const invalidHead = { _id: oid(870), purposeSubcategoryId: oid(105), status: 'active', currentVersionId: oid(871), currentVersion: 1, nextVersionNumber: 2, version: 1 };
    const invalidVersion = { _id: oid(871), definitionId: oid(870), purposeSubcategoryId: oid(105), version: 1, state: 'published', fields: LEGACY_RESIDENTIAL_CONTENT.fields, mediaProfile: LEGACY_RESIDENTIAL_CONTENT.mediaProfile, amenitiesEnabled: LEGACY_RESIDENTIAL_CONTENT.amenitiesEnabled, rendererVersion: LEGACY_RESIDENTIAL_CONTENT.rendererVersion, contentHash: LEGACY_RESIDENTIAL_CONTENT_HASH };
    const db = await withRegistry(legacyDb().seed('property_form_definitions', [
      { _id: adminHeadId, purposeSubcategoryId: oid(104), status: 'active', currentVersionId: oid(801), currentVersion: 3, nextVersionNumber: 4, version: 7, createdBy: oid(1) },
      invalidHead,
    ]).seed('property_form_definition_versions', [invalidVersion]));

    await expect(runner(db).run(legacyPropertyFormDefinitionsMigration, 'dry-run')).rejects.toThrow(/LEGACY_FORM_DEFINITION_INVALID_PURPOSE/);
    await expect(runner(db, completed('025-property-attribute-registry')).run(legacyPropertyFormDefinitionsMigration, 'apply')).rejects.toThrow(/LEGACY_FORM_DEFINITION_INVALID_PURPOSE/);

    const validation = await legacyPropertyFormDefinitionsMigration.validate({ db: db as any, runId: 'direct-check', batchSize: 250 });
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'LEGACY_FORM_DEFINITION_INVALID_PURPOSE' })]));
  });
});

describe('DPF-014 M-C legacy data report (027-legacy-property-data-report)', () => {
  const RES = oid(900);
  const AGRI = oid(901);
  const APARTMENT = oid(101);
  const LAND = oid(102);
  const rooms = (bedrooms: number, livingRooms: number, kitchens: number, bathrooms: number) => ({ bedrooms, livingRooms, kitchens, bathrooms });
  const reportDb = () => new MemoryDb()
    .seed('property_purpose_categories', [{ _id: RES, code: 'residential', nameAr: 'سكني' }, { _id: AGRI, code: 'agricultural', nameAr: 'زراعي' }])
    .seed('property_types', [
      { _id: APARTMENT, code: 'apartment', nameAr: 'شقة', purposeCategoryId: RES, isActive: true },
      { _id: LAND, code: 'farm_land', nameAr: 'أرض زراعية', purposeCategoryId: AGRI, isActive: true },
      { _id: oid(103), code: 'orphan_type', nameAr: 'بلا غرض', isActive: true },
    ])
    .seed('property_options', [
      { group: 'finishing_status', code: 'fully_finished', isActive: true }, { group: 'finishing_status', code: 'unfinished', isActive: true },
      { group: 'delivery_status', code: 'immediate', isActive: true }, { group: 'delivery_status', code: 'under_construction', isActive: false },
    ])
    .seed('property_revisions', [
      { _id: oid(201), propertyId: oid(301), moderationStatus: 'approved', purposeCategoryId: RES, purposeSubcategoryId: APARTMENT, area: 120, ...rooms(3, 1, 1, 2), floor: 2, totalFloors: 5, buildingYear: 2010, finishingStatusCode: 'fully_finished', deliveryStatusCode: 'immediate' },
      { _id: oid(202), propertyId: oid(301), moderationStatus: 'pending_review', purposeCategoryId: RES, purposeSubcategoryId: APARTMENT, area: 0, ...rooms(1, 1, 1, 1), floor: 7, totalFloors: 5, buildingYear: 2010, finishingStatusCode: 'gone_code', deliveryStatusCode: 'under_construction' },
      { _id: oid(203), propertyId: oid(302), moderationStatus: 'approved', purposeCategoryId: AGRI, purposeSubcategoryId: LAND, area: 1000, ...rooms(1, 1, 1, 1), floor: 0, totalFloors: 1, buildingYear: 2000, finishingStatusCode: 'unfinished', deliveryStatusCode: 'immediate' },
      { _id: oid(204), propertyId: oid(303), moderationStatus: 'approved', legacyPropertyTypeCode: 'villa', area: 300, ...rooms(4, 2, 1, 3), floor: 1, totalFloors: 2, buildingYear: 1999, deliveryStatusCode: 'immediate' },
      { _id: oid(205), propertyId: oid(304), moderationStatus: 'draft', purposeCategoryId: RES, purposeSubcategoryId: APARTMENT, area: 90, formDefinitionVersionId: oid(700), attributes: { bedrooms: 2 } },
    ])
    .seed('properties', [
      { _id: oid(301), status: 'approved', purposeCategoryId: RES, purposeSubcategoryId: APARTMENT, currentPublicRevisionId: oid(201), area: 100 },
      { _id: oid(302), status: 'approved', purposeCategoryId: AGRI, purposeSubcategoryId: LAND, currentPublicRevisionId: oid(203), area: 1000 },
      { _id: oid(303), status: 'approved', propertyTypeCode: 'villa', currentPublicRevisionId: oid(204), area: 300 },
      { _id: oid(304), status: 'pending_review', purposeCategoryId: RES, purposeSubcategoryId: APARTMENT },
      { _id: oid(305), status: 'approved', purposeCategoryId: RES, purposeSubcategoryId: APARTMENT, currentPublicRevisionId: oid(299), area: 50 },
    ])
    .seed('auctions', [
      { _id: oid(401), propertyId: oid(301), status: 'active' }, { _id: oid(402), propertyId: oid(302), status: 'scheduled' },
      { _id: oid(403), propertyId: oid(304), status: 'scheduled' }, { _id: oid(404), propertyId: oid(303), status: 'completed' },
    ]);

  it('is manual-only and read-only', async () => {
    expect(selectMigrations(CORE_MIGRATIONS).map((migration) => migration.id)).not.toContain('027-legacy-property-data-report');
    const db = reportDb();
    const before = JSON.stringify([...db.data.entries()]);
    await runner(db).run(legacyPropertyDataReportMigration, 'dry-run');
    await runner(db).run(legacyPropertyDataReportMigration, 'apply');
    expect(db.writes).toEqual([]);
    expect(JSON.stringify([...db.data.entries()])).toBe(before);
  });

  it('reports every frozen category as evidence, without judging historical values', async () => {
    const { preflight } = await runner(reportDb()).run(legacyPropertyDataReportMigration, 'dry-run');
    const report = preflight!.summary as Doc;
    expect(report.pins).toMatchObject({ revisionsTotal: 5, revisionsPinned: 1, revisionsWithoutPin: 4, propertiesTotal: 5, propertiesWithoutPin: 5 });
    expect(report.pins.revisionsWithoutPinByType).toEqual([
      { purposeCategoryId: String(RES), purposeCode: 'residential', purposeNameAr: 'سكني', purposeSubcategoryId: String(APARTMENT), typeCode: 'apartment', typeNameAr: 'شقة', moderationStatus: 'approved', count: 1 },
      { purposeCategoryId: String(RES), purposeCode: 'residential', purposeNameAr: 'سكني', purposeSubcategoryId: String(APARTMENT), typeCode: 'apartment', typeNameAr: 'شقة', moderationStatus: 'pending_review', count: 1 },
      { purposeCategoryId: String(AGRI), purposeCode: 'agricultural', purposeNameAr: 'زراعي', purposeSubcategoryId: String(LAND), typeCode: 'farm_land', typeNameAr: 'أرض زراعية', moderationStatus: 'approved', count: 1 },
      { purposeCategoryId: null, purposeCode: null, purposeNameAr: null, purposeSubcategoryId: null, typeCode: 'villa', typeNameAr: null, moderationStatus: 'approved', count: 1 },
    ]);
    expect(report.pins.propertiesWithoutPinByType.find((row: Doc) => row.typeCode === 'apartment' && row.status === 'approved')).toMatchObject({ count: 2 });
    const apartment = report.roomDistributions.find((row: Doc) => row.typeCode === 'apartment');
    expect(apartment).toMatchObject({ revisions: 2, allRoomCountsOne: 1, allRoomCountsOneShare: 0.5 });
    expect(apartment.fields.bedrooms).toEqual({ count: 2, missing: 0, min: 1, max: 3, mode: 1, modeCount: 1 });
    expect(apartment.fields.floor).toMatchObject({ min: 2, max: 7 });
    expect(report.roomDistributions.find((row: Doc) => row.typeCode === 'farm_land')).toMatchObject({ revisions: 1, allRoomCountsOne: 1, allRoomCountsOneShare: 1 });
    expect(report.auctions).toEqual({ approvedListingsAnchoredByScheduledOrActiveAuctions: 2 });
    expect(report.classification).toMatchObject({ revisionsMissingPurposeSubcategoryId: 1, propertiesMissingPurposeSubcategoryId: 1, activeTypesWithoutPurposeCategoryId: 1 });
    expect(report.area).toEqual({ propertyAreaDiffersFromPublicRevision: 1, propertiesAreaZeroOrMissing: 1, revisionsAreaZeroOrMissing: 1, propertiesWithDanglingPublicRevision: 1 });
    expect(report.catalog).toEqual({
      revisionsMissingFinishingStatus: 1, revisionsMissingDeliveryStatus: 0,
      invalidCodes: [
        { field: 'deliveryStatusCode', code: 'under_construction', state: 'inactive', revisions: 1 },
        { field: 'finishingStatusCode', code: 'gone_code', state: 'missing', revisions: 1 },
      ],
    });
    expect(report.crossField).toEqual({ revisionsFloorAboveTotalFloors: 1 });
  });
});

describe('DPF-014 M-D Property.area backfill (028-property-area-backfill)', () => {
  const areaDb = () => new MemoryDb()
    .seed('property_revisions', [
      { _id: oid(201), propertyId: oid(301), area: 120 },
      { _id: oid(202), propertyId: oid(302), area: 90 },
      { _id: oid(204), propertyId: oid(999), area: 70 },
      { _id: oid(205), propertyId: oid(305), area: 0 },
      { _id: oid(206), propertyId: oid(306), area: 80 },
    ])
    .seed('properties', [
      { _id: oid(301), currentPublicRevisionId: oid(201), area: 100 },
      { _id: oid(302), currentPublicRevisionId: oid(202), area: 90 },
      { _id: oid(303), area: 55 },
      { _id: oid(304), currentPublicRevisionId: oid(299), area: 40 },
      { _id: oid(307), currentPublicRevisionId: oid(204), area: 60 },
      { _id: oid(305), currentPublicRevisionId: oid(205), area: 30 },
      { _id: oid(306), currentPublicRevisionId: oid(206) },
    ]);
  const completedRevisions = () => completed('015-property-attribution-revisions');

  it('reports exact counts, updates only differing rows, never touches revisions, and reruns as a no-op', async () => {
    const db = areaDb();
    const revisionsBefore = snapshot(db, 'property_revisions');
    const dryRun = await runner(db).run(propertyAreaBackfillMigration, 'dry-run');
    expect(dryRun.preflight).toEqual({ eligible: 2, alreadyApplied: 1, blockers: [], summary: { differing: 2, matching: 1, danglingPublicRevision: 1, invalidRevisionArea: 1, foreignRevision: 1 } });
    expect(db.writes).toEqual([]);

    expect(await runner(db, completedRevisions(), 3).run(propertyAreaBackfillMigration, 'apply')).toMatchObject({ status: 'complete', modified: 2 });
    const area = (n: number) => db.docs('properties').find((property) => String(property._id) === String(oid(n)))!.area;
    expect([area(301), area(302), area(303), area(304), area(307), area(305), area(306)]).toEqual([120, 90, 55, 40, 60, 30, 80]);
    expect(snapshot(db, 'property_revisions')).toBe(revisionsBefore);
    expect(writesTo(db)).toEqual(['properties']);

    const before = snapshot(db, 'properties');
    expect(await runner(db, completedRevisions()).run(propertyAreaBackfillMigration, 'apply')).toMatchObject({ status: 'complete', modified: 0 });
    expect(snapshot(db, 'properties')).toBe(before);
  });

  it('never overwrites a row approved again between the read and the write', async () => {
    const db = new MemoryDb()
      .seed('property_revisions', [{ _id: oid(201), propertyId: oid(301), area: 120 }, { _id: oid(209), propertyId: oid(301), area: 150 }])
      .seed('properties', [{ _id: oid(301), currentPublicRevisionId: oid(201), area: 100 }]);
    const collection = db.collection.bind(db);
    (db as any).collection = (name: string) => {
      const target = collection(name);
      if (name !== 'properties') return target;
      return { ...target, updateOne: async (filter: Doc, update: Doc, options?: Doc) => {
        Object.assign(db.docs('properties')[0], { currentPublicRevisionId: oid(209), area: 150 });
        return target.updateOne(filter, update, options);
      } };
    };
    expect(await runner(db, completedRevisions()).run(propertyAreaBackfillMigration, 'apply')).toMatchObject({ status: 'complete', modified: 0 });
    expect(db.docs('properties')[0]).toMatchObject({ currentPublicRevisionId: oid(209), area: 150 });
  });
});

describe('DPF-013/014 migration registry', () => {
  it('registers M-A -> M-B, the manual report, the area backfill and the Phase 8/9/10 registry seeds in order', () => {
    validateMigrationRegistry();
    const ids = CORE_MIGRATIONS.map((migration) => migration.id);
    expect(ids.slice(-8)).toEqual([
      '025-property-attribute-registry',
      '026-legacy-property-form-definitions',
      '027-legacy-property-data-report',
      '028-property-area-backfill',
      '029-phase8-attribute-registry',
      '030-phase9-facet-promotion',
      '031-phase9-facet-backfill',
      '032-phase10-unit-floor-level-registry',
    ]);
    expect(legacyPropertyFormDefinitionsMigration.dependencies).toEqual(['025-property-attribute-registry']);
    expect(propertyAreaBackfillMigration.dependencies).toEqual(['015-property-attribution-revisions']);
    expect(legacyPropertyDataReportMigration.manualOnly).toBe(true);
    expect(selectMigrations(CORE_MIGRATIONS).map((migration) => migration.id)).toEqual(expect.arrayContaining(['025-property-attribute-registry', '026-legacy-property-form-definitions', '028-property-area-backfill', '029-phase8-attribute-registry']));
  });
});
