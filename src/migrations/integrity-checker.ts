import type { Collection, Db, Document } from 'mongodb';
import { SystemRole } from '../auth/roles.enum';
import { AccountStatus, AccountType, BrokerStatus, PrimaryIdentifierType, VerificationTrustState } from '../users/identity.types';
import { EFFECTIVE_TYPE_SELECTION, PROPERTY_TYPE_SELECTION_BACKFILL_FILTER, SELECTION_MISSING_PRIMARY_FILTER } from './022-property-type-selection';
import { approvedFacets } from '../properties/property-form-write';
import { effectiveSpec } from '../properties/property-specifications';

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

async function filterFinding(collection: Collection, filter: Document, code: string, severity: IntegrityFinding['severity'], message: string): Promise<IntegrityFinding | null> {
  const count = await collection.countDocuments(filter);
  if (!count) return null;
  const samples = await collection.find(filter, { projection: { _id: 1 } }).limit(SAMPLE_LIMIT).toArray();
  return { code, severity, count, sampleIds: samples.map((row) => String(row._id)), message };
}

/**
 * Per selected type (the stored array, or [primary] for pre-DPF-005 rows):
 * `dangling` finds references to missing property_types; `mixedPurpose` finds
 * selected types whose parent purpose differs from the record's purpose.
 */
export function selectedTypeCheckPipeline(mode: 'dangling' | 'mixedPurpose'): Document[] {
  return [
    { $project: { purposeCategoryId: 1, _selection: EFFECTIVE_TYPE_SELECTION } },
    { $unwind: '$_selection' },
    { $lookup: { from: 'property_types', localField: '_selection', foreignField: '_id', as: '_type' } },
    mode === 'dangling'
      ? { $match: { '_type.0': { $exists: false } } }
      : { $match: { purposeCategoryId: { $ne: null }, '_type.0': { $exists: true }, $expr: { $ne: [{ $arrayElemAt: ['$_type.purposeCategoryId', 0] }, '$purposeCategoryId'] } } },
    { $group: { _id: '$_id' } },
    { $facet: { count: [{ $count: 'value' }], samples: [{ $limit: SAMPLE_LIMIT }] } },
  ];
}

async function selectedTypeFinding(db: Db, collectionName: string, mode: 'dangling' | 'mixedPurpose', code: string, message: string): Promise<IntegrityFinding | null> {
  const rows = await db.collection(collectionName).aggregate(selectedTypeCheckPipeline(mode)).toArray();
  const count = Number(rows[0]?.count?.[0]?.value ?? 0);
  if (!count) return null;
  return { code, severity: 'error', count, sampleIds: (rows[0].samples as Document[]).map((row) => String(row._id)), message };
}

/**
 * A property references a type when the type is in its effective selection;
 * pre-revision legacy rows without purposeSubcategoryId still count by code.
 */
export const PROPERTY_REFERENCES_TYPE: Document = {
  $or: [
    { $in: ['$$typeId', EFFECTIVE_TYPE_SELECTION] },
    { $and: [{ $not: [{ $ifNull: ['$purposeSubcategoryId', false] }] }, { $eq: ['$propertyTypeCode', '$$typeCode'] }] },
  ],
};

export function propertyTypeUsageDriftPipeline(): Document[] {
  return [
    { $lookup: { from: 'properties', let: { typeId: '$_id', typeCode: '$code' }, pipeline: [{ $match: { $expr: PROPERTY_REFERENCES_TYPE } }, { $count: 'value' }], as: '_actual' } },
    { $set: { _actualUsage: { $ifNull: [{ $arrayElemAt: ['$_actual.value', 0] }, 0] } } },
    { $match: { $expr: { $ne: [{ $ifNull: ['$usageCount', 0] }, '$_actualUsage'] } } },
    { $facet: { count: [{ $count: 'value' }], samples: [{ $limit: SAMPLE_LIMIT }, { $project: { _id: 1 } }] } },
  ];
}

async function propertyTypeUsageDriftFinding(db: Db): Promise<IntegrityFinding | null> {
  const rows = await db.collection('property_types').aggregate(propertyTypeUsageDriftPipeline()).toArray();
  const count = Number(rows[0]?.count?.[0]?.value ?? 0);
  if (!count) return null;
  return { code: 'PROPERTY_TYPE_USAGE_DRIFT', severity: 'warning', count, sampleIds: (rows[0].samples as Document[]).map((row) => String(row._id)), message: 'property_types.usageCount differs from properties selecting the type' };
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

/** Order-insensitive facet equality; array-valued facets (e.g. `commercialUseTypes`) compare as sets. Exported for the Phase 9 backfill migration, which uses the identical comparison to decide whether a write is needed. */
export function facetsMatch(stored: Record<string, unknown> | undefined | null, expected: Record<string, unknown> | undefined | null): boolean {
  const a = stored ?? {};
  const b = expected ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = (a as Record<string, unknown>)[key];
    const y = (b as Record<string, unknown>)[key];
    if (Array.isArray(x) || Array.isArray(y)) {
      const xs = Array.isArray(x) ? [...x].sort() : [];
      const ys = Array.isArray(y) ? [...y].sort() : [];
      if (JSON.stringify(xs) !== JSON.stringify(ys)) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/**
 * Phase 9 (Search & Facets): compares each property's stored `facets` against
 * a fresh recomputation (the same `approvedFacets()` derivation approval
 * uses) from its current public revision's effective attributes. Read-only —
 * never repairs anything; a mismatch means the Phase 9 backfill (or a normal
 * re-approval) has not yet run for that property.
 */
async function propertyFacetDriftFinding(db: Db): Promise<IntegrityFinding | null> {
  const properties = await db
    .collection('properties')
    .aggregate([{ $match: { currentPublicRevisionId: { $exists: true, $ne: null } } }, { $project: { _id: 1, facets: 1, currentPublicRevisionId: 1 } }])
    .toArray();
  if (!properties.length) return null;
  const revisionIds = [...new Set(properties.map((property) => property.currentPublicRevisionId))];
  const revisions = await db.collection('property_revisions').aggregate([{ $match: { _id: { $in: revisionIds } } }]).toArray();
  const revisionById = new Map(revisions.map((revision) => [String(revision._id), revision]));
  const drifting: string[] = [];
  for (const property of properties) {
    const revision = revisionById.get(String(property.currentPublicRevisionId));
    if (!revision) continue; // a dangling currentPublicRevisionId is a separate, unrelated concern.
    const expected = approvedFacets(effectiveSpec(revision).attributes);
    if (!facetsMatch(property.facets, expected)) drifting.push(String(property._id));
  }
  if (!drifting.length) return null;
  return {
    code: 'PROPERTY_FACET_DRIFT',
    severity: 'warning',
    count: drifting.length,
    sampleIds: drifting.slice(0, SAMPLE_LIMIT),
    message: 'Property.facets does not match a fresh recomputation from the current public revision (run the Phase 9 facet backfill, or the property will self-correct on its next re-approval)',
  };
}

export async function runIntegrityChecks(db: Db, now: Date = new Date()): Promise<IntegrityReport> {
  const users = db.collection('users');
  const properties = db.collection('properties');
  const revisions = db.collection('property_revisions');
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
    propertyTypeUsageDriftFinding(db),
    filterFinding(properties, PROPERTY_TYPE_SELECTION_BACKFILL_FILTER, 'PROPERTY_TYPE_SELECTION_BACKFILL_MISSING', 'error', 'Properties with a primary type lack purposeSubcategoryIds (run migration 022)'),
    filterFinding(properties, SELECTION_MISSING_PRIMARY_FILTER, 'PROPERTY_TYPE_SELECTION_MISSING_PRIMARY', 'error', 'Property purposeSubcategoryIds does not contain the primary type'),
    filterFinding(revisions, SELECTION_MISSING_PRIMARY_FILTER, 'REVISION_TYPE_SELECTION_MISSING_PRIMARY', 'error', 'Revision purposeSubcategoryIds does not contain the primary type'),
    selectedTypeFinding(db, 'properties', 'mixedPurpose', 'PROPERTY_TYPE_SELECTION_MIXED_PURPOSE', 'Properties select a type that belongs to another purpose'),
    selectedTypeFinding(db, 'property_revisions', 'mixedPurpose', 'REVISION_TYPE_SELECTION_MIXED_PURPOSE', 'Revisions select a type that belongs to another purpose'),
    selectedTypeFinding(db, 'properties', 'dangling', 'DANGLING_SELECTED_PROPERTY_TYPE', 'Properties select property types that no longer exist'),
    selectedTypeFinding(db, 'property_revisions', 'dangling', 'DANGLING_REVISION_SELECTED_PROPERTY_TYPE', 'Revisions select property types that no longer exist'),
    filterFinding(db.collection('property_types'), { isActive: true, purposeCategoryId: null }, 'ACTIVE_PROPERTY_TYPE_WITHOUT_PURPOSE', 'warning', 'Active property types have no purpose category and cannot be selected'),
    filterFinding(properties, { purposeSubcategoryId: null }, 'PROPERTY_MISSING_PRIMARY_TYPE', 'warning', 'Properties have no purposeSubcategoryId (historical data; reported, not corrected)'),
    filterFinding(revisions, { purposeSubcategoryId: null }, 'REVISION_MISSING_PRIMARY_TYPE', 'warning', 'Revisions have no purposeSubcategoryId (historical data; reported, not corrected)'),
    catalogDriftFinding(db, 'governorates', 'governorateCode', 'GOVERNORATE_USAGE_DRIFT'),
    catalogDriftFinding(db, 'amenities', 'amenityCodes', 'AMENITY_USAGE_DRIFT', true),
    propertyOptionDriftFinding(db),
    propertyFacetDriftFinding(db),
  ]);
  const findings = candidates.filter((finding): finding is IntegrityFinding => finding !== null);
  const errorCount = findings.filter((finding) => finding.severity === 'error').reduce((sum, finding) => sum + finding.count, 0);
  const warningCount = findings.filter((finding) => finding.severity === 'warning').reduce((sum, finding) => sum + finding.count, 0);
  return { generatedAt: now.toISOString(), ok: errorCount === 0, errorCount, warningCount, findings };
}
