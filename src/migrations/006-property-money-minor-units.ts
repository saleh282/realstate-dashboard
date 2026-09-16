import mongoose from 'mongoose';
import type { Collection } from 'mongodb';
import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { EGP_CURRENCY, propertyMoneyFromStoredRecord } from '../common/money/money';

export const PROPERTY_MONEY_MIGRATION_VERSION = 1;

type StoredProperty = {
  _id: unknown;
  totalPrice?: unknown;
  downPayment?: unknown;
  totalPriceMinor?: unknown;
  downPaymentMinor?: unknown;
  currency?: unknown;
};

export type PropertyMoneyMigrationPlan = {
  totalPriceMinor: number;
  downPaymentMinor: number;
  currency: typeof EGP_CURRENCY;
};

export function planPropertyMoneyMigration(document: StoredProperty): PropertyMoneyMigrationPlan {
  if (
    document.totalPriceMinor !== undefined ||
    document.downPaymentMinor !== undefined ||
    document.currency !== undefined
  ) {
    throw new RangeError('Target money fields already exist; automatic overwrite is forbidden');
  }
  return propertyMoneyFromStoredRecord(document);
}

async function scan(collection: Collection): Promise<{
  eligible: number;
  alreadyMigrated: number;
  invalidCount: number;
  invalid: Array<{ id: string; reason: string }>;
  totalPriceMinor: bigint;
  downPaymentMinor: bigint;
}> {
  const result = { eligible: 0, alreadyMigrated: 0, invalidCount: 0, invalid: [] as Array<{ id: string; reason: string }>, totalPriceMinor: 0n, downPaymentMinor: 0n };
  const cursor = collection.find({}, { projection: { totalPrice: 1, downPayment: 1, totalPriceMinor: 1, downPaymentMinor: 1, currency: 1 } });
  for await (const document of cursor) {
    try {
      if (document.totalPriceMinor !== undefined && document.downPaymentMinor !== undefined && document.currency === EGP_CURRENCY) {
        const plan = propertyMoneyFromStoredRecord(document as StoredProperty);
        result.totalPriceMinor += BigInt(plan.totalPriceMinor);
        result.downPaymentMinor += BigInt(plan.downPaymentMinor);
        result.alreadyMigrated++;
        continue;
      }
      const plan = planPropertyMoneyMigration(document as StoredProperty);
      result.eligible++;
      result.totalPriceMinor += BigInt(plan.totalPriceMinor);
      result.downPaymentMinor += BigInt(plan.downPaymentMinor);
    } catch (error) {
      result.invalidCount++;
      if (result.invalid.length < 100) {
        result.invalid.push({ id: String(document._id), reason: error instanceof Error ? error.message : 'Unknown conversion error' });
      }
    }
  }
  return result;
}

async function apply(collection: Collection, runId: string): Promise<number> {
  let migrated = 0;
  const cursor = collection.find({ totalPriceMinor: { $exists: false }, downPaymentMinor: { $exists: false }, currency: { $exists: false } });
  for await (const document of cursor) {
    const plan = planPropertyMoneyMigration(document as StoredProperty);
    const update = await collection.updateOne(
      { _id: document._id, totalPriceMinor: { $exists: false }, downPaymentMinor: { $exists: false }, currency: { $exists: false } },
      { $set: { ...plan, moneyMigrationVersion: PROPERTY_MONEY_MIGRATION_VERSION, moneyMigrationRunId: runId, moneyMigratedAt: new Date() } },
    );
    migrated += update.modifiedCount;
  }
  return migrated;
}

async function main() {
  ConfigModule.forRoot();
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  const shouldApply = process.argv.includes('--apply');
  const runId = randomUUID();
  await mongoose.connect(uri);
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB connection has no database');
  const properties = database.collection('properties');
  const runs = database.collection('migration_runs');
  const preflight = await scan(properties);
  const report = {
    migration: 'MAZAD-006-property-money-minor-units',
    version: PROPERTY_MONEY_MIGRATION_VERSION,
    runId,
    mode: shouldApply ? 'apply' : 'dry-run',
    ...preflight,
    totalPriceMinor: preflight.totalPriceMinor.toString(),
    downPaymentMinor: preflight.downPaymentMinor.toString(),
  };

  if (preflight.invalidCount) {
    console.error(JSON.stringify({ ...report, status: 'blocked-invalid-data' }, null, 2));
    throw new Error(`Preflight found ${preflight.invalidCount} invalid or partially migrated properties`);
  }
  if (!shouldApply) {
    console.log(JSON.stringify({ ...report, status: 'dry-run-complete' }, null, 2));
    return;
  }

  await runs.insertOne({ ...report, status: 'running', startedAt: new Date() });
  try {
    const migrated = await apply(properties, runId);
    const postflight = await scan(properties);
    if (postflight.invalidCount || postflight.eligible !== 0) throw new Error('Postflight reconciliation failed');
    if (postflight.totalPriceMinor !== preflight.totalPriceMinor || postflight.downPaymentMinor !== preflight.downPaymentMinor) {
      throw new Error('Postflight monetary totals do not match preflight totals');
    }
    await runs.updateOne({ runId }, { $set: { status: 'complete', migrated, completedAt: new Date(), postflight: { alreadyMigrated: postflight.alreadyMigrated } } });
    console.log(JSON.stringify({ ...report, status: 'complete', migrated, reconciled: postflight.alreadyMigrated }, null, 2));
  } catch (error) {
    await runs.updateOne({ runId }, { $set: { status: 'failed', failedAt: new Date(), error: error instanceof Error ? error.message : 'Unknown error' } });
    throw error;
  }
}

if (require.main === module) {
  void main().catch(async error => {
    console.error(error);
    await mongoose.disconnect().catch(() => undefined);
    process.exitCode = 1;
  }).finally(async () => mongoose.disconnect().catch(() => undefined));
}
