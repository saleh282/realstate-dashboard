'use strict';

/**
 * Synthetic scale harness (Phase 13). Loads a deterministic, realistically
 * skewed marketplace into a DISPOSABLE local database and measures the real
 * public-listing / admin-queue queries with explain and
 * wall-clock timings.
 *
 *   DEPLOYMENT_ENV=local NODE_ENV=development \
 *   MONGO_URI=mongodb://127.0.0.1:PORT/mazad_phase13_scale?replicaSet=... \
 *   DESTRUCTIVE_CONFIRM=RESET_DISPOSABLE_DATABASE \
 *   node src/scripts/phase13-scale-harness.js --scale=100000 [--catalog-from=<db>] [--out=FILE]
 *   ... --measure-only        (re-measure after index changes without reloading data)
 *
 * Safety: refuses anything but localhost, a database named mazad_phase13_*,
 * and a `local` deployment. Loading DROPS that database (destructive:reset
 * needs DESTRUCTIVE_CONFIRM). Index definitions are read from the CURRENT
 * schemas, so re-running after a schema change measures the new indexes.
 * The queries are built by the real service code (filter, sort, pipelines).
 */
require('dotenv/config');
const { writeFile } = require('node:fs/promises');
const { MongoClient, ObjectId } = require('mongodb');
const { guardAction } = require('../config/deployment-environment');
const { assertDisposableTarget } = require('./disposable-target');
const { PropertiesService } = require('../services/properties.service');
const { PropertySchema } = require('../models/property.model');
const { PropertyRevisionSchema } = require('../models/property-revision.model');
const flag = (name) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name) => process.argv.includes(`--${name}`);
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickWeighted = (rand, items) => {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rand() * total;
  for (const [item, weight] of items) {
    roll -= weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1][0];
};
const GOVERNORATES = [
  ['cairo', 30],
  ['giza', 20],
  ['alexandria', 12],
  ['qalyubia', 6],
  ['sharqia', 5],
  ['dakahlia', 4],
  ['red_sea', 3],
  ['south_sinai', 3],
  ['matrouh', 3],
  ['luxor', 2],
  ['aswan', 2],
  ['minya', 2],
  ['assiut', 2],
  ['ismailia', 2],
  ['suez', 2],
  ['beheira', 2],
];
const FACET_TYPES = {
  shop: () => ({ shopFloorLevel: 'ground', commercialUseTypes: ['retail'] }),
  factory: () => ({ builtAreaSqm: 500, powerSource: 'grid', industrialUseType: 'light' }),
  agricultural_land: () => ({ soilType: 'clay', waterSource: 'well' }),
};
const guardTarget = () => assertDisposableTarget(process.env.MONGO_URI);
async function load(db, source, scale) {
  const rand = mulberry32(13);
  for (const name of ['properties', 'property_revisions'])
    await db
      .collection(name)
      .drop()
      .catch(() => undefined);
  for (const name of ['property_types', 'property_purpose_categories']) {
    await db
      .collection(name)
      .drop()
      .catch(() => undefined);
    if (source) {
      const rows = await source.collection(name).find({}).toArray();
      if (rows.length) await db.collection(name).insertMany(rows);
    }
  }
  const types = await db.collection('property_types').find({}).toArray();
  if (!types.length)
    throw new Error('No property types found; pass --catalog-from=<database holding the catalog>');
  const typeWeight = (code) =>
    ['apartment', 'villa', 'shop', 'office', 'studio'].includes(code) ? 8 : 2;
  const now = Date.now();
  const twoYears = 730 * 86_400_000;
  const advertisers = Array.from(
    { length: Math.max(50, Math.floor(scale / 20)) },
    () => new ObjectId(),
  );
  const properties = [];
  const revisions = [];
  const flush = async () => {
    if (properties.length)
      await db.collection('properties').insertMany(properties.splice(0), { ordered: false });
    if (revisions.length)
      await db.collection('property_revisions').insertMany(revisions.splice(0), { ordered: false });
  };
  for (let index = 0; index < scale; index++) {
    const type = pickWeighted(
      rand,
      types.map((row) => [row, typeWeight(String(row.code))]),
    );
    const extra = rand() < 0.2 ? [types[Math.floor(rand() * types.length)]] : [];
    const selected = [
      ...new Map([type, ...extra].map((row) => [String(row._id), row._id])).values(),
    ];
    const governorateCode = pickWeighted(rand, GOVERNORATES);
    const status = pickWeighted(rand, [
      ['approved', 92],
      ['pending_review', 5],
      ['rejected', 3],
    ]);
    const lifecycleStatus = pickWeighted(rand, [
      ['active', 94],
      ['archived', 4],
      ['admin_hidden', 2],
    ]);
    const createdAt = new Date(now - Math.floor(rand() * twoYears));
    const revisionId = new ObjectId();
    const city = `city-${governorateCode}-${Math.floor(rand() * 5)}`;
    const totalPriceMinor = Math.round(Math.exp(13 + rand() * 4) / 100) * 100;
    const facets = FACET_TYPES[String(type.code)]?.();
    properties.push({
      _id: new ObjectId(),
      ownerId: advertisers[index % advertisers.length],
      advertiserAccountId: advertisers[index % advertisers.length],
      currentPublicRevisionId: status === 'approved' ? revisionId : undefined,
      lifecycleStatus,
      revisionSequence: 1,
      isOwnerVisible: rand() < 0.97,
      status,
      operationType: rand() < 0.7 ? 'sale' : 'rent',
      propertyTypeCode: String(type.code),
      purposeCategoryId: type.purposeCategoryId,
      purposeSubcategoryId: type._id,
      purposeSubcategoryIds: selected,
      title: `Synthetic property ${index}`,
      description: 'Synthetic description '.repeat(20),
      governorateCode,
      city,
      district: 'district',
      latitude: 30,
      longitude: 31,
      area: 60 + Math.floor(rand() * 400),
      totalPriceMinor,
      currency: 'EGP',
      facets,
      createdAt,
      updatedAt: createdAt,
      publishedAt: createdAt,
    });
    const property = properties[properties.length - 1];
    revisions.push({
      _id: revisionId,
      propertyId: property._id,
      revisionNumber: 1,
      moderationStatus: status === 'approved' ? 'approved' : 'pending_review',
      governorateCode,
      city,
      purposeCategoryId: type.purposeCategoryId,
      purposeSubcategoryId: type._id,
      purposeSubcategoryIds: selected,
      operationType: property.operationType,
      totalPriceMinor,
      createdAt,
      updatedAt: createdAt,
    });
    if (properties.length >= 5000) await flush();
  }
  await flush();
  return { properties: await db.collection('properties').countDocuments() };
}
async function buildIndexes(db) {
  const created = {};
  const specs = [
    ['properties', PropertySchema.indexes()],
    ['property_revisions', PropertyRevisionSchema.indexes()],
  ];
  for (const [collection, indexes] of specs) {
    const existing = await db
      .collection(collection)
      .indexes()
      .catch(() => []);
    for (const { name } of existing)
      if (name !== '_id_')
        await db
          .collection(collection)
          .dropIndex(name)
          .catch(() => undefined);
    created[collection] = [];
    for (const [key, options] of indexes)
      created[collection].push(await db.collection(collection).createIndex(key, options));
  }
  return created;
}
const planStages = (plan, acc = []) => {
  if (!plan) return acc;
  acc.push(plan.indexName ? `${plan.stage}(${plan.indexName})` : plan.stage);
  if (plan.inputStage) planStages(plan.inputStage, acc);
  for (const stage of plan.inputStages ?? []) planStages(stage, acc);
  return acc;
};
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
async function timed(run, repeats = 15) {
  const samples = [];
  await run();
  for (let i = 0; i < repeats; i++) {
    const start = process.hrtime.bigint();
    await run();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return {
    p50Ms: +percentile(samples, 0.5).toFixed(2),
    p95Ms: +percentile(samples, 0.95).toFixed(2),
  };
}
async function measure(db) {
  const service = Object.create(PropertiesService.prototype);
  service.propertyTypes = {
    findById: (id) => ({
      lean: () => ({
        exec: () => db.collection('property_types').findOne({ _id: new ObjectId(id) }),
      }),
    }),
  };
  service.purposeCategories = {
    exists: (q) => ({
      exec: async () =>
        (await db.collection('property_purpose_categories').findOne({ _id: new ObjectId(q._id) }))
          ? { _id: 1 }
          : null,
    }),
  };
  const typeOf = async (code) =>
    String((await db.collection('property_types').findOne({ code }))._id);
  const apartment = await typeOf('apartment');
  const shop = await typeOf('shop');
  const results = [];
  const listing = async (name, query, page = 1) => {
    const {
      filter: dimension,
      sort,
      limit,
    } = await service.buildPublicListingQuery({ ...query, page });
    const filter = { ...service.publicVisibilityFilter(), ...dimension };
    const skip = (page - 1) * limit;
    const cursor = () =>
      db.collection('properties').find(filter).sort(sort).skip(skip).limit(limit);
    const explain = await cursor().explain('executionStats');
    const stages = planStages(explain.queryPlanner.winningPlan);
    const timing = await timed(async () => {
      await cursor().toArray();
    });
    const count = await timed(async () => {
      await db.collection('properties').countDocuments(filter);
    }, 5);
    results.push({
      name,
      collection: 'properties',
      stages,
      blockingSort: stages.includes('SORT'),
      index: stages.filter((s) => s.startsWith('IXSCAN')),
      keysExamined: explain.executionStats.totalKeysExamined,
      docsExamined: explain.executionStats.totalDocsExamined,
      returned: explain.executionStats.nReturned,
      serverMs: explain.executionStats.executionTimeMillis,
      ...timing,
      countMs: count.p50Ms,
    });
  };
  await listing('P01 newest, no filter', {});
  await listing('P02 governorate=cairo (hot)', { governorateCode: 'cairo' });
  await listing('P03 governorate=luxor (rare)', { governorateCode: 'luxor' });
  await listing('P04 type=apartment (any-selected)', { purposeSubcategoryId: apartment });
  await listing('P05 type=apartment + cairo', {
    purposeSubcategoryId: apartment,
    governorateCode: 'cairo',
  });
  await listing('P06 operation=sale + cairo', { operationType: 'sale', governorateCode: 'cairo' });
  await listing('P07 price_asc, no filter', { sort: 'price_asc' });
  await listing('P08 price_desc + cairo', { sort: 'price_desc', governorateCode: 'cairo' });
  await listing('P09 price range + cairo', {
    minPriceMinor: 1_000_000,
    maxPriceMinor: 20_000_000,
    governorateCode: 'cairo',
  });
  await listing('P10 city (case-insens.) + cairo', {
    governorateCode: 'cairo',
    city: 'CITY-cairo-1',
  });
  await listing('P11 facet shopFloorLevel (shop)', {
    purposeSubcategoryId: shop,
    shopFloorLevel: 'ground',
  });
  await listing('P12 deep page 50, no filter', {}, 50);
  await listing('P13 text search q', { q: 'property 77' });
  const raw = async (name, collection, filter, sort) => {
    const cursor = () => db.collection(collection).find(filter).sort(sort).limit(20);
    const explain = await cursor().explain('executionStats');
    const stages = planStages(explain.queryPlanner.winningPlan);
    results.push({
      name,
      collection,
      stages,
      blockingSort: stages.includes('SORT'),
      index: stages.filter((s) => s.startsWith('IXSCAN')),
      keysExamined: explain.executionStats.totalKeysExamined,
      docsExamined: explain.executionStats.totalDocsExamined,
      returned: explain.executionStats.nReturned,
      serverMs: explain.executionStats.executionTimeMillis,
      ...(await timed(async () => {
        await cursor().toArray();
      })),
    });
  };
  await raw(
    'Q01 admin review queue (revisions)',
    'property_revisions',
    { moderationStatus: 'pending_review' },
    { createdAt: 1, _id: 1 },
  );
  await raw('Q02 admin property list', 'properties', {}, { createdAt: -1 });
  await raw(
    'Q03 owner "mine"',
    'properties',
    { advertiserAccountId: (await db.collection('properties').findOne({})).advertiserAccountId },
    { createdAt: -1 },
  );
  return results;
}
async function main() {
  const { uri, database } = guardTarget();
  // Every mode rebuilds this database's indexes, so every mode needs the destructive (local-only, confirmed) guard, and it runs before any connection.
  await guardAction('destructive:reset', process.env);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const db = client.db(database);
    const measureOnly = has('measure-only');
    const scale = Number(flag('scale') ?? 10000);
    let loaded;
    if (!measureOnly) {
      const sourceName = flag('catalog-from');
      loaded = await load(db, sourceName ? client.db(sourceName) : undefined, scale);
    }
    const indexes = await buildIndexes(db);
    const results = await measure(db);
    const report = {
      generatedAt: new Date().toISOString(),
      database,
      scale,
      loaded,
      indexes,
      results,
    };
    const out = flag('out');
    if (out) await writeFile(out, JSON.stringify(report, null, 2));
    console.log(
      [
        'name'.padEnd(40),
        'SORT',
        'keys'.padStart(7),
        'docs'.padStart(7),
        'ret'.padStart(4),
        'p50ms'.padStart(8),
        'p95ms'.padStart(8),
        'countMs'.padStart(8),
        'plan',
      ].join(' '),
    );
    for (const r of results)
      console.log(
        [
          r.name.padEnd(40),
          r.blockingSort ? 'YES ' : 'no  ',
          String(r.keysExamined).padStart(7),
          String(r.docsExamined).padStart(7),
          String(r.returned).padStart(4),
          String(r.p50Ms).padStart(8),
          String(r.p95Ms).padStart(8),
          String(r.countMs ?? '').padStart(8),
          r.index.join('+') || r.stages.join('<-'),
        ].join(' '),
      );
  } finally {
    await client.close();
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[REDACTED_URI]')
      : 'harness failed',
  );
  process.exitCode = 1;
});
