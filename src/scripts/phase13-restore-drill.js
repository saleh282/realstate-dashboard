'use strict';

/**
 * Disposable backup/restore drill (Phase 13) - an ENGINEERING rehearsal only.
 *
 * The "snapshot" is a logical copy (documents + index definitions) into a second
 * disposable database. It is NOT a production backup mechanism: retention,
 * schedule, point-in-time recovery, RPO and RTO are Operations decisions and are
 * deliberately not defined here.
 *
 *   DEPLOYMENT_ENV=local NODE_ENV=development DESTRUCTIVE_CONFIRM=RESET_DISPOSABLE_DATABASE \
 *   MONGO_URI=mongodb://127.0.0.1:PORT/mazad_phase13_drill?replicaSet=... \
 *   node src/scripts/phase13-restore-drill.js --source=mazad_phase13_rehearsal [--keep] [--out=FILE]
 *
 * Steps: clone the source into the drill database, verify it is healthy, take a
 * snapshot, apply a "release" that goes wrong (a divergent form publication and a
 * migration that fails halfway), prove the damage is detected, restore from the
 * snapshot, then verify the migration ledger, catalog counts, form hashes,
 * integrity and the critical smoke flows (the extended local E2E).
 */
require('dotenv/config');
const { spawnSync } = require('node:child_process');
const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { MongoClient, ObjectId } = require('mongodb');
const { canonicalize, sha256 } = require('../services/idempotency.service');
const { guardAction } = require('../config/deployment-environment');
const { MigrationRunner } = require('../migrations/framework/migration.runner');
const { MongoMigrationStore } = require('../migrations/framework/migration.store');
const { runIntegrityChecks } = require('../migrations/integrity-checker');
const {
  computeFormContentHash,
} = require('../domain/property-form-definitions/property-form-definition.constants');
const { storedContent } = require('../domain/property-form-definitions/form-definition-drafts');
const { verifyAgainstManifest } = require('../release/baseline-manifest');
const { DISPOSABLE_DB_PREFIX, assertDisposableTarget } = require('./disposable-target');
const { readFileSync } = require('node:fs');
const flag = (name) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const EXPECTED = {
  property_purpose_categories: 4,
  property_types: 19,
  property_attributes: 27,
  amenities: 12,
  governorates: 27,
  cities: 123,
  property_options: 12,
  property_form_definitions: 19,
};
const steps = [];
const record = (step, ok, evidence = {}) => {
  steps.push({ step, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}`);
};
async function copyDatabase(from, to, options) {
  const collections = (await from.listCollections({}, { nameOnly: true }).toArray())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('system.'));
  if (options.replace) {
    for (const existing of (await to.listCollections({}, { nameOnly: true }).toArray()).map(
      (entry) => entry.name,
    ))
      await to.collection(existing).drop();
  }
  for (const name of collections) {
    const source = from.collection(name);
    const target = to.collection(name);
    const docs = await source.find({}).toArray();
    for (let index = 0; index < docs.length; index += 2000)
      await target.insertMany(docs.slice(index, index + 2000), { ordered: true });
    if (!docs.length) await to.createCollection(name).catch(() => undefined);
    for (const spec of await source.indexes()) {
      if (spec.name === '_id_') continue;
      const { key, name: indexName, v, ns, ...rest } = spec;
      await target.createIndex(key, { name: indexName, ...rest });
    }
  }
  return collections;
}
/** Per-collection document count + content hash (documents sorted by _id, ObjectIds and dates canonicalised). */
async function fingerprint(db) {
  const out = {};
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.')) continue;
    const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    out[name] = {
      count: docs.length,
      hash: sha256(canonicalize(docs)),
      indexes: (await db.collection(name).indexes()).map((spec) => String(spec.name)).sort(),
    };
  }
  return out;
}
const diff = (a, b) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (name) => JSON.stringify(a[name]) !== JSON.stringify(b[name]),
  );
async function health(db, manifest) {
  const verify = await verifyAgainstManifest(db, manifest);
  const integrity = await runIntegrityChecks(db);
  const ledger = await db
    .collection('migration_ledger')
    .find({})
    .project({ migrationId: 1, status: 1 })
    .sort({ migrationId: 1 })
    .toArray();
  const lock = await db.collection('migration_locks').findOne({});
  const counts = Object.fromEntries(
    await Promise.all(
      Object.keys(EXPECTED).map(async (name) => [
        name,
        await db
          .collection(name)
          .countDocuments(
            name === 'property_form_definitions' ? { currentVersionId: { $exists: true } } : {},
          ),
      ]),
    ),
  );
  return { verify, integrity, ledger, lock, counts };
}
async function main() {
  const { uri, database } = assertDisposableTarget(process.env.MONGO_URI);
  await guardAction('destructive:reset', process.env);
  const sourceName = flag('source');
  if (!sourceName) throw new Error('--source=<database> is required');
  const snapshotName = `${database}_snapshot`;
  if (
    ![database, snapshotName, sourceName].every(
      (name) => name.startsWith(DISPOSABLE_DB_PREFIX) || name === 'mazad_phase12_disposable',
    ) ||
    sourceName === database
  )
    throw new Error('Refused: unexpected database names');
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '../release/baseline-manifest.v1.json'), 'utf8'),
  );
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const source = client.db(sourceName);
    const drill = client.db(database);
    const snapshot = client.db(snapshotName);
    await drill.dropDatabase();
    await snapshot.dropDatabase();
    // 1. clone + baseline health
    const cloned = await copyDatabase(source, drill, { replace: false });
    const baseline = await health(drill, manifest);
    const baselineOk =
      baseline.verify.ok &&
      baseline.integrity.ok &&
      baseline.integrity.warningCount === 0 &&
      !baseline.lock &&
      baseline.ledger.every((row) => row.status === 'complete') &&
      Object.entries(EXPECTED).every(([name, count]) => baseline.counts[name] === count);
    record(
      '1 baseline cloned and healthy (manifest, integrity, ledger, catalog counts)',
      baselineOk,
      {
        collections: cloned.length,
        manifest: baseline.verify.counts,
        integrity: {
          errors: baseline.integrity.errorCount,
          warnings: baseline.integrity.warningCount,
        },
        ledgerRows: baseline.ledger.length,
        counts: baseline.counts,
      },
    );
    // 2. snapshot
    const before = await fingerprint(drill);
    await copyDatabase(drill, snapshot, { replace: false });
    const snapshotPrint = await fingerprint(snapshot);
    record(
      '2 snapshot taken and identical to the source state',
      diff(before, snapshotPrint).length === 0,
      { collections: Object.keys(before).length, differing: diff(before, snapshotPrint) },
    );
    // 3. a release that goes wrong
    const shopType = await drill.collection('property_types').findOne({ code: 'shop' });
    const head = await drill
      .collection('property_form_definitions')
      .findOne({ purposeSubcategoryId: shopType._id });
    const current = await drill
      .collection('property_form_definition_versions')
      .findOne({ _id: head.currentVersionId });
    const badContent = { ...storedContent(current), allowedAmenityCodes: ['elevator'] };
    const badVersionId = new ObjectId();
    await drill
      .collection('property_form_definition_versions')
      .updateOne({ _id: current._id }, { $set: { state: 'superseded' } });
    await drill.collection('property_form_definition_versions').insertOne({
      ...current,
      _id: badVersionId,
      version: current.version + 1,
      allowedAmenityCodes: ['elevator'],
      contentHash: computeFormContentHash(badContent),
      publishedAt: new Date(),
    });
    await drill
      .collection('property_form_definitions')
      .updateOne(
        { _id: head._id },
        { $set: { currentVersionId: badVersionId, currentVersion: current.version + 1 } },
      );
    let batches = 0;
    const broken = {
      id: '999-drill-broken-release',
      version: 1,
      description: 'drill: fails halfway',
      rollback: {
        kind: 'none',
        remediation: 'restore the snapshot',
        restoreProcedure: 'restore the snapshot',
      },
      async preflight() {
        return { eligible: 12, alreadyApplied: 0, blockers: [] };
      },
      async migrateBatch({ db, checkpoint }) {
        batches += 1;
        if (batches === 3) throw new Error('simulated failure halfway through the migration');
        const rows = await db
          .collection('property_options')
          .find(checkpoint ? { _id: { $gt: new ObjectId(checkpoint) } } : {})
          .sort({ _id: 1 })
          .limit(4)
          .toArray();
        await db
          .collection('property_options')
          .updateMany(
            { _id: { $in: rows.map((row) => row._id) } },
            { $set: { drillMarker: true } },
          );
        return {
          scanned: rows.length,
          modified: rows.length,
          checkpoint: String(rows[rows.length - 1]._id),
          done: false,
        };
      },
      async validate() {
        return { valid: true, errors: [] };
      },
    };
    let failure = '';
    try {
      await new MigrationRunner(drill, new MongoMigrationStore(drill), { batchSize: 4 }).run(
        broken,
        'apply',
      );
    } catch (error) {
      failure = error.message;
    }
    const damaged = await health(drill, manifest);
    const marked = await drill.collection('property_options').countDocuments({ drillMarker: true });
    const failedRow = damaged.ledger.find((row) => row.migrationId === '999-drill-broken-release');
    record(
      '3 the failed release is detected: divergent form, failed ledger row, partial data change',
      !damaged.verify.ok &&
        failedRow?.status === 'failed' &&
        marked === 8 &&
        failure.includes('halfway'),
      {
        manifestOk: damaged.verify.ok,
        divergent: damaged.verify.items
          .filter((item) => item.verdict === 'diverge')
          .map((item) => item.id),
        ledger: failedRow,
        partiallyMarked: marked,
      },
    );
    // 4. restore in place from the snapshot
    await copyDatabase(snapshot, drill, { replace: true });
    // 5. verify the restore
    const after = await health(drill, manifest);
    const afterPrint = await fingerprint(drill);
    const drift = diff(before, afterPrint);
    record(
      '5a restored database is byte-for-byte the snapshot (counts, content hashes, indexes)',
      drift.length === 0,
      { differing: drift },
    );
    record(
      '5b migration ledger restored: no failed row, no held lock, all complete',
      !after.ledger.some((row) => row.migrationId === '999-drill-broken-release') &&
        !after.lock &&
        after.ledger.every((row) => row.status === 'complete') &&
        JSON.stringify(after.ledger) === JSON.stringify(baseline.ledger),
      { ledgerRows: after.ledger.length, lockHeld: Boolean(after.lock) },
    );
    record(
      '5c catalog counts restored',
      Object.entries(EXPECTED).every(([name, count]) => after.counts[name] === count),
      { counts: after.counts },
    );
    const shopForm = after.verify.items.find((item) => item.area === 'forms' && item.id === 'shop');
    record(
      '5d all 19 form hashes match the release manifest again',
      after.verify.ok &&
        after.verify.counts.diverge === 0 &&
        shopForm?.verdict === 'match' &&
        after.verify.items.filter((item) => item.area === 'forms' && item.verdict === 'match')
          .length === 19,
      { counts: after.verify.counts },
    );
    record(
      '5e integrity after restore is clean',
      after.integrity.ok && after.integrity.warningCount === 0,
      { errors: after.integrity.errorCount, warnings: after.integrity.warningCount },
    );
    const partial = await drill
      .collection('property_options')
      .countDocuments({ drillMarker: true });
    record('5f no residue of the failed release remains', partial === 0, {
      markedDocuments: partial,
    });
    // 6. critical smoke flows on the restored database
    const smoke = spawnSync('npx', ['jest', 'test/phase13-local-e2e.spec.js'], {
      cwd: join(__dirname, '../..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        PHASE13_LOCAL_E2E: '1',
        NODE_ENV: 'development',
        DEPLOYMENT_ENV: 'local',
        MONGO_URI: uri,
        PHASE12_DISPOSABLE_DB: '',
      },
    });
    const summary = /Tests:\s+(.*)/.exec(`${smoke.stdout}${smoke.stderr}`)?.[1] ?? 'no summary';
    record(
      'Smoke flows pass on the restored database (property and managed marketing)',
      smoke.status === 0,
      { summary },
    );
    const report = {
      generatedAt: new Date().toISOString(),
      note: 'engineering rehearsal; not a production backup policy',
      source: sourceName,
      database,
      snapshot: snapshotName,
      ok: steps.every((step) => step.ok),
      steps,
    };
    const out = flag('out');
    if (out) await writeFile(out, JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        ok: report.ok,
        passed: steps.filter((step) => step.ok).length,
        total: steps.length,
      }),
    );
    if (!process.argv.includes('--keep')) {
      await drill.dropDatabase();
      await snapshot.dropDatabase();
    }
    if (!report.ok) process.exitCode = 1;
  } finally {
    await client.close();
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[REDACTED_URI]')
      : 'restore drill failed',
  );
  process.exitCode = 1;
});
