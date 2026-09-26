import { ObjectId } from 'mongodb';
import { Types } from 'mongoose';
import { AuctionsQueryService } from '../src/auctions/auctions-query.service';
import { selectMigrations } from '../src/migrations/cli';
import {
  CORE_MIGRATIONS,
  propertyTypeListingIndexesMigration,
  propertyTypeSelectionBackfillMigration,
  retirePurposeListingIndexMigration,
} from '../src/migrations/framework/core-migrations';
import { MigrationRunner } from '../src/migrations/framework/migration.runner';
import type { MigrationDefinition, MigrationLedgerRecord } from '../src/migrations/framework/migration.types';
import type { MigrationStore } from '../src/migrations/framework/migration.store';
import { runIntegrityChecks } from '../src/migrations/integrity-checker';
import { PropertiesService } from '../src/properties/properties.service';
import { PropertySchema } from '../src/properties/schemas/property.schema';
import { PROPERTY_TYPE_LISTING_INDEXES, RETIRED_PURPOSE_LISTING_INDEX } from '../src/properties/property-listing-indexes';

/**
 * DPF-006 (backfill + integrity) and DPF-007 (any-selected-type search + M-G
 * indexes). No disposable MongoDB is available here, so the migration,
 * integrity and search pipelines run against a small in-memory evaluator that
 * implements exactly the MongoDB query/aggregation semantics they use.
 */

// ---------------------------------------------------------------- evaluator
type Doc = Record<string, any>;
const idOf = (value: unknown) => (value === null || value === undefined ? value : String(value));
const same = (a: unknown, b: unknown) => (a instanceof ObjectId || b instanceof ObjectId || a instanceof Types.ObjectId || b instanceof Types.ObjectId ? idOf(a) === idOf(b) : a === b);

function getPath(doc: any, path: string): any {
  return path.split('.').reduce((value: any, key) => {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value) && !/^\d+$/.test(key)) return value.map((item) => item?.[key]).filter((item) => item !== undefined);
    return value[key];
  }, doc);
}

const truthy = (value: unknown) => !(value === false || value === null || value === undefined || value === 0);

function evaluate(expr: any, doc: Doc, vars: Doc = {}): any {
  if (typeof expr === 'string' && expr.startsWith('$$')) return getPath(vars, expr.slice(2));
  if (typeof expr === 'string' && expr.startsWith('$')) return getPath(doc, expr.slice(1));
  if (Array.isArray(expr)) return expr.map((item) => evaluate(item, doc, vars));
  if (!expr || typeof expr !== 'object' || expr instanceof ObjectId || expr instanceof Date) return expr;
  const [op, raw] = Object.entries(expr)[0];
  const args = (Array.isArray(raw) ? raw : [raw]).map((item) => evaluate(item, doc, vars));
  switch (op) {
    case '$cond': return truthy(args[0]) ? args[1] : args[2];
    case '$isArray': return Array.isArray(args[0]);
    case '$ifNull': return args[0] === null || args[0] === undefined ? args[1] : args[0];
    case '$in': if (!Array.isArray(args[1])) throw new Error('$in needs an array'); return args[1].some((item: unknown) => same(item, args[0]));
    case '$not': return !truthy(args[0]);
    case '$and': return args.every(truthy);
    case '$or': return args.some(truthy);
    case '$eq': return same(args[0], args[1]);
    case '$ne': return !same(args[0], args[1]);
    case '$arrayElemAt': return Array.isArray(args[0]) ? args[0][args[1]] : undefined;
    default: throw new Error(`unsupported expression ${op}`);
  }
}

function matches(doc: Doc, filter: Doc, vars: Doc = {}): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$expr') return truthy(evaluate(condition, doc, vars));
    if (key === '$and') return (condition as Doc[]).every((sub) => matches(doc, sub, vars));
    if (key === '$or') return (condition as Doc[]).some((sub) => matches(doc, sub, vars));
    const value = getPath(doc, key);
    const equals = (expected: unknown) => (expected === null ? value === null || value === undefined : Array.isArray(value) ? value.some((item) => same(item, expected)) || same(value, expected) : same(value, expected));
    if (condition && typeof condition === 'object' && !(condition instanceof ObjectId) && !(condition instanceof Types.ObjectId) && !Array.isArray(condition) && !(condition instanceof Date)) {
      return Object.entries(condition).every(([op, expected]: [string, any]) => {
        switch (op) {
          case '$exists': return (value !== undefined) === expected;
          case '$ne': return !equals(expected);
          case '$in': return expected.some((item: unknown) => equals(item));
          case '$nin': return !expected.some((item: unknown) => equals(item));
          case '$gt': return value !== undefined && idOf(value)! > idOf(expected)!;
          case '$gte': return value !== undefined && value >= expected;
          case '$lte': return value !== undefined && value <= expected;
          case '$regex': return new RegExp(expected, condition.$options ?? '').test(String(value ?? ''));
          case '$options': return true;
          default: throw new Error(`unsupported operator ${op}`);
        }
      });
    }
    return equals(condition);
  });
}

function sortDocs(docs: Doc[], spec: Record<string, 1 | -1>) {
  return [...docs].sort((a, b) => {
    for (const [field, dir] of Object.entries(spec)) {
      const [av, bv] = [a[field] instanceof Date ? +a[field] : idOf(a[field]) ?? a[field], b[field] instanceof Date ? +b[field] : idOf(b[field]) ?? b[field]];
      if (av === bv) continue;
      return (av > bv ? 1 : -1) * dir;
    }
    return 0;
  });
}

class MemoryDb {
  data = new Map<string, Doc[]>();
  indexes = new Map<string, Array<{ name: string; key: Doc }>>();
  writes: Array<{ collection: string; op: string }> = [];
  seed(name: string, docs: Doc[]) { this.data.set(name, docs); return this; }
  docs(name: string) { if (!this.data.has(name)) this.data.set(name, []); return this.data.get(name)!; }

  aggregate(name: string, pipeline: Doc[], vars: Doc = {}): Doc[] {
    let docs = this.docs(name).map((doc) => ({ ...doc }));
    for (const stage of pipeline) {
      const [op, spec] = Object.entries(stage)[0] as [string, any];
      if (op === '$match') docs = docs.filter((doc) => matches(doc, spec, vars));
      else if (op === '$project') {
        const excluded = Object.values(spec).every((value) => value === 0);
        docs = docs.map((doc) => excluded
          ? Object.fromEntries(Object.entries(doc).filter(([key]) => !(key in spec)))
          : Object.fromEntries([['_id', doc._id], ...Object.entries(spec).map(([key, value]) => [key, value === 1 ? doc[key] : evaluate(value, doc, vars)])]));
      } else if (op === '$set') docs = docs.map((doc) => ({ ...doc, ...Object.fromEntries(Object.entries(spec).map(([key, value]) => [key, evaluate(value, doc, vars)])) }));
      else if (op === '$unwind') docs = docs.flatMap((doc) => (getPath(doc, spec.slice(1)) ?? []).map((item: unknown) => ({ ...doc, [spec.slice(1)]: item })));
      else if (op === '$lookup') docs = docs.map((doc) => ({
        ...doc,
        [spec.as]: spec.pipeline
          ? this.aggregate(spec.from, spec.pipeline, Object.fromEntries(Object.entries(spec.let ?? {}).map(([key, value]) => [key, evaluate(value, doc, vars)])))
          : this.docs(spec.from).filter((target) => same(getPath(target, spec.foreignField), getPath(doc, spec.localField))),
      }));
      else if (op === '$group') docs = [...new Map(docs.map((doc) => [idOf(evaluate(spec._id, doc, vars)), { _id: evaluate(spec._id, doc, vars) }])).values()];
      else if (op === '$count') docs = docs.length ? [{ [spec]: docs.length }] : [];
      else if (op === '$limit') docs = docs.slice(0, spec);
      else if (op === '$skip') docs = docs.slice(spec);
      else if (op === '$sort') docs = sortDocs(docs, spec);
      else if (op === '$facet') docs = [Object.fromEntries(Object.entries(spec).map(([key, sub]) => [key, this.aggregateDocs(docs, sub as Doc[], vars)]))];
      else throw new Error(`unsupported stage ${op}`);
    }
    return docs;
  }

  private aggregateDocs(docs: Doc[], pipeline: Doc[], vars: Doc) {
    const scratch = `__facet_${Math.random()}`;
    this.data.set(scratch, docs);
    try { return this.aggregate(scratch, pipeline, vars); } finally { this.data.delete(scratch); }
  }

  collection(name: string) {
    const db = this;
    return {
      countDocuments: async (filter: Doc = {}) => db.docs(name).filter((doc) => matches(doc, filter)).length,
      find: (filter: Doc = {}, options: { projection?: Doc } = {}) => {
        let docs = db.docs(name).filter((doc) => matches(doc, filter));
        const chain: any = {
          sort: (spec: Record<string, 1 | -1>) => { docs = sortDocs(docs, spec); return chain; },
          limit: (n: number) => { docs = docs.slice(0, n); return chain; },
          toArray: async () => docs.map((doc) => (options.projection ? Object.fromEntries(Object.keys({ _id: 1, ...options.projection }).map((key) => [key, doc[key]])) : { ...doc })),
        };
        return chain;
      },
      aggregate: (pipeline: Doc[]) => ({ toArray: async () => db.aggregate(name, pipeline) }),
      bulkWrite: async (operations: Doc[]) => {
        db.writes.push({ collection: name, op: 'bulkWrite' });
        let modifiedCount = 0;
        for (const { updateOne } of operations) {
          const target = db.docs(name).find((doc) => matches(doc, updateOne.filter));
          if (target) { Object.assign(target, updateOne.update.$set); modifiedCount++; }
        }
        return { modifiedCount };
      },
      updateMany: async () => { db.writes.push({ collection: name, op: 'updateMany' }); return { matchedCount: 0, modifiedCount: 0 }; },
      indexes: async () => db.indexes.get(name) ?? [],
      createIndex: async (key: Doc, options: { name: string }) => {
        db.writes.push({ collection: name, op: 'createIndex' });
        const list = db.indexes.get(name) ?? [];
        const existing = list.find((index) => index.name === options.name);
        if (existing && JSON.stringify(existing.key) !== JSON.stringify(key)) throw new Error('IndexOptionsConflict');
        if (!existing) list.push({ name: options.name, key });
        db.indexes.set(name, list);
        return options.name;
      },
      dropIndex: async (indexName: string) => {
        db.writes.push({ collection: name, op: 'dropIndex' });
        db.indexes.set(name, (db.indexes.get(name) ?? []).filter((index) => index.name !== indexName));
      },
    };
  }
}

class MemoryStore implements MigrationStore {
  records = new Map<string, MigrationLedgerRecord>();
  lockOwner?: string;
  async acquireLock(ownerId: string) { if (this.lockOwner) return false; this.lockOwner = ownerId; return true; }
  async renewLock(ownerId: string) { return this.lockOwner === ownerId; }
  async releaseLock(ownerId: string) { if (this.lockOwner === ownerId) this.lockOwner = undefined; }
  async get(id: string) { return this.records.get(id) ?? null; }
  async isComplete(id: string) { return this.records.get(id)?.status === 'complete'; }
  async begin(definition: MigrationDefinition, runId: string) {
    const now = new Date();
    const record = this.records.get(definition.id) ?? { migrationId: definition.id, version: definition.version, status: 'running' as const, runId, batches: 0, scanned: 0, modified: 0, attempts: 0, startedAt: now, updatedAt: now };
    const next = { ...record, status: 'running' as const, runId, attempts: record.attempts + 1 };
    this.records.set(definition.id, next);
    return next;
  }
  async checkpoint(id: string, _runId: string, checkpoint: string | undefined, scanned: number, modified: number) {
    const record = this.records.get(id)!;
    this.records.set(id, { ...record, checkpoint, batches: record.batches + 1, scanned: record.scanned + scanned, modified: record.modified + modified });
  }
  async complete(id: string) { this.records.get(id)!.status = 'complete'; }
  async fail(id: string, runId: string, phase: string, message: string) {
    const record = this.records.get(id);
    if (record) this.records.set(id, { ...record, status: 'failed', runId, failure: { phase, message, at: new Date() } });
  }
  markComplete(id: string) { this.records.set(id, { migrationId: id, version: 1, status: 'complete', runId: 'seed', batches: 0, scanned: 0, modified: 0, attempts: 1, startedAt: new Date(), updatedAt: new Date() }); }
}

// ---------------------------------------------------------------- fixtures
const PURPOSE_RES = new ObjectId('64b000000000000000000010');
const PURPOSE_COM = new ObjectId('64b000000000000000000020');
const APARTMENT = new ObjectId('64b0000000000000000000a1');
const DUPLEX = new ObjectId('64b0000000000000000000a2');
const VILLA = new ObjectId('64b0000000000000000000a3');
const OFFICE = new ObjectId('64b0000000000000000000b1');
const GONE = new ObjectId('64b0000000000000000000ff');
const oid = (n: number) => new ObjectId(`64b00000000000000000${String(n).padStart(4, '0')}`);

const types = () => [
  { _id: APARTMENT, code: 'apartment', purposeCategoryId: PURPOSE_RES, isActive: true, usageCount: 0 },
  { _id: DUPLEX, code: 'duplex', purposeCategoryId: PURPOSE_RES, isActive: true, usageCount: 0 },
  { _id: VILLA, code: 'villa', purposeCategoryId: PURPOSE_RES, isActive: true, usageCount: 0 },
  { _id: OFFICE, code: 'office', purposeCategoryId: PURPOSE_COM, isActive: true, usageCount: 0 },
];

// ================================================================= DPF-006
describe('DPF-006 M-F backfill (022-property-type-selection-backfill)', () => {
  const legacyDb = () => new MemoryDb()
    .seed('property_types', types())
    .seed('properties', [
      { _id: oid(1), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: APARTMENT, lifecycleStatus: 'active', status: 'approved' },
      { _id: oid(2), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: VILLA, lifecycleStatus: 'archived', status: 'approved' },
      { _id: oid(3), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: DUPLEX, lifecycleStatus: 'admin_hidden', status: 'pending_review' },
      { _id: oid(4), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: APARTMENT, purposeSubcategoryIds: [APARTMENT, DUPLEX], status: 'approved' },
      { _id: oid(5), propertyTypeCode: 'chalet', status: 'rejected' },
    ])
    .seed('property_revisions', [
      { _id: oid(101), propertyId: oid(1), purposeSubcategoryId: APARTMENT },
      { _id: oid(104), propertyId: oid(4), purposeSubcategoryId: APARTMENT, purposeSubcategoryIds: [APARTMENT, DUPLEX] },
    ]);

  const runner = (db: MemoryDb, store = new MemoryStore(), batchSize = 2) => {
    store.markComplete('015-property-attribution-revisions');
    return { store, runner: new MigrationRunner(db as any, store, { batchSize }) };
  };

  it('backfills [primary] for every lifecycle state, in checkpointed batches, and leaves populated arrays and revisions alone', async () => {
    const db = legacyDb();
    const revisionsBefore = JSON.stringify(db.docs('property_revisions'));
    const populatedBefore = db.docs('properties')[3].purposeSubcategoryIds;
    const { runner: migrationRunner } = runner(db);
    const report = await migrationRunner.run(propertyTypeSelectionBackfillMigration, 'apply');
    expect(report).toMatchObject({ status: 'complete', modified: 3, scanned: 3, batches: 2 });
    const selection = (n: number) => db.docs('properties').find((doc) => idOf(doc._id) === idOf(oid(n)))!.purposeSubcategoryIds;
    expect(selection(1).map(String)).toEqual([String(APARTMENT)]);
    expect(selection(2).map(String)).toEqual([String(VILLA)]);
    expect(selection(3).map(String)).toEqual([String(DUPLEX)]);
    expect(selection(4)).toBe(populatedBefore);
    expect(selection(5)).toBeUndefined();
    expect(JSON.stringify(db.docs('property_revisions'))).toBe(revisionsBefore);
    expect(db.writes.filter((write) => write.collection !== 'properties')).toEqual([]);
  });

  it('is idempotent: a rerun is skipped by the ledger and a fresh run over backfilled data modifies nothing', async () => {
    const db = legacyDb();
    const { store, runner: first } = runner(db);
    await first.run(propertyTypeSelectionBackfillMigration, 'apply');
    const snapshot = JSON.stringify(db.docs('properties'));
    expect((await first.run(propertyTypeSelectionBackfillMigration, 'apply')).status).toBe('skipped-complete');
    const fresh = runner(db).runner;
    expect(await fresh.run(propertyTypeSelectionBackfillMigration, 'apply')).toMatchObject({ status: 'complete', modified: 0 });
    expect(JSON.stringify(db.docs('properties'))).toBe(snapshot);
    expect(store.records.get('022-property-type-selection-backfill')?.status).toBe('complete');
  });

  it('never overwrites a row the application re-pointed between the scan and the write', async () => {
    const db = legacyDb();
    const { runner: migrationRunner } = runner(db, new MemoryStore(), 10);
    const properties = db.collection('properties');
    // Simulate a concurrent approval that changed the primary after the batch was read.
    (db as any).collection = ((collection) => (name: string) => {
      const handle = collection(name);
      if (name !== 'properties') return handle;
      return { ...handle, find: (...args: any[]) => { const chain = (properties.find as any)(...args); const toArray = chain.toArray; chain.toArray = async () => { const rows = await toArray(); db.docs('properties')[0].purposeSubcategoryId = VILLA; return rows; }; return chain; } };
    })(db.collection.bind(db));
    await migrationRunner.run(propertyTypeSelectionBackfillMigration, 'apply').catch(() => undefined);
    expect(db.docs('properties')[0].purposeSubcategoryIds).toBeUndefined();
  });

  it('reports legacy data in the dry-run preflight without blocking or correcting it', async () => {
    const db = legacyDb().seed('property_types', [...types(), { _id: new ObjectId(), code: 'orphan', isActive: true }, { _id: new ObjectId(), code: 'retired', isActive: false }]);
    db.docs('property_revisions').push({ _id: oid(105), propertyId: oid(5), purposeSubcategoryId: null });
    const report = await runner(db).runner.run(propertyTypeSelectionBackfillMigration, 'dry-run');
    expect(report.status).toBe('dry-run-complete');
    expect(report.preflight).toEqual({
      eligible: 3, alreadyApplied: 1, blockers: [],
      summary: {
        propertiesMissingPurposeSubcategoryId: 1, revisionsMissingPurposeSubcategoryId: 1, activeTypesWithoutPurposeCategoryId: 1,
        propertiesWithMultipleSelectedTypes: 1, revisionsWithMultipleSelectedTypes: 1, propertiesWithSelectionMissingPrimary: 0,
      },
    });
    expect(db.writes).toEqual([]);
  });

  it('fails validation, without rewriting anything, when a stored selection lacks its primary', async () => {
    const db = legacyDb();
    db.docs('properties').push({ _id: oid(6), purposeSubcategoryId: APARTMENT, purposeSubcategoryIds: [DUPLEX] });
    await expect(runner(db).runner.run(propertyTypeSelectionBackfillMigration, 'apply')).rejects.toThrow(/PROPERTY_TYPE_SELECTION_MISSING_PRIMARY/);
    expect(db.docs('properties').find((doc) => idOf(doc._id) === idOf(oid(6)))!.purposeSubcategoryIds.map(String)).toEqual([String(DUPLEX)]);
  });
});

describe('DPF-006 integrity checks for multi-type classification', () => {
  const codes = async (db: MemoryDb) => Object.fromEntries((await runIntegrityChecks(db as any)).findings.map((finding) => [finding.code, { count: finding.count, severity: finding.severity, sampleIds: finding.sampleIds }]));
  const consistent = () => new MemoryDb()
    .seed('property_types', types().map((type) => ({ ...type, usageCount: type._id.equals(APARTMENT) ? 2 : type._id.equals(DUPLEX) ? 1 : 0 })))
    .seed('properties', [
      { _id: oid(1), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: APARTMENT, purposeSubcategoryIds: [APARTMENT, DUPLEX], status: 'approved' },
      { _id: oid(2), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: APARTMENT, purposeSubcategoryIds: [APARTMENT], status: 'approved' },
    ])
    .seed('property_revisions', [{ _id: oid(101), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: APARTMENT, purposeSubcategoryIds: [APARTMENT, DUPLEX] }]);

  it('reports nothing for consistent primary + additional classification', async () => {
    expect(await codes(consistent())).toEqual({});
  });

  it('counts usage by selected-type membership, including additional types and legacy code-only rows', async () => {
    const db = consistent();
    db.docs('properties').push({ _id: oid(3), propertyTypeCode: 'villa', status: 'approved' });
    db.docs('property_types').find((type) => type._id.equals(VILLA))!.usageCount = 1;
    expect((await codes(db)).PROPERTY_TYPE_USAGE_DRIFT).toBeUndefined();
    db.docs('property_types').find((type) => type._id.equals(DUPLEX))!.usageCount = 0;
    expect((await codes(db)).PROPERTY_TYPE_USAGE_DRIFT).toEqual({ count: 1, severity: 'warning', sampleIds: [String(DUPLEX)] });
  });

  it('flags a missing backfill, and a stored selection missing its primary on properties and revisions', async () => {
    const db = consistent();
    db.docs('properties').push({ _id: oid(3), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: VILLA, status: 'approved' });
    db.docs('properties').push({ _id: oid(4), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: VILLA, purposeSubcategoryIds: [DUPLEX], status: 'approved' });
    db.docs('property_revisions').push({ _id: oid(102), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: VILLA, purposeSubcategoryIds: null });
    db.docs('property_revisions').push({ _id: oid(103), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: VILLA });
    const findings = await codes(db);
    expect(findings.PROPERTY_TYPE_SELECTION_BACKFILL_MISSING).toEqual({ count: 1, severity: 'error', sampleIds: [String(oid(3))] });
    expect(findings.PROPERTY_TYPE_SELECTION_MISSING_PRIMARY).toEqual({ count: 1, severity: 'error', sampleIds: [String(oid(4))] });
    expect(findings.REVISION_TYPE_SELECTION_MISSING_PRIMARY).toEqual({ count: 1, severity: 'error', sampleIds: [String(oid(102))] });
  });

  it('flags a selected type under another purpose and selected types that no longer exist', async () => {
    const db = consistent();
    db.docs('properties').push({ _id: oid(5), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: APARTMENT, purposeSubcategoryIds: [APARTMENT, OFFICE] });
    db.docs('properties').push({ _id: oid(6), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: APARTMENT, purposeSubcategoryIds: [APARTMENT, GONE] });
    db.docs('property_revisions').push({ _id: oid(106), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: GONE });
    db.docs('property_revisions').push({ _id: oid(107), purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: APARTMENT, purposeSubcategoryIds: [OFFICE, APARTMENT] });
    const findings = await codes(db);
    expect(findings.PROPERTY_TYPE_SELECTION_MIXED_PURPOSE).toMatchObject({ count: 1, severity: 'error', sampleIds: [String(oid(5))] });
    expect(findings.REVISION_TYPE_SELECTION_MIXED_PURPOSE).toMatchObject({ count: 1, sampleIds: [String(oid(107))] });
    expect(findings.DANGLING_SELECTED_PROPERTY_TYPE).toMatchObject({ count: 1, severity: 'error', sampleIds: [String(oid(6))] });
    expect(findings.DANGLING_REVISION_SELECTED_PROPERTY_TYPE).toMatchObject({ count: 1, sampleIds: [String(oid(106))] });
  });

  it('reports active types without a purpose and records without a primary as warnings only', async () => {
    const db = consistent();
    const orphan = new ObjectId();
    db.docs('property_types').push({ _id: orphan, code: 'orphan', isActive: true, usageCount: 0 });
    db.docs('properties').push({ _id: oid(7), status: 'approved' });
    db.docs('property_revisions').push({ _id: oid(108), purposeSubcategoryId: null });
    const report = await runIntegrityChecks(db as any);
    const findings = Object.fromEntries(report.findings.map((finding) => [finding.code, finding]));
    expect(findings.ACTIVE_PROPERTY_TYPE_WITHOUT_PURPOSE).toMatchObject({ severity: 'warning', sampleIds: [String(orphan)] });
    expect(findings.PROPERTY_MISSING_PRIMARY_TYPE).toMatchObject({ severity: 'warning', sampleIds: [String(oid(7))] });
    expect(findings.REVISION_MISSING_PRIMARY_TYPE).toMatchObject({ severity: 'warning', sampleIds: [String(oid(108))] });
    expect(report.ok).toBe(true);
  });
});

// ================================================================= DPF-007
const CATEGORY_RES = String(PURPOSE_RES);
function listingDb() {
  const listing = (n: number, selection: ObjectId[], extra: Doc = {}) => ({
    _id: oid(n), status: 'approved', isOwnerVisible: true, lifecycleStatus: 'active', currentPublicRevisionId: oid(1000 + n),
    purposeCategoryId: PURPOSE_RES, purposeSubcategoryId: selection[0], purposeSubcategoryIds: selection,
    governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع', title: `عقار ${n}`, totalPriceMinor: 100_000 * n,
    createdAt: new Date(Date.UTC(2026, 0, n)), ...extra,
  });
  return [
    listing(1, [APARTMENT, DUPLEX]),
    listing(2, [APARTMENT]),
    listing(3, [DUPLEX], { governorateCode: 'giza' }),
    listing(4, [VILLA]),
    listing(5, [VILLA, DUPLEX], { totalPriceMinor: 900_000 }),
    listing(6, [OFFICE], { purposeCategoryId: PURPOSE_COM }),
    listing(7, [APARTMENT, DUPLEX], { isOwnerVisible: false }),
  ];
}

function searchService(docs: Doc[]) {
  const db = new MemoryDb().seed('properties', docs).seed('property_types', types());
  const service = Object.create(PropertiesService.prototype) as any;
  const filters: Doc[] = [];
  service.properties = {
    find: (filter: Doc) => {
      filters.push(filter);
      let rows = db.docs('properties').filter((doc) => matches(doc, filter));
      const chain: any = {
        sort: (spec: any) => { rows = sortDocs(rows, spec); return chain; },
        skip: (n: number) => { rows = rows.slice(n); return chain; },
        limit: (n: number) => { rows = rows.slice(0, n); return chain; },
        populate: () => chain, lean: () => chain, exec: async () => rows,
      };
      return chain;
    },
    countDocuments: (filter: Doc) => ({ exec: async () => db.docs('properties').filter((doc) => matches(doc, filter)).length }),
  };
  service.propertyTypes = {
    findById: (id: string) => ({ lean: () => ({ exec: async () => db.docs('property_types').find((type) => idOf(type._id) === id) ?? null }) }),
  };
  service.purposeCategories = { exists: () => ({ exec: async () => ({ _id: PURPOSE_RES }) }) };
  service.hydratePublicListings = async (items: Doc[]) => items.map((item) => ({ id: String(item._id) }));
  return { service: service as PropertiesService, db, filters };
}

const ids = (result: { items: Array<{ id: string }> }) => result.items.map((item) => item.id);
const n = (...values: number[]) => values.map((value) => String(oid(value)));

describe('DPF-007 public search matches any selected type', () => {
  it('finds a listing through its primary and through its additional type, never through an unrelated type', async () => {
    const { service } = searchService(listingDb());
    expect(ids(await service.listPublished({ purposeSubcategoryId: String(APARTMENT) }))).toEqual(n(2, 1));
    expect(ids(await service.listPublished({ purposeSubcategoryId: String(DUPLEX) }))).toEqual(n(5, 3, 1));
    expect(ids(await service.listPublished({ purposeSubcategoryId: String(VILLA) }))).toEqual(n(5, 4));
  });

  it('keeps single-type (backfilled) listings behaving exactly as the primary-only search did', async () => {
    const singleType = listingDb().map((doc) => ({ ...doc, purposeSubcategoryIds: [doc.purposeSubcategoryId] }));
    const { service } = searchService(singleType);
    for (const type of [APARTMENT, DUPLEX, VILLA]) {
      const expected = singleType.filter((doc) => doc.isOwnerVisible && idOf(doc.purposeSubcategoryId) === idOf(type)).sort((a, b) => +b.createdAt - +a.createdAt).map((doc) => String(doc._id));
      expect(ids(await service.listPublished({ purposeSubcategoryId: String(type) }))).toEqual(expected);
    }
  });

  it('keeps purpose-only, no-type and non-type filters unchanged', async () => {
    const { service, filters } = searchService(listingDb());
    expect(ids(await service.listPublished({ purposeCategoryId: CATEGORY_RES }))).toEqual(n(5, 4, 3, 2, 1));
    expect(ids(await service.listPublished({}))).toEqual(n(6, 5, 4, 3, 2, 1));
    await service.listPublished({ governorateCode: 'giza', minPriceMinor: 1 });
    for (const filter of [filters[0], filters[1], filters[2]]) {
      expect(filter).not.toHaveProperty('purposeSubcategoryIds');
      expect(filter).not.toHaveProperty('purposeSubcategoryId');
    }
    expect(Object.keys(filters[2]).sort()).toEqual(['currentPublicRevisionId', 'governorateCode', 'isOwnerVisible', 'lifecycleStatus', 'status', 'totalPriceMinor']);
  });

  it('combines the type with price and governorate filters', async () => {
    const { service } = searchService(listingDb());
    expect(ids(await service.listPublished({ purposeSubcategoryId: String(DUPLEX), maxPriceMinor: 300_000 }))).toEqual(n(3, 1));
    expect(ids(await service.listPublished({ purposeSubcategoryId: String(DUPLEX), minPriceMinor: 400_000 }))).toEqual(n(5));
    expect(ids(await service.listPublished({ purposeSubcategoryId: String(DUPLEX), governorateCode: 'giza' }))).toEqual(n(3));
    expect(ids(await service.listPublished({ purposeSubcategoryId: String(DUPLEX), sort: 'price_desc' }))).toEqual(n(5, 3, 1));
  });

  it('paginates by createdAt with correct totals and no duplicate rows from the multikey array', async () => {
    const { service } = searchService(listingDb());
    const first = await service.listPublished({ purposeSubcategoryId: String(DUPLEX), limit: 2, page: 1 });
    const second = await service.listPublished({ purposeSubcategoryId: String(DUPLEX), limit: 2, page: 2 });
    expect(first.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect([...ids(first), ...ids(second)]).toEqual(n(5, 3, 1));
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(3);
  });

  it('builds the type filter on purposeSubcategoryIds with the derived purpose, keeping hierarchy validation', async () => {
    const { service, filters } = searchService(listingDb());
    await service.listPublished({ purposeSubcategoryId: String(DUPLEX) });
    expect(filters[0]).toMatchObject({ purposeSubcategoryIds: DUPLEX, purposeCategoryId: PURPOSE_RES });
    expect(filters[0]).not.toHaveProperty('purposeSubcategoryId');
    await expect(service.listPublished({ purposeSubcategoryId: String(OFFICE), purposeCategoryId: CATEGORY_RES }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'PROPERTY_PURPOSE_HIERARCHY_MISMATCH' }) });
  });
});

describe('DPF-007 auction discovery inherits the any-type match', () => {
  it('lists auctions on listings that selected the type as an additional type', async () => {
    const properties = listingDb();
    const auctions = properties.map((property, index) => ({
      _id: oid(500 + index), propertyId: property._id, propertyRevisionId: property.currentPublicRevisionId, status: 'active',
      startingPriceMinor: 1000, minimumBidStepMinor: 100, currency: 'EGP', createdAt: new Date(Date.UTC(2026, 1, index + 1)),
    }));
    const db = new MemoryDb().seed('properties', properties).seed('auctions', auctions).seed('property_types', types());
    const { service: propertiesService } = searchService(properties);
    (propertiesService as any).getAnchoredPublicProjections = async (pairs: Array<{ propertyId: string; revisionId: string }>) =>
      new Map(pairs.map((pair) => [`${pair.propertyId}:${pair.revisionId}`, { id: pair.propertyId }]));
    const query = Object.create(AuctionsQueryService.prototype) as any;
    Object.assign(query, {
      auctions: { aggregate: (pipeline: Doc[]) => ({ exec: async () => db.aggregate('auctions', pipeline) }) },
      properties: propertiesService,
      clock: { now: () => new Date('2026-03-01T00:00:00Z') },
    });
    const listed = async (type: ObjectId) => (await query.listPublic({ purposeSubcategoryId: String(type) })).items.map((item: any) => item.property.id);
    expect(await listed(DUPLEX)).toEqual(n(5, 3, 1));
    expect(await listed(APARTMENT)).toEqual(n(2, 1));
    const match = await propertiesService.buildPublicPropertyMatchForAuctions({ purposeSubcategoryId: String(VILLA) });
    expect(match).toMatchObject({ purposeSubcategoryIds: VILLA });
    expect(match).not.toHaveProperty('purposeSubcategoryId');
  });
});

describe('DPF-007 M-G listing indexes', () => {
  const listingIndexes = () => PropertySchema.indexes().filter(([, options]) => String((options as any)?.name ?? '').startsWith('property_public_listing_'));

  it('declares the exact frozen shapes and no longer declares the replaced index', () => {
    const byName = Object.fromEntries(listingIndexes().map(([key, options]) => [(options as any).name, JSON.stringify(key)]));
    expect(byName.property_public_listing_purpose_category).toBe(JSON.stringify({ status: 1, isOwnerVisible: 1, lifecycleStatus: 1, purposeCategoryId: 1, createdAt: -1 }));
    expect(byName.property_public_listing_type).toBe(JSON.stringify({ status: 1, isOwnerVisible: 1, lifecycleStatus: 1, purposeSubcategoryIds: 1, createdAt: -1 }));
    expect(byName).not.toHaveProperty('property_public_listing_purpose');
    expect(Object.keys(byName).sort()).toEqual([
      'property_public_listing_governorate', 'property_public_listing_newest', 'property_public_listing_operation_type',
      'property_public_listing_price', 'property_public_listing_purpose_category', 'property_public_listing_type',
    ]);
    expect(listingIndexes().length).toBeLessThanOrEqual(8);
    // Only one array field per compound index (a MongoDB multikey constraint).
    for (const [key] of listingIndexes()) expect(Object.keys(key).filter((field) => ['purposeSubcategoryIds', 'amenityCodes', 'paymentMethodCodes'].includes(field)).length).toBeLessThanOrEqual(1);
  });

  it('creates both indexes through the migration, idempotently, and validates their exact keys', async () => {
    const db = new MemoryDb();
    db.indexes.set('properties', [{ name: RETIRED_PURPOSE_LISTING_INDEX.options.name, key: RETIRED_PURPOSE_LISTING_INDEX.key }]);
    const store = new MemoryStore();
    store.markComplete('022-property-type-selection-backfill');
    const report = await new MigrationRunner(db as any, store).run(propertyTypeListingIndexesMigration, 'apply');
    expect(report.status).toBe('complete');
    expect((db.indexes.get('properties') ?? []).map((index) => [index.name, JSON.stringify(index.key)])).toEqual([
      [RETIRED_PURPOSE_LISTING_INDEX.options.name, JSON.stringify(RETIRED_PURPOSE_LISTING_INDEX.key)],
      ...PROPERTY_TYPE_LISTING_INDEXES.map((index) => [index.options.name, JSON.stringify(index.key)]),
    ]);
    const fresh = new MemoryStore();
    fresh.markComplete('022-property-type-selection-backfill');
    expect(await new MigrationRunner(db as any, fresh).run(propertyTypeListingIndexesMigration, 'apply')).toMatchObject({ status: 'complete', preflight: { eligible: 0, alreadyApplied: 2 } });
  });

  it('blocks when an index of the same name exists with another key, and requires the backfill first', async () => {
    const db = new MemoryDb();
    db.indexes.set('properties', [{ name: 'property_public_listing_type', key: { status: 1, purposeSubcategoryId: 1 } }]);
    const store = new MemoryStore();
    store.markComplete('022-property-type-selection-backfill');
    await expect(new MigrationRunner(db as any, store).run(propertyTypeListingIndexesMigration, 'apply')).rejects.toThrow(/PROPERTY_LISTING_INDEX_CONFLICT/);
    await expect(new MigrationRunner(new MemoryDb() as any, new MemoryStore()).run(propertyTypeListingIndexesMigration, 'apply')).rejects.toThrow(/Dependency 022-property-type-selection-backfill/);
    expect(propertyTypeListingIndexesMigration.dependencies).toEqual(['022-property-type-selection-backfill']);
  });

  it('retires the replaced index only when explicitly selected, after the replacements and backfill are in place', async () => {
    expect(retirePurposeListingIndexMigration.manualOnly).toBe(true);
    expect(selectMigrations(CORE_MIGRATIONS).map((migration) => migration.id)).not.toContain(retirePurposeListingIndexMigration.id);
    expect(selectMigrations(CORE_MIGRATIONS).map((migration) => migration.id)).toEqual(expect.arrayContaining(['022-property-type-selection-backfill', '023-property-type-listing-indexes']));
    expect(selectMigrations(CORE_MIGRATIONS, retirePurposeListingIndexMigration.id)).toEqual([retirePurposeListingIndexMigration]);

    const retired = { name: RETIRED_PURPOSE_LISTING_INDEX.options.name, key: RETIRED_PURPOSE_LISTING_INDEX.key as Doc };
    const store = () => { const value = new MemoryStore(); value.markComplete('023-property-type-listing-indexes'); return value; };

    const withoutReplacements = new MemoryDb();
    withoutReplacements.indexes.set('properties', [retired]);
    await expect(new MigrationRunner(withoutReplacements as any, store()).run(retirePurposeListingIndexMigration, 'apply')).rejects.toThrow(/PROPERTY_LISTING_REPLACEMENT_INDEX_MISSING/);
    expect(withoutReplacements.indexes.get('properties')).toEqual([retired]);

    const notBackfilled = new MemoryDb().seed('properties', [{ _id: oid(1), purposeSubcategoryId: APARTMENT }]);
    notBackfilled.indexes.set('properties', [retired, ...PROPERTY_TYPE_LISTING_INDEXES.map((index) => ({ name: index.options.name, key: index.key as Doc }))]);
    await expect(new MigrationRunner(notBackfilled as any, store()).run(retirePurposeListingIndexMigration, 'apply')).rejects.toThrow(/PROPERTY_TYPE_SELECTION_BACKFILL_INCOMPLETE/);
    expect(notBackfilled.indexes.get('properties')).toContainEqual(retired);

    const ready = new MemoryDb();
    ready.indexes.set('properties', [retired, ...PROPERTY_TYPE_LISTING_INDEXES.map((index) => ({ name: index.options.name, key: index.key as Doc }))]);
    expect(await new MigrationRunner(ready as any, store()).run(retirePurposeListingIndexMigration, 'apply')).toMatchObject({ status: 'complete', modified: 1 });
    expect((ready.indexes.get('properties') ?? []).map((index) => index.name)).toEqual(PROPERTY_TYPE_LISTING_INDEXES.map((index) => index.options.name));
    expect(await new MigrationRunner(ready as any, store()).run(retirePurposeListingIndexMigration, 'apply')).toMatchObject({ status: 'complete', modified: 0 });
  });

  it('keeps the migration registry valid and ordered backfill -> create -> retire', () => {
    const order = CORE_MIGRATIONS.map((migration) => migration.id);
    expect(order.indexOf('022-property-type-selection-backfill')).toBeLessThan(order.indexOf('023-property-type-listing-indexes'));
    expect(order.indexOf('023-property-type-listing-indexes')).toBeLessThan(order.indexOf('024-retire-property-purpose-listing-index'));
    expect(retirePurposeListingIndexMigration.rollback).toMatchObject({ kind: 'automatic' });
  });
});

// Evaluator self-check: MongoDB rejects $in on a non-array; the selection expressions must never hit that.
describe('evaluator guards', () => {
  it('throws on $in over a non-array so an unsafe expression cannot pass silently', () => {
    expect(() => evaluate({ $in: ['$a', '$b'] }, { a: 1, b: null })).toThrow();
  });
});

// ================================================================= DPF-008 (Backend contract)
describe('DPF-008 admin reads expose the reviewed classification as propertyTypes', () => {
  const catalog = [
    { _id: APARTMENT, code: 'apartment', nameAr: 'شقة', iconKey: 'building', sortOrder: 1 },
    { _id: DUPLEX, code: 'duplex', nameAr: 'دوبلكس', iconKey: 'duplex', sortOrder: 2 },
    { _id: VILLA, code: 'villa', nameAr: 'فيلا', iconKey: 'villa', sortOrder: 3 },
  ];
  const revision = (id: ObjectId, primary: ObjectId, selection: ObjectId[], status: string) => ({
    _id: id, revisionNumber: 1, title: 'عقار', moderationStatus: status, decisionVersion: 0, purposeSubcategoryId: primary, purposeSubcategoryIds: selection,
    legacyPropertyTypeCode: 'apartment', galleryMedia: [], privateEvidenceAssets: [], totalPriceMinor: 100, currency: 'EGP',
  });
  const aggregate = (extra: Doc) => ({ _id: oid(1), title: 'عقار', status: 'approved', lifecycleStatus: 'active', createdAt: new Date(), images: [], propertyContractVersion: 1, totalPriceMinor: 100, currency: 'EGP', ...extra });
  const adminService = (items: Doc[], revisions: Doc[] = []) => {
    const service = Object.create(PropertiesService.prototype) as any;
    const chain = (value: unknown) => { const query: any = { sort: () => query, skip: () => query, limit: () => query, populate: () => query, lean: () => query, exec: async () => value }; return query; };
    const typesFind = jest.fn((filter: Doc) => chain(catalog.filter((type) => matches(type, filter))));
    Object.assign(service, {
      properties: { find: () => chain(items), findById: () => chain(items[0]), countDocuments: () => ({ exec: async () => items.length }) },
      revisions: { find: () => chain(revisions) },
      propertyTypes: { find: typesFind },
      purposeCategories: { find: () => chain([]) },
      options: { find: () => chain([]) },
    });
    return { service, typesFind };
  };

  it('lists the pending revision\'s types (primary first) and falls back to the public revision', async () => {
    const pending = revision(oid(201), DUPLEX, [APARTMENT, DUPLEX, VILLA], 'pending_review');
    const current = revision(oid(202), APARTMENT, [APARTMENT], 'approved');
    const { service, typesFind } = adminService([
      aggregate({ pendingRevisionId: pending, currentPublicRevisionId: current }),
      aggregate({ _id: oid(2), currentPublicRevisionId: revision(oid(203), APARTMENT, [APARTMENT, VILLA], 'approved') }),
    ]);
    const { items } = await service.listForAdmin({});
    expect(items[0].propertyTypes.map((type: any) => [type.nameAr, type.isPrimary])).toEqual([['دوبلكس', true], ['شقة', false], ['فيلا', false]]);
    expect(items[1].propertyTypes.map((type: any) => [type.nameAr, type.isPrimary])).toEqual([['شقة', true], ['فيلا', false]]);
    expect(items[0].propertyTypes[0]).toEqual({ id: String(DUPLEX), code: 'duplex', nameAr: 'دوبلكس', iconKey: 'duplex', isPrimary: true });
    expect(typesFind).toHaveBeenCalledTimes(1);
  });

  it('returns the reviewed classification at the top of the admin detail and per revision', async () => {
    const pending = revision(oid(201), DUPLEX, [DUPLEX, VILLA], 'pending_review');
    const current = revision(oid(202), APARTMENT, [APARTMENT, DUPLEX], 'approved');
    const { service } = adminService([aggregate({ pendingRevisionId: pending, currentPublicRevisionId: current })], [pending, current]);
    const { property } = await service.getForAdmin(String(oid(1)));
    expect(property.propertyTypes.map((type: any) => type.id)).toEqual([String(DUPLEX), String(VILLA)]);
    expect(property.pendingRevision.propertyTypes.map((type: any) => [type.nameAr, type.isPrimary])).toEqual([['دوبلكس', true], ['فيلا', false]]);
    expect(property.currentPublicRevision.propertyTypes.map((type: any) => [type.nameAr, type.isPrimary])).toEqual([['شقة', true], ['دوبلكس', false]]);
  });
});
