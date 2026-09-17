import { ObjectId, type Collection, type Document } from 'mongodb';
import { EGP_CURRENCY, propertyMoneyFromStoredRecord } from '../../common/money/money';
import { planUserIdentityMigration, scanUserIdentityMigration } from '../007-user-identity-contract';
import {
  planPropertyMoneyMigration,
  scanPropertyMoneyMigration,
} from '../006-property-money-minor-units';
import type { MigrationDefinition, MigrationContext } from './migration.types';

function afterCheckpoint(checkpoint?: string): Record<string, unknown> {
  if (!checkpoint) return {};
  if (!ObjectId.isValid(checkpoint)) throw new RangeError('Stored migration checkpoint is invalid');
  return { _id: { $gt: new ObjectId(checkpoint) } };
}

async function nextBatch(collection: Collection, context: MigrationContext): Promise<Document[]> {
  return collection.find(afterCheckpoint(context.checkpoint)).sort({ _id: 1 }).limit(context.batchSize).toArray();
}

export const propertyMoneyMigration: MigrationDefinition = {
  id: '006-property-money-minor-units',
  version: 1,
  description: 'Backfill authoritative EGP integer minor-unit fields on properties',
  rollback: {
    kind: 'none',
    remediation: 'Stop new writes, inspect migration_ledger and moneyMigrationRunId, then repair only records identified by the reconciliation report.',
    restoreProcedure: 'Restore the pre-migration database snapshot to a separate database and compare before any reviewed production remediation.',
  },
  async preflight({ db }) {
    const result = await scanPropertyMoneyMigration(db.collection('properties'));
    return {
      eligible: result.eligible,
      alreadyApplied: result.alreadyMigrated,
      blockers: result.invalidCount ? [{ code: 'PROPERTY_MONEY_INVALID_OR_PARTIAL', message: `${result.invalidCount} properties cannot be migrated automatically`, sampleIds: result.invalid.map((item) => item.id) }] : [],
      summary: { totalPriceMinor: result.totalPriceMinor.toString(), downPaymentMinor: result.downPaymentMinor.toString(), invalidCount: result.invalidCount },
    };
  },
  async migrateBatch(context) {
    const collection = context.db.collection('properties');
    const documents = await nextBatch(collection, context);
    let modified = 0;
    for (const document of documents) {
      if (document.totalPriceMinor !== undefined && document.downPaymentMinor !== undefined && document.currency === EGP_CURRENCY) {
        propertyMoneyFromStoredRecord(document);
        continue;
      }
      const plan = planPropertyMoneyMigration(document as any);
      const update = await collection.updateOne(
        { _id: document._id, totalPriceMinor: { $exists: false }, downPaymentMinor: { $exists: false }, currency: { $exists: false } },
        { $set: { ...plan, moneyMigrationVersion: 1, moneyMigrationRunId: context.runId, moneyMigratedAt: new Date() } },
      );
      modified += update.modifiedCount;
    }
    return { scanned: documents.length, modified, checkpoint: documents.at(-1)?._id.toString(), done: documents.length < context.batchSize };
  },
  async validate({ db }) {
    const result = await scanPropertyMoneyMigration(db.collection('properties'));
    const valid = result.invalidCount === 0 && result.eligible === 0;
    return { valid, errors: valid ? [] : [{ code: 'PROPERTY_MONEY_RECONCILIATION_FAILED', message: `${result.invalidCount} invalid and ${result.eligible} unmigrated properties remain` }], summary: { migrated: result.alreadyMigrated } };
  },
};

export const userIdentityMigration: MigrationDefinition = {
  id: '007-user-identity-contract',
  version: 1,
  description: 'Backfill system role, account type/status, broker status, trust state, and primary identifier',
  rollback: {
    kind: 'none',
    remediation: 'Use identityMigrationRunId and the integrity report to review and repair only affected accounts; never infer privileged roles.',
    restoreProcedure: 'Restore the pre-migration snapshot to a separate database and compare before reviewed remediation.',
  },
  async preflight({ db }) {
    const result = await scanUserIdentityMigration(db.collection('users'));
    return { eligible: result.eligible, alreadyApplied: result.alreadyMigrated, blockers: result.invalidCount ? [{ code: 'USER_IDENTITY_INVALID_AMBIGUOUS_OR_PARTIAL', message: `${result.invalidCount} users cannot be migrated automatically`, sampleIds: result.invalid.map((item) => item.id) }] : [], summary: { invalidCount: result.invalidCount } };
  },
  async migrateBatch(context) {
    const collection = context.db.collection('users');
    const documents = await nextBatch(collection, context);
    let modified = 0;
    for (const document of documents) {
      const targetFields = ['systemRole', 'accountType', 'accountStatus', 'brokerStatus', 'verificationTrustState', 'primaryIdentifierType'];
      if (targetFields.every((field) => document[field] !== undefined)) continue;
      const plan = planUserIdentityMigration(document as any);
      const update = await collection.updateOne(
        { _id: document._id, ...Object.fromEntries(targetFields.map((field) => [field, { $exists: false }])) },
        { $set: { ...plan, identityMigrationVersion: 1, identityMigrationRunId: context.runId, identityMigratedAt: new Date() } },
      );
      modified += update.modifiedCount;
    }
    return { scanned: documents.length, modified, checkpoint: documents.at(-1)?._id.toString(), done: documents.length < context.batchSize };
  },
  async validate({ db }) {
    const result = await scanUserIdentityMigration(db.collection('users'));
    const valid = result.invalidCount === 0 && result.eligible === 0;
    return { valid, errors: valid ? [] : [{ code: 'USER_IDENTITY_RECONCILIATION_FAILED', message: `${result.invalidCount} invalid and ${result.eligible} unmigrated users remain` }], summary: { migrated: result.alreadyMigrated } };
  },
};

export const CORE_MIGRATIONS: MigrationDefinition[] = [propertyMoneyMigration, userIdentityMigration];

export function validateMigrationRegistry(migrations: MigrationDefinition[] = CORE_MIGRATIONS): void {
  const ids = new Set<string>();
  for (const migration of migrations) {
    if (!/^\d{3}-[a-z0-9-]+$/.test(migration.id)) throw new Error(`Invalid versioned migration id: ${migration.id}`);
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) throw new Error(`Invalid migration version for ${migration.id}`);
    if (ids.has(migration.id)) throw new Error(`Duplicate migration id: ${migration.id}`);
    ids.add(migration.id);
    for (const dependency of migration.dependencies ?? []) {
      if (dependency === migration.id) throw new Error(`Migration ${migration.id} cannot depend on itself`);
    }
  }
}
