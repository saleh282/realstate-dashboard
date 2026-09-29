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
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { MongoClient } from 'mongodb';
import type { Connection } from 'mongoose';
import { guardAction } from '../config/deployment-environment';
import { AdminPropertyFormDefinitionsService } from '../property-form-definitions/admin-property-form-definitions.service';
import { PropertyFormDefinitionsModule } from '../property-form-definitions/property-form-definitions.module';
import { applyManifest } from '../release/baseline-apply';
import { BaselineManifest, buildManifest, manifestIntegrityProblems, verifyAgainstManifest } from '../release/baseline-manifest';

export const DEFAULT_MANIFEST = join(__dirname, '../release/baseline-manifest.v1.json');
const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const redact = (message: string) => message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[REDACTED_URI]');

async function loadManifest(): Promise<BaselineManifest> {
  const manifest = JSON.parse(await readFile(flag('manifest') ?? DEFAULT_MANIFEST, 'utf8')) as BaselineManifest;
  const problems = manifestIntegrityProblems(manifest);
  if (problems.length) throw new Error(`Manifest is not self-consistent: ${problems.join('; ')}`);
  return manifest;
}

async function withClient<T>(action: 'manifest:verify', run: (db: ReturnType<MongoClient['db']>) => Promise<T>): Promise<T> {
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
    const manifest = await withClient('manifest:verify', (db) => buildManifest(db, flag('release-id') ?? 'dynamic-property-system-v1'));
    await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ status: 'exported', out, manifestHash: manifest.manifestHash, forms: manifest.forms.length }));
  } else if (command === 'verify') {
    const manifest = await loadManifest();
    const report = await withClient('manifest:verify', (db) => verifyAgainstManifest(db, manifest));
    const ok = report.ok && (!process.argv.includes('--strict') || (report.counts.drift === 0 && report.counts.extra === 0));
    console.log(JSON.stringify({ ok, manifestHash: report.manifestHash, counts: report.counts, problems: report.items.filter((item) => item.verdict !== 'match') }, null, 2));
    if (!ok) process.exitCode = 1;
  } else if (command === 'apply') {
    const manifest = await loadManifest();
    const dryRun = process.argv.includes('--dry-run');
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
    const uri = process.env.MONGO_URI;
    @Module({ imports: [MongooseModule.forRoot(uri), PropertyFormDefinitionsModule] })
    class ManifestModule {}
    const app = await NestFactory.createApplicationContext(ManifestModule, { logger: ['error'] });
    try {
      const db = app.get<Connection>(getConnectionToken()).db as never as Parameters<typeof guardAction>[2];
      await guardAction(dryRun ? 'manifest:verify' : 'manifest:apply', process.env, db);
      const admin = await (db as NonNullable<typeof db>).collection('users').findOne({ systemRole: 'SUPER_ADMIN' }, { projection: { _id: 1 } });
      if (!dryRun && !admin?._id) throw new Error('A SUPER_ADMIN account must exist before applying a manifest');
      const result = await applyManifest(db as never, app.get(AdminPropertyFormDefinitionsService), manifest, {
        dryRun, allowPublish: (flag('allow-publish') ?? '').split(',').filter(Boolean), actorUserId: String(admin?._id ?? ''),
      });
      console.log(JSON.stringify({ ok: result.ok, dryRun: result.dryRun, blockers: result.blockers, plan: result.plan.filter((item) => item.action !== 'unchanged'), published: result.published, counts: result.report.counts }, null, 2));
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
