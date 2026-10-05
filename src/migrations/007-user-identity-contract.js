'use strict';

const mongoose = require('mongoose');

const { randomUUID } = require('crypto');
const dotenv = require('dotenv');
const { SystemRole } = require('../domain/auth/roles.enum');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
} = require('../domain/users/identity.types');
const USER_IDENTITY_MIGRATION_VERSION = 1;
const targetFields = [
  'systemRole',
  'accountType',
  'accountStatus',
  'brokerStatus',
  'verificationTrustState',
  'primaryIdentifierType',
];
function isFullyMigrated(document) {
  return targetFields.every((field) => document[field] !== undefined);
}
function isPartiallyMigrated(document) {
  const count = targetFields.filter((field) => document[field] !== undefined).length;
  return count > 0 && count < targetFields.length;
}
function planUserIdentityMigration(document) {
  if (isFullyMigrated(document) || isPartiallyMigrated(document)) {
    throw new RangeError('Target identity fields already exist; automatic overwrite is forbidden');
  }
  if (document.role !== undefined && !['user', 'admin'].includes(String(document.role))) {
    throw new RangeError('Unsupported legacy role');
  }
  if (document.isActive !== undefined && typeof document.isActive !== 'boolean') {
    throw new RangeError('Legacy isActive must be boolean');
  }
  const hasEmail = typeof document.email === 'string' && document.email.length > 0;
  const hasPhone = typeof document.phone === 'string' && document.phone.length > 0;
  if (hasEmail === hasPhone) {
    throw new RangeError('Exactly one primary legacy identifier is required for safe migration');
  }
  if (document.emailVerified !== undefined && typeof document.emailVerified !== 'boolean') {
    throw new RangeError('Legacy emailVerified must be boolean');
  }
  const primaryIdentifierType = hasEmail
    ? PrimaryIdentifierType.EMAIL
    : PrimaryIdentifierType.PHONE;
  return {
    systemRole: document.role === 'admin' ? SystemRole.ADMIN : SystemRole.USER,
    accountType: AccountType.USER,
    accountStatus: document.isActive === false ? AccountStatus.SUSPENDED : AccountStatus.ACTIVE,
    brokerStatus: BrokerStatus.NOT_APPLIED,
    verificationTrustState:
      document.kycStatus === 'verified'
        ? VerificationTrustState.VERIFIED
        : VerificationTrustState.UNVERIFIED,
    primaryIdentifierType,
    ...(document.emailVerified === true
      ? { legacyVerifiedIdentifierType: primaryIdentifierType }
      : {}),
  };
}
function validateMigrated(document) {
  if (!Object.values(SystemRole).includes(document.systemRole)) {
    throw new RangeError('Invalid systemRole');
  }
  if (!Object.values(AccountType).includes(document.accountType)) {
    throw new RangeError('Invalid accountType');
  }
  if (!Object.values(AccountStatus).includes(document.accountStatus)) {
    throw new RangeError('Invalid accountStatus');
  }
  if (!Object.values(BrokerStatus).includes(document.brokerStatus)) {
    throw new RangeError('Invalid brokerStatus');
  }
  if (!Object.values(VerificationTrustState).includes(document.verificationTrustState)) {
    throw new RangeError('Invalid verificationTrustState');
  }
  if (!Object.values(PrimaryIdentifierType).includes(document.primaryIdentifierType)) {
    throw new RangeError('Invalid primaryIdentifierType');
  }
}
async function scanUserIdentityMigration(collection) {
  const result = {
    eligible: 0,
    alreadyMigrated: 0,
    invalidCount: 0,
    invalid: [],
  };
  const cursor = collection.find({});
  for await (const document of cursor) {
    try {
      if (isFullyMigrated(document)) {
        validateMigrated(document);
        result.alreadyMigrated++;
      } else {
        planUserIdentityMigration(document);
        result.eligible++;
      }
    } catch (error) {
      result.invalidCount++;
      if (result.invalid.length < 100) {
        result.invalid.push({
          id: String(document._id),
          reason: error instanceof Error ? error.message : 'Unknown migration error',
        });
      }
    }
  }
  return result;
}
async function applyUserIdentityMigration(collection, runId) {
  let migrated = 0;
  const cursor = collection.find({
    systemRole: { $exists: false },
    accountType: { $exists: false },
    accountStatus: { $exists: false },
    brokerStatus: { $exists: false },
    verificationTrustState: { $exists: false },
    primaryIdentifierType: { $exists: false },
  });
  for await (const document of cursor) {
    const plan = planUserIdentityMigration(document);
    const update = await collection.updateOne(
      {
        _id: document._id,
        systemRole: { $exists: false },
        accountType: { $exists: false },
        accountStatus: { $exists: false },
        brokerStatus: { $exists: false },
        verificationTrustState: { $exists: false },
        primaryIdentifierType: { $exists: false },
      },
      {
        $set: {
          ...plan,
          identityMigrationVersion: USER_IDENTITY_MIGRATION_VERSION,
          identityMigrationRunId: runId,
          identityMigratedAt: new Date(),
        },
      },
    );
    migrated += update.modifiedCount;
  }
  return migrated;
}
async function main() {
  dotenv.config();
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  const shouldApply = isIdentityMigrationApplyMode(process.argv);
  const runId = randomUUID();
  await mongoose.connect(uri);
  const database = mongoose.connection.db;
  if (!database) throw new Error('MongoDB connection has no database');
  const users = database.collection('users');
  const runs = database.collection('migration_runs');
  const preflight = await scanUserIdentityMigration(users);
  const report = {
    migration: 'MAZAD-007-user-identity-contract',
    version: USER_IDENTITY_MIGRATION_VERSION,
    runId,
    mode: shouldApply ? 'apply' : 'dry-run',
    ...preflight,
  };
  if (preflight.invalidCount) {
    console.error(JSON.stringify({ ...report, status: 'blocked-invalid-data' }, null, 2));
    throw new Error(
      `Preflight found ${preflight.invalidCount} invalid, ambiguous, or partially migrated users`,
    );
  }
  if (!shouldApply) {
    console.log(JSON.stringify({ ...report, status: 'dry-run-complete' }, null, 2));
    return;
  }
  await runs.insertOne({ ...report, status: 'running', startedAt: new Date() });
  try {
    const migrated = await applyUserIdentityMigration(users, runId);
    const postflight = await scanUserIdentityMigration(users);
    if (postflight.invalidCount || postflight.eligible !== 0) {
      throw new Error('Postflight identity reconciliation failed');
    }
    await runs.updateOne(
      { runId },
      {
        $set: {
          status: 'complete',
          migrated,
          completedAt: new Date(),
          postflight: { alreadyMigrated: postflight.alreadyMigrated },
        },
      },
    );
    console.log(
      JSON.stringify(
        { ...report, status: 'complete', migrated, reconciled: postflight.alreadyMigrated },
        null,
        2,
      ),
    );
  } catch (error) {
    await runs.updateOne(
      { runId },
      {
        $set: {
          status: 'failed',
          failedAt: new Date(),
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      },
    );
    throw error;
  }
}
function isIdentityMigrationApplyMode(args) {
  return args.includes('--apply');
}
if (require.main === module) {
  void main()
    .catch(async (error) => {
      console.error(error);
      await mongoose.disconnect().catch(() => undefined);
      process.exitCode = 1;
    })
    .finally(async () => mongoose.disconnect().catch(() => undefined));
}

Object.assign(exports, {
  USER_IDENTITY_MIGRATION_VERSION,
  planUserIdentityMigration,
  scanUserIdentityMigration,
  applyUserIdentityMigration,
  isIdentityMigrationApplyMode,
});
