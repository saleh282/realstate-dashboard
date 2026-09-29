import { ObjectId } from 'mongodb';
import { selectMigrations } from '../src/migrations/cli';
import { CORE_MIGRATIONS, phase13RetireSupersededListingIndexesMigration, phase13SortableListingIndexesMigration } from '../src/migrations/framework/core-migrations';
import { MigrationRunner } from '../src/migrations/framework/migration.runner';
import { runIntegrityChecks } from '../src/migrations/integrity-checker';
import { PROPERTY_SORTABLE_LISTING_INDEXES, SUPERSEDED_LISTING_INDEXES } from '../src/properties/property-listing-indexes';
import { PropertiesService } from '../src/properties/properties.service';
import { PropertySchema } from '../src/properties/schemas/property.schema';
import { MemoryDb, MemoryStore } from './support/memory-mongo';

const TYPE_ID = '64b0000000000000000000a1';
const PURPOSE_ID = '64b000000000000000000010';

function listingService() {
  const service = Object.create(PropertiesService.prototype) as any;
  service.propertyTypes = { findById: () => ({ lean: () => ({ exec: async () => ({ _id: new ObjectId(TYPE_ID), purposeCategoryId: new ObjectId(PURPOSE_ID) }) }) }) };
  service.purposeCategories = { exists: () => ({ exec: async () => ({ _id: 1 }) }) };
  return service;
}

const declared = () => PropertySchema.indexes().filter(([, options]) => String((options as any)?.name ?? '').startsWith('property_public_listing_')).map(([key]) => Object.keys(key));
const VISIBILITY = ['status', 'isOwnerVisible', 'lifecycleStatus'];

describe('Phase 13 public-listing visibility predicate', () => {
  // The predicates changed shape ($ne/$nin -> $in) so MongoDB can merge index ranges for the sort.
  // They must select exactly the same documents over every value the schema can hold.
  const oldGate = (doc: any) => doc.isOwnerVisible !== false && !['archived', 'admin_hidden'].includes(doc.lifecycleStatus);
  const inSet = (value: unknown, set: unknown[]) => set.some((item) => (item === null ? value === null || value === undefined : item === value));
  const newGate = (doc: any) => inSet(doc.isOwnerVisible, [true, null]) && inSet(doc.lifecycleStatus, ['active', null]);

  it('is exactly the previous gate for every boolean/enum/missing combination', () => {
    for (const isOwnerVisible of [true, false, null, undefined]) {
      for (const lifecycleStatus of ['active', 'archived', 'admin_hidden', null, undefined]) {
        expect([isOwnerVisible, lifecycleStatus, newGate({ isOwnerVisible, lifecycleStatus })]).toEqual([isOwnerVisible, lifecycleStatus, oldGate({ isOwnerVisible, lifecycleStatus })]);
      }
    }
  });

  it('is built from the same point-interval shape the sortable indexes are qualified for', () => {
    const filter = (listingService() as any).publicVisibilityFilter();
    expect(filter).toEqual({ status: 'approved', isOwnerVisible: { $in: [true, null] }, lifecycleStatus: { $in: ['active', null] }, currentPublicRevisionId: { $exists: true } });
  });
});

describe('Phase 13 listing sort contract: every public sort is servable by a declared index', () => {
  const sortKeys = (sort: Record<string, 1 | -1>) => Object.keys(sort);
  const dims = ['operationType', 'governorateCode', 'purposeCategoryId', 'purposeSubcategoryIds'];

  it.each([
    ['newest', {}, undefined],
    ['newest by governorate', { governorateCode: 'cairo' }, 'governorateCode'],
    ['newest by operation', { operationType: 'sale' }, 'operationType'],
    ['newest by type (any selected)', { purposeSubcategoryId: TYPE_ID }, 'purposeSubcategoryIds'],
    ['newest by purpose', { purposeCategoryId: PURPOSE_ID }, 'purposeCategoryId'],
    ['price ascending', { sort: 'price_asc' }, undefined],
    ['price descending by governorate', { sort: 'price_desc', governorateCode: 'cairo' }, undefined],
  ] as const)('%s', async (_name, query, dimension) => {
    const { filter, sort } = await (listingService() as any).buildPublicListingQuery(query);
    const price = 'totalPriceMinor' in sort;
    // A servable index = visibility prefix, optionally ONE equality dimension, then exactly the sort keys.
    const wanted = price ? [...VISIBILITY, 'totalPriceMinor', '_id'] : [...VISIBILITY, ...(dimension ? [dimension] : []), ...sortKeys(sort)];
    const equalityDims = dims.filter((key) => key in filter);
    if (dimension) expect(equalityDims).toContain(dimension);
    else expect(price ? true : equalityDims).toEqual(price ? true : []);
    expect(sortKeys(sort).at(-1)).toBe('_id');
    expect(declared().some((key) => JSON.stringify(key) === JSON.stringify(wanted))).toBe(true);
  });

  it('every declared listing index ends with a sort that includes the _id tie-breaker', () => {
    for (const key of declared()) {
      expect(key.slice(0, 3)).toEqual(VISIBILITY);
      expect(key.at(-1)).toBe('_id');
    }
  });

  it('the price index is ascending on both fields so price_desc can walk it in reverse', () => {
    const price = PROPERTY_SORTABLE_LISTING_INDEXES.find((index) => index.options.name === 'property_public_listing_price_v2')!;
    expect(price.key).toEqual({ status: 1, isOwnerVisible: 1, lifecycleStatus: 1, totalPriceMinor: 1, _id: 1 });
  });
});

describe('Phase 13 migrations 034 / 035', () => {
  const superseded = SUPERSEDED_LISTING_INDEXES.map((index) => ({ name: index.options.name, key: index.key as any }));

  it('034 creates the sortable indexes additively and idempotently, leaving the old indexes alone', async () => {
    const db = new MemoryDb();
    db.indexes.set('properties', [...superseded]);
    const store = new MemoryStore();
    store.markComplete('023-property-type-listing-indexes');
    expect(await new MigrationRunner(db as any, store).run(phase13SortableListingIndexesMigration, 'apply')).toMatchObject({ status: 'complete', preflight: { eligible: 6, alreadyApplied: 0 } });
    const names = (db.indexes.get('properties') ?? []).map((index) => index.name);
    expect(names).toEqual([...superseded.map((index) => index.name), ...PROPERTY_SORTABLE_LISTING_INDEXES.map((index) => index.options.name)]);
    const again = new MemoryStore();
    again.markComplete('023-property-type-listing-indexes');
    expect(await new MigrationRunner(db as any, again).run(phase13SortableListingIndexesMigration, 'apply')).toMatchObject({ status: 'complete', preflight: { eligible: 0, alreadyApplied: 6 } });
    expect(db.writes.filter((write) => write.op === 'dropIndex')).toEqual([]);
  });

  it('034 is blocked by a same-name index with a different key and requires 023', async () => {
    const db = new MemoryDb();
    db.indexes.set('properties', [{ name: 'property_public_listing_newest_v2', key: { status: 1 } }]);
    const store = new MemoryStore();
    store.markComplete('023-property-type-listing-indexes');
    await expect(new MigrationRunner(db as any, store).run(phase13SortableListingIndexesMigration, 'apply')).rejects.toThrow('PROPERTY_SORTABLE_INDEX_CONFLICT');
    await expect(new MigrationRunner(new MemoryDb() as any, new MemoryStore()).run(phase13SortableListingIndexesMigration, 'apply')).rejects.toThrow('023-property-type-listing-indexes');
  });

  it('035 is manual-only, needs the sortable set in place, and drops only the six superseded indexes', async () => {
    expect(phase13RetireSupersededListingIndexesMigration.manualOnly).toBe(true);
    expect(selectMigrations(CORE_MIGRATIONS).map((migration) => migration.id)).not.toContain('035-phase13-retire-superseded-listing-indexes');
    expect(selectMigrations(CORE_MIGRATIONS).map((migration) => migration.id)).toContain('034-phase13-sortable-listing-indexes');
    expect(selectMigrations(CORE_MIGRATIONS, '035-phase13-retire-superseded-listing-indexes')).toHaveLength(1);

    const notReady = new MemoryDb();
    notReady.indexes.set('properties', [...superseded]);
    const store = new MemoryStore();
    store.markComplete('034-phase13-sortable-listing-indexes');
    await expect(new MigrationRunner(notReady as any, store).run(phase13RetireSupersededListingIndexesMigration, 'apply')).rejects.toThrow('PROPERTY_SORTABLE_INDEXES_NOT_IN_PLACE');
    expect(notReady.writes.filter((write) => write.op === 'dropIndex')).toEqual([]);

    const db = new MemoryDb();
    const extra = { name: 'property_advertiser_created', key: { advertiserAccountId: 1, createdAt: -1 } };
    db.indexes.set('properties', [extra, ...superseded, ...PROPERTY_SORTABLE_LISTING_INDEXES.map((index) => ({ name: index.options.name, key: index.key as any }))]);
    const ready = new MemoryStore();
    ready.markComplete('034-phase13-sortable-listing-indexes');
    expect(await new MigrationRunner(db as any, ready).run(phase13RetireSupersededListingIndexesMigration, 'apply')).toMatchObject({ status: 'complete', modified: 6 });
    expect((db.indexes.get('properties') ?? []).map((index) => index.name)).toEqual([extra.name, ...PROPERTY_SORTABLE_LISTING_INDEXES.map((index) => index.options.name)]);
  });

  it('declares its rollback: 034 restore-only, 035 automatic re-creation of exactly the dropped indexes', () => {
    expect(phase13SortableListingIndexesMigration.rollback.kind).toBe('none');
    const rollback = phase13RetireSupersededListingIndexesMigration.rollback;
    expect(rollback.kind).toBe('automatic');
    for (const index of SUPERSEDED_LISTING_INDEXES) expect((rollback as any).instructions).toContain(index.options.name);
  });
});

describe('Phase 13 integrity: values the visibility predicate would silently hide', () => {
  const codes = async (docs: any[]) => {
    const db = new MemoryDb().seed('properties', docs);
    const report = await runIntegrityChecks(db as any);
    return Object.fromEntries(report.findings.map((finding) => [finding.code, finding]));
  };

  it('flags an unknown lifecycleStatus or non-boolean isOwnerVisible as an error, and accepts every valid value', async () => {
    const valid = [{ _id: new ObjectId() }, { _id: new ObjectId(), isOwnerVisible: true, lifecycleStatus: 'active' }, { _id: new ObjectId(), isOwnerVisible: false, lifecycleStatus: 'archived' }, { _id: new ObjectId(), lifecycleStatus: 'admin_hidden' }];
    expect((await codes(valid)).PROPERTY_VISIBILITY_FIELD_INVALID).toBeUndefined();
    const bad = await codes([...valid, { _id: new ObjectId(), lifecycleStatus: 'deleted' }, { _id: new ObjectId(), isOwnerVisible: 'yes' }]);
    expect(bad.PROPERTY_VISIBILITY_FIELD_INVALID).toMatchObject({ severity: 'error', count: 2 });
  });
});
