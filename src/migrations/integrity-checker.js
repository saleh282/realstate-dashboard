'use strict';

const { SystemRole } = require('../domain/auth/roles.enum');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
} = require('../domain/users/identity.types');
const SAMPLE_LIMIT = 25;
async function duplicateFinding(collection, field, code) {
  const rows = await collection
    .aggregate([
      { $match: { [field]: { $type: 'string', $ne: '' } } },
      { $group: { _id: { $toLower: `$${field}` }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: SAMPLE_LIMIT },
    ])
    .toArray();
  if (!rows.length) return null;
  return {
    code,
    severity: 'error',
    count: rows.length,
    sampleIds: rows.flatMap((row) => row.ids.slice(0, 2).map(String)).slice(0, SAMPLE_LIMIT),
    message: `Duplicate normalized ${field} values exist`,
  };
}
async function danglingFinding(db, collectionName, field, code) {
  const rows = await db
    .collection(collectionName)
    .aggregate([
      { $match: { [field]: { $exists: true, $ne: null } } },
      {
        $lookup: { from: 'users', localField: field, foreignField: '_id', as: '_integrityTarget' },
      },
      { $match: { '_integrityTarget.0': { $exists: false } } },
      {
        $facet: {
          count: [{ $count: 'value' }],
          samples: [{ $limit: SAMPLE_LIMIT }, { $project: { _id: 1 } }],
        },
      },
    ])
    .toArray();
  const count = Number(rows[0]?.count?.[0]?.value ?? 0);
  if (!count) return null;
  return {
    code,
    severity: 'error',
    count,
    sampleIds: rows[0].samples.map((row) => String(row._id)),
    message: `${collectionName}.${field} contains dangling user references`,
  };
}
async function invalidEnumFinding(collection, field, allowed, code) {
  const filter = { [field]: { $nin: [...allowed] } };
  const count = await collection.countDocuments(filter);
  if (!count) return null;
  const samples = await collection
    .find(filter, { projection: { _id: 1 } })
    .limit(SAMPLE_LIMIT)
    .toArray();
  return {
    code,
    severity: 'error',
    count,
    sampleIds: samples.map((row) => String(row._id)),
    message: `${field} is missing or outside the frozen V1 enum`,
  };
}
async function runIntegrityChecks(db, now = new Date()) {
  const users = db.collection('users');
  const candidates = await Promise.all([
    duplicateFinding(users, 'email', 'DUPLICATE_USER_EMAIL'),
    duplicateFinding(users, 'phone', 'DUPLICATE_USER_PHONE'),
    danglingFinding(db, 'refresh_tokens', 'userId', 'DANGLING_REFRESH_TOKEN_USER'),
    danglingFinding(db, 'audit_logs', 'actorUserId', 'DANGLING_AUDIT_ACTOR'),
    danglingFinding(db, 'audit_logs', 'targetUserId', 'DANGLING_AUDIT_TARGET'),
    invalidEnumFinding(users, 'systemRole', Object.values(SystemRole), 'INVALID_SYSTEM_ROLE'),
    invalidEnumFinding(users, 'accountType', Object.values(AccountType), 'INVALID_ACCOUNT_TYPE'),
    invalidEnumFinding(
      users,
      'accountStatus',
      Object.values(AccountStatus),
      'INVALID_ACCOUNT_STATUS',
    ),
    invalidEnumFinding(users, 'brokerStatus', Object.values(BrokerStatus), 'INVALID_BROKER_STATUS'),
    invalidEnumFinding(
      users,
      'verificationTrustState',
      Object.values(VerificationTrustState),
      'INVALID_TRUST_STATE',
    ),
    invalidEnumFinding(
      users,
      'primaryIdentifierType',
      Object.values(PrimaryIdentifierType),
      'INVALID_PRIMARY_IDENTIFIER_TYPE',
    ),
  ]);
  const findings = candidates.filter((finding) => finding !== null);
  const errorCount = findings
    .filter((finding) => finding.severity === 'error')
    .reduce((sum, finding) => sum + finding.count, 0);
  const warningCount = findings
    .filter((finding) => finding.severity === 'warning')
    .reduce((sum, finding) => sum + finding.count, 0);
  return {
    generatedAt: now.toISOString(),
    ok: errorCount === 0,
    errorCount,
    warningCount,
    findings,
  };
}

Object.assign(exports, { runIntegrityChecks });
