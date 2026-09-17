import { ObjectId, type Collection, type Document } from 'mongodb';
import { EGP_CURRENCY, propertyMoneyFromStoredRecord } from '../../common/money/money';
import { planUserIdentityMigration, scanUserIdentityMigration } from '../007-user-identity-contract';
import {
  planPropertyMoneyMigration,
  scanPropertyMoneyMigration,
} from '../006-property-money-minor-units';
import type { MigrationDefinition, MigrationContext } from './migration.types';
import { legacyRevisionPointer, planLegacyPropertyRevision, scanLegacyPropertyRevisionMigration } from '../015-property-attribution-revisions';

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

const brokerIndexes = [
  {
    collection: 'broker_applications',
    key: { applicantAccountId: 1, applicationVersion: 1 },
    options: { unique: true, name: 'broker_application_version_unique' },
  },
  {
    collection: 'broker_applications',
    key: { applicantAccountId: 1, idempotencyKeyHash: 1 },
    options: { unique: true, name: 'broker_application_idempotency_unique' },
  },
  {
    collection: 'broker_applications',
    key: { applicantAccountId: 1, status: 1 },
    options: {
      unique: true,
      partialFilterExpression: { status: 'PENDING' },
      name: 'broker_application_pending_unique',
    },
  },
  {
    collection: 'broker_applications',
    key: { status: 1, submittedAt: 1, _id: 1 },
    options: { name: 'broker_application_review_queue' },
  },
  {
    collection: 'broker_verification_documents',
    key: { applicationId: 1, requirementCode: 1 },
    options: { unique: true, name: 'broker_document_application_requirement_unique' },
  },
  {
    collection: 'broker_verification_documents',
    key: { applicantAccountId: 1, submittedAt: -1 },
    options: { name: 'broker_document_applicant_history' },
  },
  {
    collection: 'broker_verification_requirements',
    key: { code: 1 },
    options: { unique: true, name: 'broker_requirement_code_unique' },
  },
  {
    collection: 'broker_verification_requirements',
    key: { isActive: 1, sortOrder: 1, code: 1 },
    options: { name: 'broker_requirement_active_order' },
  },
] as const;

async function brokerDuplicateBlockers(db: MigrationContext['db']) {
  const applications = db.collection('broker_applications');
  const duplicates = await applications.aggregate([
    {
      $facet: {
        versions: [
          { $group: { _id: { applicantAccountId: '$applicantAccountId', applicationVersion: '$applicationVersion' }, count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $limit: 20 },
        ],
        pending: [
          { $match: { status: 'PENDING' } },
          { $group: { _id: '$applicantAccountId', count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $limit: 20 },
        ],
        idempotency: [
          { $match: { idempotencyKeyHash: { $type: 'string' } } },
          { $group: { _id: { applicantAccountId: '$applicantAccountId', idempotencyKeyHash: '$idempotencyKeyHash' }, count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $limit: 20 },
        ],
      },
    },
  ]).toArray();
  const result = duplicates[0] ?? { versions: [], pending: [], idempotency: [] };
  return [
    ...(result.versions.length ? [{ code: 'BROKER_APPLICATION_VERSION_DUPLICATES', message: `${result.versions.length} duplicate application versions require review` }] : []),
    ...(result.pending.length ? [{ code: 'BROKER_APPLICATION_PENDING_DUPLICATES', message: `${result.pending.length} applicants have multiple pending applications` }] : []),
    ...(result.idempotency.length ? [{ code: 'BROKER_APPLICATION_IDEMPOTENCY_DUPLICATES', message: `${result.idempotency.length} duplicate idempotency keys require review` }] : []),
  ];
}

async function existingIndexNames(
  db: MigrationContext['db'],
  collectionName: string,
): Promise<Set<string>> {
  try {
    const indexes = await db.collection(collectionName).indexes();
    return new Set(indexes.map((index) => index.name).filter(Boolean) as string[]);
  } catch (error) {
    if ((error as { code?: number })?.code === 26) return new Set();
    throw error;
  }
}

export const brokerLifecycleIndexesMigration: MigrationDefinition = {
  id: '012-broker-lifecycle-indexes',
  version: 1,
  description: 'Create additive unique and queue indexes for versioned broker applications',
  dependencies: ['007-user-identity-contract'],
  rollback: {
    kind: 'none',
    remediation: 'Disable broker application routes and inspect the migration ledger; retain broker collections, evidence, audit history, and indexes.',
    restoreProcedure: 'Restore the verified pre-deployment snapshot to a separate database and reconcile broker records before any reviewed remediation.',
  },
  async preflight({ db }) {
    const blockers = await brokerDuplicateBlockers(db);
    const namesByCollection = new Map<string, Set<string>>();
    for (const index of brokerIndexes) {
      if (!namesByCollection.has(index.collection)) {
        namesByCollection.set(
          index.collection,
          await existingIndexNames(db, index.collection),
        );
      }
    }
    const alreadyApplied = brokerIndexes.filter((index) =>
      namesByCollection.get(index.collection)?.has(index.options.name),
    ).length;
    return {
      eligible: brokerIndexes.length - alreadyApplied,
      alreadyApplied,
      blockers,
      summary: {
        indexNames: brokerIndexes.map((index) => index.options.name),
        existingUsersModified: 0,
      },
    };
  },
  async migrateBatch({ db }) {
    for (const index of brokerIndexes) {
      await db.collection(index.collection).createIndex(index.key, index.options as any);
    }
    return { scanned: brokerIndexes.length, modified: brokerIndexes.length, done: true };
  },
  async validate({ db }) {
    const missing: string[] = [];
    for (const expected of brokerIndexes) {
      const indexes = await existingIndexNames(db, expected.collection);
      if (!indexes.has(expected.options.name)) {
        missing.push(expected.options.name);
      }
    }
    return {
      valid: missing.length === 0,
      errors: missing.map((name) => ({
        code: 'BROKER_INDEX_MISSING',
        message: `Required broker index ${name} is missing`,
      })),
      summary: { expectedIndexes: brokerIndexes.length, missingIndexes: missing },
    };
  },
};

export const propertyAttributionRevisionMigration: MigrationDefinition = {
  id: '015-property-attribution-revisions',
  version: 1,
  description: 'Create conservative revision 1 and server-derived advertiser attribution for legacy properties',
  dependencies: ['006-property-money-minor-units', '007-user-identity-contract'],
  rollback: {
    kind: 'none',
    remediation: 'Stop new property writes and use propertyContractMigrationRunId plus property_revisions migration metadata for reviewed record-level repair; preserve all legacy fields.',
    restoreProcedure: 'Restore the verified pre-migration snapshot to a separate database and compare before any production remediation.',
  },
  async preflight({ db }) {
    const scan = await scanLegacyPropertyRevisionMigration(db);
    return {
      eligible: scan.eligible,
      alreadyApplied: scan.alreadyMigrated,
      blockers: scan.invalidCount ? [{ code: 'PROPERTY_REVISION_MIGRATION_BLOCKED', message: `${scan.invalidCount} properties lack safe attribution or valid money evidence`, sampleIds: scan.invalid.slice(0, 20).map((item) => item.id) }] : [],
      summary: { warnings: scan.warnings, existingPropertiesDeleted: 0, legacyFieldsRemoved: 0 },
    };
  },
  async migrateBatch(context) {
    const properties = context.db.collection('properties');
    const documents = await nextBatch(properties, context);
    let modified = 0;
    for (const property of documents) {
      if (property.propertyContractVersion >= 1) continue;
      const ownerId = property.ownerId instanceof ObjectId ? property.ownerId : new ObjectId(property.ownerId);
      const advertiser = await context.db.collection('users').findOne({ _id: ownerId });
      if (!advertiser) throw new RangeError(`Property ${property._id} owner account does not exist`);
      const propertyType = typeof property.propertyTypeCode === 'string'
        ? await context.db.collection('property_types').findOne({ code: property.propertyTypeCode })
        : undefined;
      const paymentExists = typeof property.paymentMethodCode === 'string'
        ? Boolean(await context.db.collection('property_options').findOne({ group: 'payment_method', code: property.paymentMethodCode }))
        : false;
      const plan = planLegacyPropertyRevision(property, advertiser, propertyType ?? undefined, paymentExists);
      let revision = await context.db.collection('property_revisions').findOne({ propertyId: property._id, revisionNumber: 1 });
      if (!revision) {
        const revisionId = new ObjectId();
        const now = new Date();
        await context.db.collection('property_revisions').insertOne({
          _id: revisionId,
          ...plan.revision,
          migrationVersion: 1,
          migrationRunId: context.runId,
          migratedAt: now,
          version: 0,
          createdAt: property.createdAt ?? now,
          updatedAt: now,
        });
        revision = { _id: revisionId };
      }
      const pointer = legacyRevisionPointer(property.status, revision._id as ObjectId);
      const update = await properties.updateOne(
        { _id: property._id, propertyContractVersion: { $exists: false } },
        { $set: { ...plan.propertySet, ...pointer, propertyContractMigrationRunId: context.runId, propertyContractMigratedAt: new Date() } },
      );
      modified += update.modifiedCount;
    }
    return { scanned: documents.length, modified, checkpoint: documents.at(-1)?._id.toString(), done: documents.length < context.batchSize };
  },
  async validate({ db }) {
    const scan = await scanLegacyPropertyRevisionMigration(db);
    const missingPointers = await db.collection('properties').countDocuments({
      propertyContractVersion: { $gte: 1 },
      currentPublicRevisionId: { $exists: false },
      pendingRevisionId: { $exists: false },
    });
    const valid = scan.invalidCount === 0 && scan.eligible === 0 && missingPointers === 0;
    return {
      valid,
      errors: valid ? [] : [{ code: 'PROPERTY_REVISION_RECONCILIATION_FAILED', message: `${scan.invalidCount} invalid, ${scan.eligible} unmigrated, and ${missingPointers} pointerless properties remain` }],
      summary: { migrated: scan.alreadyMigrated, warnings: scan.warnings, missingPointers },
    };
  },
};

const propertyDomainIndexes = [
  { collection: 'properties', key: { advertiserAccountId: 1, createdAt: -1 }, options: { name: 'property_advertiser_created' } },
  { collection: 'property_revisions', key: { propertyId: 1, revisionNumber: 1 }, options: { unique: true, name: 'property_revision_sequence_unique' } },
  { collection: 'property_revisions', key: { moderationStatus: 1, createdAt: 1, _id: 1 }, options: { name: 'property_revision_review_queue' } },
  { collection: 'property_purpose_categories', key: { code: 1 }, options: { unique: true, name: 'property_purpose_code_unique' } },
  { collection: 'property_purpose_categories', key: { isActive: 1, sortOrder: 1, nameAr: 1 }, options: { name: 'property_purpose_active_order' } },
  { collection: 'property_types', key: { purposeCategoryId: 1, isActive: 1, sortOrder: 1 }, options: { name: 'property_subcategory_parent_active_order' } },
  { collection: 'managed_marketing_packages', key: { code: 1 }, options: { unique: true, name: 'managed_marketing_package_code_unique' } },
  { collection: 'managed_marketing_packages', key: { isActive: 1, sortOrder: 1, nameAr: 1 }, options: { name: 'managed_marketing_package_active_order' } },
  { collection: 'managed_marketing_requests', key: { advertiserAccountId: 1, createdAt: -1 }, options: { name: 'managed_marketing_request_advertiser_history' } },
  { collection: 'managed_marketing_requests', key: { status: 1, createdAt: 1, _id: 1 }, options: { name: 'managed_marketing_request_review_queue' } },
] as const;

export const propertyDomainIndexesMigration: MigrationDefinition = {
  id: '015-property-domain-indexes',
  version: 1,
  description: 'Create additive indexes for property attribution, revisions, purpose hierarchy, and managed-marketing foundation',
  dependencies: ['015-property-attribution-revisions'],
  rollback: {
    kind: 'none',
    remediation: 'Retain additive indexes and inspect the migration ledger; disable new property writes if reconciliation fails.',
    restoreProcedure: 'Restore the verified pre-migration snapshot to a separate database before reviewed remediation.',
  },
  async preflight({ db }) {
    const revisionDuplicates = await db.collection('property_revisions').aggregate([
      { $group: { _id: { propertyId: '$propertyId', revisionNumber: '$revisionNumber' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ]).toArray();
    const purposeDuplicates = await db.collection('property_purpose_categories').aggregate([
      { $group: { _id: '$code', count: { $sum: 1 } } },
      { $match: { _id: { $type: 'string' }, count: { $gt: 1 } } },
      { $limit: 20 },
    ]).toArray();
    const packageDuplicates = await db.collection('managed_marketing_packages').aggregate([
      { $group: { _id: '$code', count: { $sum: 1 } } },
      { $match: { _id: { $type: 'string' }, count: { $gt: 1 } } },
      { $limit: 20 },
    ]).toArray();
    let alreadyApplied = 0;
    for (const expected of propertyDomainIndexes) {
      if ((await existingIndexNames(db, expected.collection)).has(expected.options.name)) alreadyApplied += 1;
    }
    return {
      eligible: propertyDomainIndexes.length - alreadyApplied,
      alreadyApplied,
      blockers: [
        ...(revisionDuplicates.length ? [{ code: 'PROPERTY_REVISION_SEQUENCE_DUPLICATES', message: `${revisionDuplicates.length} duplicate revision sequences require review` }] : []),
        ...(purposeDuplicates.length ? [{ code: 'PROPERTY_PURPOSE_CODE_DUPLICATES', message: `${purposeDuplicates.length} duplicate purpose codes require review` }] : []),
        ...(packageDuplicates.length ? [{ code: 'MANAGED_MARKETING_PACKAGE_CODE_DUPLICATES', message: `${packageDuplicates.length} duplicate package codes require review` }] : []),
      ],
      summary: { indexNames: propertyDomainIndexes.map((item) => item.options.name) },
    };
  },
  async migrateBatch({ db }) {
    for (const index of propertyDomainIndexes) await db.collection(index.collection).createIndex(index.key, index.options as any);
    return { scanned: propertyDomainIndexes.length, modified: propertyDomainIndexes.length, done: true };
  },
  async validate({ db }) {
    const missing: string[] = [];
    for (const expected of propertyDomainIndexes) if (!(await existingIndexNames(db, expected.collection)).has(expected.options.name)) missing.push(expected.options.name);
    return { valid: missing.length === 0, errors: missing.map((name) => ({ code: 'PROPERTY_DOMAIN_INDEX_MISSING', message: `Required property-domain index ${name} is missing` })), summary: { missingIndexes: missing } };
  },
};

const accountDeletionIndexes = [
  { collection: 'account_deletion_requests', key: { userId: 1, workflowVersion: 1 }, options: { unique: true, name: 'account_deletion_user_version_unique' } },
  { collection: 'account_deletion_requests', key: { userId: 1, state: 1 }, options: { unique: true, partialFilterExpression: { state: { $in: ['PENDING', 'ANONYMIZING'] } }, name: 'account_deletion_active_unique' } },
  { collection: 'account_deletion_requests', key: { state: 1, recoverableUntil: 1, legalHold: 1 }, options: { name: 'account_deletion_processing_queue' } },
] as const;

export const accountDeletionIndexesMigration: MigrationDefinition = {
  id: '017-account-deletion-indexes',
  version: 1,
  description: 'Create additive workflow and processing indexes for retention-safe account deletion',
  dependencies: ['007-user-identity-contract', '015-property-domain-indexes'],
  rollback: {
    kind: 'none',
    remediation: 'Disable deletion-request and anonymization commands; retain workflow, audit, user, and historical marketplace records for reviewed remediation.',
    restoreProcedure: 'Restore a verified pre-deployment snapshot to a separate database and reconcile workflow records; never reverse anonymization automatically.',
  },
  async preflight({ db }) {
    const duplicateVersions = await db.collection('account_deletion_requests').aggregate([
      { $group: { _id: { userId: '$userId', workflowVersion: '$workflowVersion' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ]).toArray();
    const duplicateActive = await db.collection('account_deletion_requests').aggregate([
      { $match: { state: { $in: ['PENDING', 'ANONYMIZING'] } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ]).toArray();
    let alreadyApplied = 0;
    for (const expected of accountDeletionIndexes) {
      if ((await existingIndexNames(db, expected.collection)).has(expected.options.name)) alreadyApplied += 1;
    }
    return {
      eligible: accountDeletionIndexes.length - alreadyApplied,
      alreadyApplied,
      blockers: [
        ...(duplicateVersions.length ? [{ code: 'ACCOUNT_DELETION_VERSION_DUPLICATES', message: `${duplicateVersions.length} duplicate workflow versions require review` }] : []),
        ...(duplicateActive.length ? [{ code: 'ACCOUNT_DELETION_ACTIVE_DUPLICATES', message: `${duplicateActive.length} accounts have multiple active workflows` }] : []),
      ],
      summary: { existingUsersModified: 0, identifiersReleased: 0, recordsDeleted: 0 },
    };
  },
  async migrateBatch({ db }) {
    for (const index of accountDeletionIndexes) {
      await db.collection(index.collection).createIndex(index.key, index.options as any);
    }
    return { scanned: accountDeletionIndexes.length, modified: accountDeletionIndexes.length, done: true };
  },
  async validate({ db }) {
    const missing: string[] = [];
    for (const expected of accountDeletionIndexes) {
      if (!(await existingIndexNames(db, expected.collection)).has(expected.options.name)) missing.push(expected.options.name);
    }
    return {
      valid: missing.length === 0,
      errors: missing.map((name) => ({ code: 'ACCOUNT_DELETION_INDEX_MISSING', message: `Required account-deletion index ${name} is missing` })),
      summary: { missingIndexes: missing },
    };
  },
};

export const CORE_MIGRATIONS: MigrationDefinition[] = [
  propertyMoneyMigration,
  userIdentityMigration,
  brokerLifecycleIndexesMigration,
  propertyAttributionRevisionMigration,
  propertyDomainIndexesMigration,
  accountDeletionIndexesMigration,
];

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
