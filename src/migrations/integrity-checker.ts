import type { Collection, Db, Document } from 'mongodb';
import { SystemRole } from '../auth/roles.enum';
import { AccountStatus, AccountType, BrokerStatus, PrimaryIdentifierType, VerificationTrustState } from '../users/identity.types';

export type IntegrityFinding = {
  code: string;
  severity: 'error' | 'warning';
  count: number;
  sampleIds: string[];
  message: string;
};

export type IntegrityReport = {
  generatedAt: string;
  ok: boolean;
  errorCount: number;
  warningCount: number;
  findings: IntegrityFinding[];
};

const SAMPLE_LIMIT = 25;

async function duplicateFinding(collection: Collection, field: string, code: string): Promise<IntegrityFinding | null> {
  const rows = await collection.aggregate([
    { $match: { [field]: { $type: 'string', $ne: '' } } },
    { $group: { _id: { $toLower: `$${field}` }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: SAMPLE_LIMIT },
  ]).toArray();
  if (!rows.length) return null;
  return { code, severity: 'error', count: rows.length, sampleIds: rows.flatMap((row) => (row.ids as unknown[]).slice(0, 2).map(String)).slice(0, SAMPLE_LIMIT), message: `Duplicate normalized ${field} values exist` };
}

async function danglingFinding(db: Db, collectionName: string, field: string, code: string): Promise<IntegrityFinding | null> {
  const rows = await db.collection(collectionName).aggregate([
    { $match: { [field]: { $exists: true, $ne: null } } },
    { $lookup: { from: 'users', localField: field, foreignField: '_id', as: '_integrityTarget' } },
    { $match: { '_integrityTarget.0': { $exists: false } } },
    { $facet: { count: [{ $count: 'value' }], samples: [{ $limit: SAMPLE_LIMIT }, { $project: { _id: 1 } }] } },
  ]).toArray();
  const count = Number(rows[0]?.count?.[0]?.value ?? 0);
  if (!count) return null;
  return { code, severity: 'error', count, sampleIds: (rows[0].samples as Document[]).map((row) => String(row._id)), message: `${collectionName}.${field} contains dangling user references` };
}

async function invalidEnumFinding(collection: Collection, field: string, allowed: readonly string[], code: string): Promise<IntegrityFinding | null> {
  const filter = { [field]: { $nin: [...allowed] } };
  const count = await collection.countDocuments(filter);
  if (!count) return null;
  const samples = await collection.find(filter, { projection: { _id: 1 } }).limit(SAMPLE_LIMIT).toArray();
  return { code, severity: 'error', count, sampleIds: samples.map((row) => String(row._id)), message: `${field} is missing or outside the frozen V1 enum` };
}

async function danglingCatalogFinding(db: Db, field: string, from: string, code: string, array = false): Promise<IntegrityFinding | null> {
  const pipeline: Document[] = [];
  if (array) pipeline.push({ $unwind: `$${field}` });
  pipeline.push(
    { $match: { [field]: { $exists: true, $ne: null } } },
    { $lookup: { from, localField: field, foreignField: 'code', as: '_integrityCatalog' } },
    { $match: { '_integrityCatalog.0': { $exists: false } } },
    { $group: { _id: '$_id' } },
    { $facet: { count: [{ $count: 'value' }], samples: [{ $limit: SAMPLE_LIMIT }] } },
  );
  const rows = await db.collection('properties').aggregate(pipeline).toArray();
  const count = Number(rows[0]?.count?.[0]?.value ?? 0);
  if (!count) return null;
  return { code, severity: 'error', count, sampleIds: (rows[0].samples as Document[]).map((row) => String(row._id)), message: `Properties reference missing ${from} catalog entries` };
}

async function catalogDriftFinding(db: Db, collectionName: string, propertyField: string, code: string, array = false): Promise<IntegrityFinding | null> {
  const expression = array ? { $in: ['$$catalogCode', { $ifNull: [`$${propertyField}`, []] }] } : { $eq: [`$${propertyField}`, '$$catalogCode'] };
  const rows = await db.collection(collectionName).aggregate([
    { $lookup: { from: 'properties', let: { catalogCode: '$code' }, pipeline: [{ $match: { $expr: expression } }, { $count: 'value' }], as: '_actual' } },
    { $set: { _actualUsage: { $ifNull: [{ $arrayElemAt: ['$_actual.value', 0] }, 0] } } },
    { $match: { $expr: { $ne: [{ $ifNull: ['$usageCount', 0] }, '$_actualUsage'] } } },
    { $facet: { count: [{ $count: 'value' }], samples: [{ $limit: SAMPLE_LIMIT }, { $project: { _id: 1 } }] } },
  ]).toArray();
  const count = Number(rows[0]?.count?.[0]?.value ?? 0);
  if (!count) return null;
  return { code, severity: 'warning', count, sampleIds: (rows[0].samples as Document[]).map((row) => String(row._id)), message: `${collectionName}.usageCount differs from property references` };
}

async function danglingPropertyOptionFinding(db: Db, propertyField: string, group: string, code: string): Promise<IntegrityFinding | null> {
  const rows = await db.collection('properties').aggregate([
    { $match: { [propertyField]: { $exists: true, $ne: null } } },
    { $lookup: { from: 'property_options', let: { optionCode: `$${propertyField}` }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$code', '$$optionCode'] }, { $eq: ['$group', group] }] } } }], as: '_integrityOption' } },
    { $match: { '_integrityOption.0': { $exists: false } } },
    { $facet: { count: [{ $count: 'value' }], samples: [{ $limit: SAMPLE_LIMIT }, { $project: { _id: 1 } }] } },
  ]).toArray();
  const count = Number(rows[0]?.count?.[0]?.value ?? 0);
  if (!count) return null;
  return { code, severity: 'error', count, sampleIds: (rows[0].samples as Document[]).map((row) => String(row._id)), message: `Properties reference missing ${group} options` };
}

async function propertyOptionDriftFinding(db: Db): Promise<IntegrityFinding | null> {
  const rows = await db.collection('property_options').aggregate([
    { $lookup: { from: 'properties', let: { optionCode: '$code', optionGroup: '$group' }, pipeline: [{ $match: { $expr: { $or: [
      { $and: [{ $eq: ['$$optionGroup', 'finishing_status'] }, { $eq: ['$finishingStatusCode', '$$optionCode'] }] },
      { $and: [{ $eq: ['$$optionGroup', 'delivery_status'] }, { $eq: ['$deliveryStatusCode', '$$optionCode'] }] },
      { $and: [{ $eq: ['$$optionGroup', 'payment_method'] }, { $eq: ['$paymentMethodCode', '$$optionCode'] }] },
    ] } } }, { $count: 'value' }], as: '_actual' } },
    { $set: { _actualUsage: { $ifNull: [{ $arrayElemAt: ['$_actual.value', 0] }, 0] } } },
    { $match: { $expr: { $ne: [{ $ifNull: ['$usageCount', 0] }, '$_actualUsage'] } } },
    { $facet: { count: [{ $count: 'value' }], samples: [{ $limit: SAMPLE_LIMIT }, { $project: { _id: 1 } }] } },
  ]).toArray();
  const count = Number(rows[0]?.count?.[0]?.value ?? 0);
  if (!count) return null;
  return { code: 'PROPERTY_OPTION_USAGE_DRIFT', severity: 'warning', count, sampleIds: (rows[0].samples as Document[]).map((row) => String(row._id)), message: 'property_options.usageCount differs from property references' };
}

export async function runIntegrityChecks(db: Db, now: Date = new Date()): Promise<IntegrityReport> {
  const users = db.collection('users');
  const properties = db.collection('properties');
  const candidates = await Promise.all([
    duplicateFinding(users, 'email', 'DUPLICATE_USER_EMAIL'),
    duplicateFinding(users, 'phone', 'DUPLICATE_USER_PHONE'),
    danglingFinding(db, 'properties', 'ownerId', 'DANGLING_PROPERTY_OWNER'),
    danglingFinding(db, 'properties', 'reviewedBy', 'DANGLING_PROPERTY_REVIEWER'),
    danglingFinding(db, 'refresh_tokens', 'userId', 'DANGLING_REFRESH_TOKEN_USER'),
    danglingFinding(db, 'audit_logs', 'actorUserId', 'DANGLING_AUDIT_ACTOR'),
    danglingFinding(db, 'audit_logs', 'targetUserId', 'DANGLING_AUDIT_TARGET'),
    invalidEnumFinding(users, 'systemRole', Object.values(SystemRole), 'INVALID_SYSTEM_ROLE'),
    invalidEnumFinding(users, 'accountType', Object.values(AccountType), 'INVALID_ACCOUNT_TYPE'),
    invalidEnumFinding(users, 'accountStatus', Object.values(AccountStatus), 'INVALID_ACCOUNT_STATUS'),
    invalidEnumFinding(users, 'brokerStatus', Object.values(BrokerStatus), 'INVALID_BROKER_STATUS'),
    invalidEnumFinding(users, 'verificationTrustState', Object.values(VerificationTrustState), 'INVALID_TRUST_STATE'),
    invalidEnumFinding(users, 'primaryIdentifierType', Object.values(PrimaryIdentifierType), 'INVALID_PRIMARY_IDENTIFIER_TYPE'),
    invalidEnumFinding(properties, 'status', ['pending_review', 'approved', 'rejected', 'hidden'], 'INVALID_PROPERTY_STATUS'),
    danglingCatalogFinding(db, 'propertyTypeCode', 'property_types', 'DANGLING_PROPERTY_TYPE'),
    danglingCatalogFinding(db, 'governorateCode', 'governorates', 'DANGLING_GOVERNORATE'),
    danglingCatalogFinding(db, 'amenityCodes', 'amenities', 'DANGLING_AMENITY', true),
    danglingPropertyOptionFinding(db, 'finishingStatusCode', 'finishing_status', 'DANGLING_FINISHING_STATUS'),
    danglingPropertyOptionFinding(db, 'deliveryStatusCode', 'delivery_status', 'DANGLING_DELIVERY_STATUS'),
    danglingPropertyOptionFinding(db, 'paymentMethodCode', 'payment_method', 'DANGLING_PAYMENT_METHOD'),
    catalogDriftFinding(db, 'property_types', 'propertyTypeCode', 'PROPERTY_TYPE_USAGE_DRIFT'),
    catalogDriftFinding(db, 'governorates', 'governorateCode', 'GOVERNORATE_USAGE_DRIFT'),
    catalogDriftFinding(db, 'amenities', 'amenityCodes', 'AMENITY_USAGE_DRIFT', true),
    propertyOptionDriftFinding(db),
  ]);
  const findings = candidates.filter((finding): finding is IntegrityFinding => finding !== null);
  const errorCount = findings.filter((finding) => finding.severity === 'error').reduce((sum, finding) => sum + finding.count, 0);
  const warningCount = findings.filter((finding) => finding.severity === 'warning').reduce((sum, finding) => sum + finding.count, 0);
  return { generatedAt: now.toISOString(), ok: errorCount === 0, errorCount, warningCount, findings };
}
