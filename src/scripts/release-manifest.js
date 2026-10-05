'use strict';
require('dotenv/config');
const { createContext } = require('../config/database');
/**
 * Release baseline manifest CLI.
 *   export  --out=FILE [--release-id=ID]      read-only: write a manifest from the target database
 *   verify  [--manifest=FILE] [--strict]      read-only: compare the target database with the manifest
 *   apply   [--manifest=FILE] [--dry-run] [--allow-publish=code,code]
 *                                             publish missing forms (and, only when named, new versions)
 * Every command runs the environment guard first; `apply` in staging/production
 * additionally needs MANIFEST_APPLY_CONFIRM=APPLY_MANIFEST and a marked database.
 * `apply` requires an existing SUPER_ADMIN (its id is stamped on the audit rows).
 */

const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { MongoClient } = require('mongodb');
const { guardAction } = require('../config/deployment-environment');
const {
  AdminPropertyFormDefinitionsService,
} = require('../services/admin-property-form-definitions.service');
const { applyManifest } = require('../release/baseline-apply');
const {
  buildManifest,
  manifestIntegrityProblems,
  verifyAgainstManifest,
} = require('../release/baseline-manifest');
const DEFAULT_MANIFEST = join(__dirname, '../release/baseline-manifest.v1.json');
const flag = (name) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const redact = (message) => message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[REDACTED_URI]');
async function loadManifest() {
  const manifest = JSON.parse(await readFile(flag('manifest') ?? DEFAULT_MANIFEST, 'utf8'));
  const problems = manifestIntegrityProblems(manifest);
  if (problems.length) throw new Error(`Manifest is not self-consistent: ${problems.join('; ')}`);
  return manifest;
}
async function withClient(action, run) {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const db = client.db();
    await guardAction(action, process.env, db);
    return await run(db);
  } finally {
    await client.close();
  }
}
async function main() {
  const command = process.argv[2];
  if (command === 'export') {
    const out = flag('out');
    if (!out) throw new Error('export needs --out=FILE');
    const manifest = await withClient('manifest:verify', (db) =>
      buildManifest(db, flag('release-id') ?? 'dynamic-property-system-v1'),
    );
    await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    console.log(
      JSON.stringify({
        status: 'exported',
        out,
        manifestHash: manifest.manifestHash,
        forms: manifest.forms.length,
      }),
    );
  } else if (command === 'verify') {
    const manifest = await loadManifest();
    const report = await withClient('manifest:verify', (db) => verifyAgainstManifest(db, manifest));
    const ok =
      report.ok &&
      (!process.argv.includes('--strict') ||
        (report.counts.drift === 0 && report.counts.extra === 0));
    console.log(
      JSON.stringify(
        {
          ok,
          manifestHash: report.manifestHash,
          counts: report.counts,
          problems: report.items.filter((item) => item.verdict !== 'match'),
        },
        null,
        2,
      ),
    );
    if (!ok) process.exitCode = 1;
  } else if (command === 'apply') {
    const manifest = await loadManifest();
    const dryRun = process.argv.includes('--dry-run');
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    const uri = process.env.MONGO_URI;
    const app = await createContext({ initialize: false });
    try {
      const db = app.connection.db;
      await guardAction(dryRun ? 'manifest:verify' : 'manifest:apply', process.env, db);
      const admin = await db
        .collection('users')
        .findOne({ systemRole: 'SUPER_ADMIN' }, { projection: { _id: 1 } });
      if (!dryRun && !admin?._id)
        throw new Error('A SUPER_ADMIN account must exist before applying a manifest');
      const result = await applyManifest(
        db,
        app.services.AdminPropertyFormDefinitionsService,
        manifest,
        {
          dryRun,
          allowPublish: (flag('allow-publish') ?? '').split(',').filter(Boolean),
          actorUserId: String(admin?._id ?? ''),
        },
      );
      console.log(
        JSON.stringify(
          {
            ok: result.ok,
            dryRun: result.dryRun,
            blockers: result.blockers,
            plan: result.plan.filter((item) => item.action !== 'unchanged'),
            published: result.published,
            counts: result.report.counts,
          },
          null,
          2,
        ),
      );
      if (!result.ok) process.exitCode = 1;
    } finally {
      await app.close();
    }
  } else {
    throw new Error('Usage: release-manifest <export|verify|apply> [options]');
  }
}
if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? redact(error.message) : 'release-manifest failed');
    process.exitCode = 1;
  });
}

Object.assign(exports, { DEFAULT_MANIFEST });
