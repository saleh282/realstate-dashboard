/**
 * Migration interruption / resume / failure rehearsal (Phase 13) on a DISPOSABLE
 * local database. Engineering evidence, not a production procedure.
 *
 *   DEPLOYMENT_ENV=local NODE_ENV=development DESTRUCTIVE_CONFIRM=RESET_DISPOSABLE_DATABASE \
 *   MONGO_URI=mongodb://127.0.0.1:PORT/mazad_phase13_rehearsal?replicaSet=... \
 *   npx ts-node src/scripts/phase13-migration-rehearsal.ts [--out=FILE]
 *
 * Scenarios (each recorded as PASS/FAIL with its evidence):
 *  1 pre-migration state: SUPER_ADMIN bootstrap + legacy catalog seed + migrations up to 021
 *  2 dry-run performs no write and no ledger row
 *  3 hard crash (SIGKILL) in the middle of a batched backfill: ledger `running`, lock held,
 *    a second runner is refused, the lease expires, the run resumes from its checkpoint
 *    and every document ends backfilled exactly once
 *  4 a failing post-validation marks the ledger `failed` (lock released) and a retry completes
 *  5 a full re-run is a pure no-op (`skipped-complete`)
 *  6 the remaining migrations apply in registry order; manual-only ones stay out of a full apply
 *  7 manual migrations run explicitly, in the documented order
 *  8 release manifest apply + verify, integrity report
 */
import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { guardAction } from '../config/deployment-environment';
import { selectMigrations } from '../migrations/cli';
import { CORE_MIGRATIONS } from '../migrations/framework/core-migrations';
import { MigrationLockError, MigrationRunner } from '../migrations/framework/migration.runner';
import { MongoMigrationStore } from '../migrations/framework/migration.store';
import type { MigrationDefinition } from '../migrations/framework/migration.types';
import { runIntegrityChecks } from '../migrations/integrity-checker';
import { assertDisposableTarget } from './disposable-target';

const LEGACY_COUNT = 1100;
const BATCH = 100;
const CRASH_AFTER_BATCHES = 3;
const LEASE_MS = 4000;
const TARGET_MIGRATION = '022-property-type-selection-backfill';
const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

type Step = { step: string; ok: boolean; evidence: Record<string, unknown> };
const steps: Step[] = [];
const record = (step: string, ok: boolean, evidence: Record<string, unknown> = {}) => { steps.push({ step, ok, evidence }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}`); };

const byId = (id: string) => CORE_MIGRATIONS.find((migration) => migration.id === id)!;
const runner = (db: Db, options: { leaseMs?: number; batchSize?: number } = {}) => new MigrationRunner(db, new MongoMigrationStore(db), { batchSize: options.batchSize ?? 250, leaseMs: options.leaseMs });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function childEnv(extra: Record<string, string> = {}) { return { ...process.env, ...extra } as NodeJS.ProcessEnv; }
function npx(args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync('npx', ['ts-node', ...args], { env: childEnv(extra), encoding: 'utf8', cwd: join(__dirname, '../..') });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/** Child mode: run the target migration and SIGKILL this process at the start of the next batch after N completed. */
async function crashChild() {
  const { uri, database } = assertDisposableTarget(process.env.MONGO_URI);
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(database);
  let batches = 0;
  const crashing: MigrationDefinition = {
    ...byId(TARGET_MIGRATION),
    async migrateBatch(context) {
      if (batches >= CRASH_AFTER_BATCHES) process.kill(process.pid, 'SIGKILL');
      batches += 1;
      return byId(TARGET_MIGRATION).migrateBatch(context);
    },
  };
  await new MigrationRunner(db, new MongoMigrationStore(db), { batchSize: BATCH, leaseMs: LEASE_MS }).run(crashing, 'apply');
}

async function main() {
  if (process.argv.includes('--child-crash')) return crashChild();
  const { uri, database } = assertDisposableTarget(process.env.MONGO_URI);
  await guardAction('destructive:reset', process.env);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const db = client.db(database);
    await db.dropDatabase();
    const password = `Rh${randomBytes(9).toString('hex')}!9`;
    const bootstrapEnv = { SUPER_ADMIN_BOOTSTRAP_CONFIRM: 'CREATE_SUPER_ADMIN', SUPER_ADMIN_EMAIL: 'rehearsal-admin@localhost.test', SUPER_ADMIN_PASSWORD: password, SUPER_ADMIN_FULL_NAME: 'Rehearsal Admin', PHASE12_DISPOSABLE_DB: '1' };

    // 1. pre-migration state
    const seed = npx(['src/seeds/super-admin.seed.ts'], bootstrapEnv);
    const legacy = npx(['src/seeds/baseline-catalog.seed.ts'], bootstrapEnv);
    const admin = await db.collection('users').findOne({ systemRole: 'SUPER_ADMIN' });
    await new MongoMigrationStore(db).ensureIndexes();
    const order = selectMigrations(CORE_MIGRATIONS).map((migration) => migration.id);
    const beforeTarget = order.slice(0, order.indexOf(TARGET_MIGRATION));
    for (const id of beforeTarget) await runner(db).run(byId(id), 'apply');
    const types = await db.collection('property_types').find({}).limit(3).toArray();
    const legacyDocs = Array.from({ length: LEGACY_COUNT }, (_, index) => ({
      _id: new ObjectId(), ownerId: admin!._id, advertiserAccountId: admin!._id, status: 'pending_review', lifecycleStatus: 'active', operationType: 'sale',
      propertyTypeCode: types[index % types.length].code, purposeCategoryId: types[index % types.length].purposeCategoryId, purposeSubcategoryId: types[index % types.length]._id,
      title: `Legacy ${index}`, description: 'legacy row', governorateCode: 'cairo', city: 'القاهرة', district: 'd', latitude: 30, longitude: 31, area: 100, totalPriceMinor: 100_000_000, currency: 'EGP', createdAt: new Date(), updatedAt: new Date(),
    }));
    await db.collection('properties').insertMany(legacyDocs);
    record('1 pre-migration state built', seed.code === 0 && legacy.code === 0 && beforeTarget.length > 0, { superAdmin: Boolean(admin), migrationsBeforeTarget: beforeTarget.length, legacyProperties: LEGACY_COUNT });

    // 2. dry-run
    const dry = await runner(db, { batchSize: BATCH }).run(byId(TARGET_MIGRATION), 'dry-run');
    const untouched = await db.collection('properties').countDocuments({ purposeSubcategoryIds: { $exists: false } });
    const ledgerRow = await new MongoMigrationStore(db).get(TARGET_MIGRATION);
    record('2 dry-run writes nothing and creates no ledger row', dry.status === 'dry-run-complete' && untouched === LEGACY_COUNT && ledgerRow === null, { status: dry.status, eligible: (dry as any).preflight?.eligible, untouched });

    // 3. hard crash mid-batch, lock contention, lease expiry, resume
    const child = spawn('npx', ['ts-node', 'src/scripts/phase13-migration-rehearsal.ts', '--child-crash'], { env: childEnv({ PHASE13_CHILD: '1' }), cwd: join(__dirname, '../..'), stdio: 'ignore' });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    const afterCrash = await new MongoMigrationStore(db).get(TARGET_MIGRATION);
    const lock = await db.collection('migration_locks').findOne({ _id: 'global' as never });
    const doneBeforeResume = await db.collection('properties').countDocuments({ purposeSubcategoryIds: { $exists: true } });
    record('3a crash leaves ledger running with a checkpoint, a held lock and partial progress', exit.signal === 'SIGKILL' && afterCrash?.status === 'running' && Boolean(afterCrash.checkpoint) && Boolean(lock) && doneBeforeResume === BATCH * CRASH_AFTER_BATCHES, { signal: exit.signal, ledger: afterCrash && { status: afterCrash.status, batches: afterCrash.batches, modified: afterCrash.modified, checkpoint: afterCrash.checkpoint }, lockHeld: Boolean(lock), backfilledBeforeResume: doneBeforeResume });
    let refused = false;
    try { await runner(db, { batchSize: BATCH }).run(byId(TARGET_MIGRATION), 'apply'); } catch (error) { refused = error instanceof MigrationLockError; }
    record('3b a second runner is refused while the crashed run holds the lock', refused);
    const waitMs = Math.max(0, (lock!.expiresAt as Date).getTime() - Date.now()) + 500;
    await sleep(waitMs);
    const resumed = await runner(db, { batchSize: BATCH }).run(byId(TARGET_MIGRATION), 'apply');
    const backfilled = await db.collection('properties').find({ purposeSubcategoryIds: { $exists: true } }, { projection: { purposeSubcategoryId: 1, purposeSubcategoryIds: 1 } }).toArray();
    const exact = backfilled.length === LEGACY_COUNT && backfilled.every((doc) => Array.isArray(doc.purposeSubcategoryIds) && doc.purposeSubcategoryIds.length === 1 && String(doc.purposeSubcategoryIds[0]) === String(doc.purposeSubcategoryId));
    const finalLedger = await new MongoMigrationStore(db).get(TARGET_MIGRATION);
    record('3c after lease expiry the run resumes from its checkpoint; every row backfilled exactly once', resumed.status === 'complete' && resumed.resumedFromCheckpoint === afterCrash?.checkpoint && exact && finalLedger?.status === 'complete', { resumedFromCheckpoint: resumed.resumedFromCheckpoint, modifiedThisRun: resumed.modified, totalBackfilled: backfilled.length, attempts: finalLedger?.attempts });

    // 4. failing validation, then retry
    const listing = byId('023-property-type-listing-indexes');
    let failedRun = false;
    let brokenValidate = true;
    const flaky: MigrationDefinition = { ...listing, async validate(context) { return brokenValidate ? { valid: false, errors: [{ code: 'REHEARSAL_FORCED_FAILURE', message: 'forced' }] } : listing.validate(context); } };
    try { await runner(db).run(flaky, 'apply'); } catch { failedRun = true; }
    const failedLedger = await new MongoMigrationStore(db).get(listing.id);
    const lockAfterFailure = await db.collection('migration_locks').findOne({ _id: 'global' as never });
    brokenValidate = false;
    const retry = await runner(db).run(flaky, 'apply');
    const retryLedger = await new MongoMigrationStore(db).get(listing.id);
    record('4 a failing validation marks the ledger failed and releases the lock; the retry completes', failedRun && failedLedger?.status === 'failed' && lockAfterFailure === null && retry.status === 'complete' && retryLedger?.attempts === 2, { failedStatus: failedLedger?.status, lockReleased: lockAfterFailure === null, retryStatus: retry.status, attempts: retryLedger?.attempts });

    // 5. idempotent re-run
    const again: string[] = [];
    for (const id of order.slice(0, order.indexOf('023-property-type-listing-indexes') + 1)) again.push((await runner(db).run(byId(id), 'apply')).status);
    record('5 re-running completed migrations is a pure no-op', again.every((status) => status === 'skipped-complete'), { statuses: [...new Set(again)] });

    // 6. the rest, in registry order; manual-only excluded
    const rest = order.slice(order.indexOf('023-property-type-listing-indexes') + 1);
    const applied: string[] = [];
    for (const id of rest) { const report = await runner(db).run(byId(id), 'apply'); if (report.status === 'complete') applied.push(id); }
    const manualLedger = await db.collection('migration_ledger').find({ migrationId: { $in: CORE_MIGRATIONS.filter((migration) => migration.manualOnly).map((migration) => migration.id) } }).toArray();
    record('6 remaining migrations apply in order; manual-only migrations are untouched', applied.length === rest.length && manualLedger.length === 0, { applied: applied.length, manualOnlyInLedger: manualLedger.length });

    // 7. manual migrations, documented order (024 before 035: 024 validates the old replacement indexes)
    const manual = ['024-retire-property-purpose-listing-index', '035-phase13-retire-superseded-listing-indexes'];
    const manualStatuses: string[] = [];
    for (const id of manual) manualStatuses.push((await runner(db).run(byId(id), 'apply')).status);
    const indexNames = (await db.collection('properties').indexes()).map((index) => index.name);
    record('7 manual migrations 024 then 035 apply on request and leave only the sortable listing indexes', manualStatuses.every((status) => status === 'complete') && indexNames.filter((name) => String(name).startsWith('property_public_listing_')).every((name) => String(name).endsWith('_v2')), { manualStatuses, listingIndexes: indexNames.filter((name) => String(name).startsWith('property_public_listing_')) });

    // 8. catalog completion + manifest + integrity
    const post = npx(['src/seeds/baseline-catalog.seed.ts', '--post-legacy'], bootstrapEnv);
    const manifest = npx(['src/scripts/release-manifest.ts', 'apply', '--dry-run'], bootstrapEnv);
    const applyRun = npx(['src/scripts/release-manifest.ts', 'apply'], bootstrapEnv);
    const verify = npx(['src/scripts/release-manifest.ts', 'verify'], bootstrapEnv);
    await db.collection('properties').deleteMany({ title: /^Legacy / });
    const integrity = await runIntegrityChecks(db);
    record('8 manifest dry-run/apply/verify succeed on the migrated database', post.code === 0 && manifest.code === 0 && applyRun.code === 0 && verify.code === 0, { dryRunExit: manifest.code, applyExit: applyRun.code, verifyExit: verify.code });
    record('8b integrity after the rehearsal has no errors', integrity.ok, { errors: integrity.errorCount, warnings: integrity.warningCount, findings: integrity.findings.map((finding) => finding.code) });

    const out = flag('out');
    const report = { generatedAt: new Date().toISOString(), database, ok: steps.every((step) => step.ok), steps };
    if (out) await writeFile(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, passed: steps.filter((step) => step.ok).length, total: steps.length }));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[REDACTED_URI]') : 'rehearsal failed');
  process.exitCode = 1;
});
