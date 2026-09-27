import { ObjectId, type Collection, type Document } from 'mongodb';
import { EGP_CURRENCY, propertyMoneyFromStoredRecord } from '../../common/money/money';
import { planUserIdentityMigration, scanUserIdentityMigration } from '../007-user-identity-contract';
import {
  planPropertyMoneyMigration,
  scanPropertyMoneyMigration,
} from '../006-property-money-minor-units';
import type { MigrationDefinition, MigrationContext } from './migration.types';
import { legacyRevisionPointer, planLegacyPropertyRevision, scanLegacyPropertyRevisionMigration } from '../015-property-attribution-revisions';
import {
  PROPERTY_TYPE_SELECTION_BACKFILL_FILTER,
  SELECTION_MISSING_PRIMARY_FILTER,
  listingIndexProblems,
  reconcileIndex,
  scanPropertyTypeSelection,
  type ExistingIndex,
} from '../022-property-type-selection';
import { PROPERTY_TYPE_LISTING_INDEXES, RETIRED_PURPOSE_LISTING_INDEX } from '../../properties/property-listing-indexes';
import {
  areaOutcome,
  buildLegacyPropertyDataReport,
  ensureFormDefinitionIndexes,
  pairWithPublicRevisions,
  resolveResidentialPurposeCategoryIds,
  scanAreaBackfill,
  scanLegacyDefinitions,
  scanRegistrySeed,
  seedLegacyDefinition,
  seedRegistry,
} from '../025-property-form-foundation';
import { LEGACY_RESIDENTIAL_CONTENT_HASH } from '../../property-form-definitions/property-form-definition.constants';

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

const propertyLifecycleIndexes = [
  { collection: 'property_revisions', key: { propertyId: 1, moderationStatus: 1 }, options: { unique: true, partialFilterExpression: { moderationStatus: 'pending_review' }, name: 'property_one_pending_revision' } },
  { collection: 'property_revisions', key: { propertyId: 1, moderationStatus: 1 }, options: { unique: true, partialFilterExpression: { moderationStatus: 'draft' }, name: 'property_one_draft_revision' } },
  { collection: 'property_revisions', key: { moderationStatus: 1, submittedAt: 1, _id: 1 }, options: { name: 'property_revision_pending_queue' } },
  { collection: 'properties', key: { lifecycleStatus: 1, currentPublicRevisionId: 1, createdAt: -1 }, options: { name: 'property_public_lifecycle' } },
] as const;

export const propertyLifecycleMigration: MigrationDefinition = {
  id: '019-property-lifecycle',
  version: 1,
  description: 'Backfill aggregate lifecycle controls and create revision-state concurrency indexes',
  dependencies: ['015-property-domain-indexes', '017-account-deletion-indexes'],
  rollback: {
    kind: 'none',
    remediation: 'Disable lifecycle commands and inspect migration_ledger; retain all aggregate pointers and immutable revisions.',
    restoreProcedure: 'Restore a verified snapshot to a separate database and reconcile pointer/state reports before reviewed repair.',
  },
  async preflight({ db }) {
    const duplicateActive = await db.collection('property_revisions').aggregate([
      { $match: { moderationStatus: { $in: ['draft', 'pending_review'] } } },
      { $group: { _id: { propertyId: '$propertyId', moderationStatus: '$moderationStatus' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }, { $limit: 20 },
    ]).toArray();
    const missingLifecycle = await db.collection('properties').countDocuments({ lifecycleStatus: { $exists: false } });
    let alreadyApplied = 0;
    for (const expected of propertyLifecycleIndexes) if ((await existingIndexNames(db, expected.collection)).has(expected.options.name)) alreadyApplied += 1;
    return { eligible: missingLifecycle + propertyLifecycleIndexes.length - alreadyApplied, alreadyApplied, blockers: duplicateActive.length ? [{ code: 'PROPERTY_MULTIPLE_ACTIVE_REVISIONS', message: `${duplicateActive.length} properties have duplicate draft/pending revisions and require manual reconciliation` }] : [], summary: { missingLifecycle, historicalFieldsFabricated: 0 } };
  },
  async migrateBatch({ db }) {
    const result = await db.collection('properties').updateMany({ lifecycleStatus: { $exists: false } }, { $set: { lifecycleStatus: 'active', lifecycleVersion: 0 } });
    for (const index of propertyLifecycleIndexes) await db.collection(index.collection).createIndex(index.key, index.options as any);
    return { scanned: result.matchedCount, modified: result.modifiedCount + propertyLifecycleIndexes.length, done: true };
  },
  async validate({ db }) {
    const missing: string[] = [];
    for (const expected of propertyLifecycleIndexes) if (!(await existingIndexNames(db, expected.collection)).has(expected.options.name)) missing.push(expected.options.name);
    const withoutLifecycle = await db.collection('properties').countDocuments({ lifecycleStatus: { $exists: false } });
    return { valid: missing.length === 0 && withoutLifecycle === 0, errors: [...missing.map(name => ({ code: 'PROPERTY_LIFECYCLE_INDEX_MISSING', message: `Required property lifecycle index ${name} is missing` })), ...(withoutLifecycle ? [{ code: 'PROPERTY_LIFECYCLE_BACKFILL_INCOMPLETE', message: `${withoutLifecycle} properties lack lifecycle state` }] : [])], summary: { missingIndexes: missing, withoutLifecycle } };
  },
};

export const managedMarketingRequestIndexesMigration: MigrationDefinition = {
  id: '020-managed-marketing-request-indexes',
  version: 1,
  description: 'Enforce one managed-marketing request snapshot per property revision',
  dependencies: ['015-property-domain-indexes'],
  rollback: {
    kind: 'none',
    remediation: 'Retain the uniqueness guarantee and review duplicate request creation attempts.',
    restoreProcedure: 'Restore the verified pre-migration snapshot to a separate database if rollback is required.',
  },
  async preflight({ db }) {
    const duplicates = await db.collection('managed_marketing_requests').aggregate([
      { $group: { _id: '$propertyRevisionId', count: { $sum: 1 } } },
      { $match: { _id: { $exists: true }, count: { $gt: 1 } } },
      { $limit: 20 },
    ]).toArray();
    const exists = (await existingIndexNames(db, 'managed_marketing_requests')).has('managed_marketing_request_revision_unique');
    return { eligible: exists ? 0 : 1, alreadyApplied: exists ? 1 : 0, blockers: duplicates.length ? [{ code: 'MANAGED_MARKETING_REQUEST_REVISION_DUPLICATES', message: `${duplicates.length} duplicate revision requests require review`, sampleIds: duplicates.map(item => String(item._id)) }] : [] };
  },
  async migrateBatch({ db }) {
    await db.collection('managed_marketing_requests').createIndex({ propertyRevisionId: 1 }, { unique: true, name: 'managed_marketing_request_revision_unique' });
    return { scanned: 1, modified: 1, done: true };
  },
  async validate({ db }) {
    const exists = (await existingIndexNames(db, 'managed_marketing_requests')).has('managed_marketing_request_revision_unique');
    return { valid: exists, errors: exists ? [] : [{ code: 'MANAGED_MARKETING_REQUEST_REVISION_INDEX_MISSING', message: 'Required managed-marketing revision index is missing' }] };
  },
};

const cityCatalogIndexes = [
  { key: { governorateId: 1, code: 1 }, options: { unique: true, name: 'city_governorate_code_unique' } },
  { key: { governorateId: 1, nameAr: 1 }, options: { unique: true, name: 'city_governorate_name_ar_unique' } },
  { key: { governorateId: 1, isActive: 1, sortOrder: 1, nameAr: 1 }, options: { name: 'city_public_catalog_order' } },
] as const;

/**
 * A reset that preserves indexes can leave an equivalent index for one of
 * these keys already present under a different name (e.g. from before the
 * migration's intended names existed). Such an index satisfies the migration
 * as-is: it is never dropped or renamed, and a new one is never created
 * alongside it. Only a same-key index with different uniqueness is treated as
 * a real conflict (fail closed) rather than silently accepted.
 */
async function planCityCatalogIndexes(db: MigrationContext['db']) {
  const existing = await existingIndexes(db, 'cities');
  return cityCatalogIndexes.map((index) => ({ index, ...reconcileIndex(existing, index) }));
}

export const cityCatalogIndexesMigration: MigrationDefinition = {
  id: '021-city-catalog-indexes',
  version: 1,
  description: 'Enforce governorate-scoped city uniqueness and public catalog lookup indexes',
  dependencies: ['015-property-domain-indexes'],
  rollback: {
    kind: 'none',
    remediation: 'Keep the catalog uniqueness guarantees and manually reconcile only duplicates reported by preflight.',
    restoreProcedure: 'Restore the verified pre-migration snapshot to a separate database if rollback is required.',
  },
  async preflight({ db }) {
    const duplicates = await db.collection('cities').aggregate([
      { $group: { _id: { governorateId: '$governorateId', code: '$code' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ]).toArray();
    const duplicateNames = await db.collection('cities').aggregate([
      { $group: { _id: { governorateId: '$governorateId', nameAr: '$nameAr' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ]).toArray();
    const plans = await planCityCatalogIndexes(db);
    const missing = plans.filter((plan) => plan.outcome === 'missing');
    const incompatible = plans.filter((plan) => plan.outcome === 'incompatible-key');
    const blockers = [
      ...([...duplicates, ...duplicateNames].length
        ? [{ code: 'CITY_CATALOG_DUPLICATES', message: 'Duplicate city codes or Arabic names require manual reconciliation before unique indexes can be created', sampleIds: [...duplicates, ...duplicateNames].map(item => JSON.stringify(item._id)) }]
        : []),
      ...(incompatible.length
        ? [{ code: 'CITY_CATALOG_INDEX_INCOMPATIBLE', message: `An index on the same keys as ${incompatible.map(plan => plan.index.options.name).join(', ')} already exists (as ${incompatible.map(plan => plan.existingName).join(', ')}) with incompatible options and must be reconciled manually before this migration can run`, sampleIds: incompatible.map(plan => plan.existingName!) }]
        : []),
    ];
    return { eligible: missing.length, alreadyApplied: cityCatalogIndexes.length - missing.length - incompatible.length, blockers, summary: { incompatible: incompatible.length } };
  },
  async migrateBatch({ db }) {
    const plans = await planCityCatalogIndexes(db);
    let modified = 0;
    for (const plan of plans) {
      if (plan.outcome === 'missing') { await db.collection('cities').createIndex(plan.index.key, plan.index.options); modified += 1; }
      else if (plan.outcome === 'incompatible-key') throw new Error(`Cannot create ${plan.index.options.name}: an equivalent-key index "${plan.existingName}" exists with incompatible options`);
      // 'satisfied-by-name' / 'satisfied-by-equivalent-key': already correct, left untouched.
    }
    return { scanned: cityCatalogIndexes.length, modified, done: true };
  },
  async validate({ db }) {
    const plans = await planCityCatalogIndexes(db);
    const unsatisfied = plans.filter((plan) => plan.outcome === 'missing' || plan.outcome === 'incompatible-key');
    return {
      valid: unsatisfied.length === 0,
      errors: unsatisfied.map((plan) => ({
        code: plan.outcome === 'incompatible-key' ? 'CITY_CATALOG_INDEX_INCOMPATIBLE' : 'CITY_CATALOG_INDEX_MISSING',
        message: plan.outcome === 'incompatible-key'
          ? `Required city catalog index ${plan.index.options.name} is blocked by an incompatible equivalent-key index (${plan.existingName})`
          : `Required city catalog index ${plan.index.options.name} is missing`,
      })),
      summary: { unsatisfied: unsatisfied.map((plan) => plan.index.options.name) },
    };
  },
};

async function existingIndexes(db: MigrationContext['db'], collectionName: string): Promise<ExistingIndex[]> {
  try {
    return await db.collection(collectionName).indexes() as ExistingIndex[];
  } catch (error) {
    if ((error as { code?: number })?.code === 26) return [];
    throw error;
  }
}

export const propertyTypeSelectionBackfillMigration: MigrationDefinition = {
  id: '022-property-type-selection-backfill',
  version: 1,
  description: 'DPF-006 M-F: backfill Property.purposeSubcategoryIds = [purposeSubcategoryId] where the array is missing; revisions are never rewritten',
  dependencies: ['015-property-attribution-revisions'],
  rollback: {
    kind: 'none',
    remediation: 'The backfill only adds [purposeSubcategoryId] where the array was absent and never changes the primary. Inspect migration_ledger and the integrity report before any reviewed repair.',
    restoreProcedure: 'Restore the verified pre-migration snapshot to a separate database and compare purposeSubcategoryIds before any production remediation.',
  },
  async preflight({ db }) {
    const scan = await scanPropertyTypeSelection(db);
    return { eligible: scan.eligible, alreadyApplied: scan.alreadyApplied, blockers: [], summary: scan.report };
  },
  async migrateBatch(context) {
    const properties = context.db.collection('properties');
    const batch = await properties.find({ ...PROPERTY_TYPE_SELECTION_BACKFILL_FILTER, ...afterCheckpoint(context.checkpoint) }, { projection: { _id: 1, purposeSubcategoryId: 1 } })
      .sort({ _id: 1 }).limit(context.batchSize).toArray();
    if (!batch.length) return { scanned: 0, modified: 0, done: true };
    // Guarded per document: a row written meanwhile by the application (which
    // always sets the array) or re-pointed to another primary is left untouched.
    const result = await properties.bulkWrite(batch.map((property) => ({
      updateOne: {
        filter: { _id: property._id, purposeSubcategoryIds: { $exists: false }, purposeSubcategoryId: property.purposeSubcategoryId },
        update: { $set: { purposeSubcategoryIds: [property.purposeSubcategoryId] } },
      },
    })), { ordered: false });
    return { scanned: batch.length, modified: result.modifiedCount, checkpoint: String(batch[batch.length - 1]._id), done: batch.length < context.batchSize };
  },
  async validate({ db }) {
    const properties = db.collection('properties');
    const [notBackfilled, missingPrimary] = await Promise.all([
      properties.countDocuments(PROPERTY_TYPE_SELECTION_BACKFILL_FILTER),
      properties.countDocuments(SELECTION_MISSING_PRIMARY_FILTER),
    ]);
    return {
      valid: notBackfilled === 0 && missingPrimary === 0,
      errors: [
        ...(notBackfilled ? [{ code: 'PROPERTY_TYPE_SELECTION_BACKFILL_INCOMPLETE', message: `${notBackfilled} properties with a primary type still lack purposeSubcategoryIds` }] : []),
        ...(missingPrimary ? [{ code: 'PROPERTY_TYPE_SELECTION_MISSING_PRIMARY', message: `${missingPrimary} properties have a purposeSubcategoryIds that does not contain the primary type` }] : []),
      ],
      summary: { notBackfilled, missingPrimary },
    };
  },
};

export const propertyTypeListingIndexesMigration: MigrationDefinition = {
  id: '023-property-type-listing-indexes',
  version: 1,
  description: 'DPF-007 M-G: create the purpose-only and multikey any-selected-type public listing indexes',
  dependencies: ['022-property-type-selection-backfill'],
  rollback: {
    kind: 'none',
    remediation: 'The indexes are additive; the retired purpose index stays in place until the manual migration 024 is run.',
    restoreProcedure: 'Drop only the two indexes named by this migration if a reviewed rollback of the search switch requires it.',
  },
  async preflight({ db }) {
    const { missing, conflicting } = listingIndexProblems(await existingIndexes(db, 'properties'));
    return {
      eligible: missing.length,
      alreadyApplied: PROPERTY_TYPE_LISTING_INDEXES.length - missing.length - conflicting.length,
      blockers: conflicting.length ? [{ code: 'PROPERTY_LISTING_INDEX_CONFLICT', message: `An index named ${conflicting.join(', ')} exists with a different key` }] : [],
      summary: { indexNames: PROPERTY_TYPE_LISTING_INDEXES.map((index) => index.options.name) },
    };
  },
  async migrateBatch({ db }) {
    for (const index of PROPERTY_TYPE_LISTING_INDEXES) await db.collection('properties').createIndex(index.key, index.options);
    return { scanned: PROPERTY_TYPE_LISTING_INDEXES.length, modified: PROPERTY_TYPE_LISTING_INDEXES.length, done: true };
  },
  async validate({ db }) {
    const { missing, conflicting } = listingIndexProblems(await existingIndexes(db, 'properties'));
    const problems = [...missing, ...conflicting];
    return {
      valid: problems.length === 0,
      errors: problems.map((name) => ({ code: 'PROPERTY_LISTING_INDEX_MISSING', message: `Required listing index ${name} is missing or has a different key` })),
      summary: { missingIndexes: missing, conflictingIndexes: conflicting },
    };
  },
};

/**
 * Manual-only: run with `--migration=024-retire-property-purpose-listing-index`
 * once the any-type search is live and verified. Never part of a full apply.
 */
export const retirePurposeListingIndexMigration: MigrationDefinition = {
  id: '024-retire-property-purpose-listing-index',
  version: 1,
  description: 'DPF-007 M-G: drop the replaced property_public_listing_purpose index after the any-type search is verified',
  dependencies: ['023-property-type-listing-indexes'],
  manualOnly: true,
  rollback: {
    kind: 'automatic',
    instructions: `Recreate ${RETIRED_PURPOSE_LISTING_INDEX.options.name} with key ${JSON.stringify(RETIRED_PURPOSE_LISTING_INDEX.key)}.`,
  },
  async preflight({ db }) {
    const indexes = await existingIndexes(db, 'properties');
    const { missing, conflicting } = listingIndexProblems(indexes);
    const notBackfilled = await db.collection('properties').countDocuments(PROPERTY_TYPE_SELECTION_BACKFILL_FILTER);
    const present = indexes.some((index) => index.name === RETIRED_PURPOSE_LISTING_INDEX.options.name);
    return {
      eligible: present ? 1 : 0,
      alreadyApplied: present ? 0 : 1,
      blockers: [
        ...(missing.length || conflicting.length ? [{ code: 'PROPERTY_LISTING_REPLACEMENT_INDEX_MISSING', message: `Replacement listing indexes are not in place: ${[...missing, ...conflicting].join(', ')}` }] : []),
        ...(notBackfilled ? [{ code: 'PROPERTY_TYPE_SELECTION_BACKFILL_INCOMPLETE', message: `${notBackfilled} properties still lack purposeSubcategoryIds` }] : []),
      ],
    };
  },
  async migrateBatch({ db }) {
    const present = (await existingIndexes(db, 'properties')).some((index) => index.name === RETIRED_PURPOSE_LISTING_INDEX.options.name);
    if (present) await db.collection('properties').dropIndex(RETIRED_PURPOSE_LISTING_INDEX.options.name);
    return { scanned: 1, modified: present ? 1 : 0, done: true };
  },
  async validate({ db }) {
    const indexes = await existingIndexes(db, 'properties');
    const retiredPresent = indexes.some((index) => index.name === RETIRED_PURPOSE_LISTING_INDEX.options.name);
    const { missing, conflicting } = listingIndexProblems(indexes);
    return {
      valid: !retiredPresent && !missing.length && !conflicting.length,
      errors: [
        ...(retiredPresent ? [{ code: 'PROPERTY_RETIRED_LISTING_INDEX_PRESENT', message: `${RETIRED_PURPOSE_LISTING_INDEX.options.name} still exists` }] : []),
        ...[...missing, ...conflicting].map((name) => ({ code: 'PROPERTY_LISTING_INDEX_MISSING', message: `Required listing index ${name} is missing or has a different key` })),
      ],
    };
  },
};

/** M-A (DPF-013): the engineering-owned registry entries the legacy form needs. Insert-only. */
export const propertyAttributeRegistryMigration: MigrationDefinition = {
  id: '025-property-attribute-registry',
  version: 1,
  description: 'DPF-013 M-A: seed the legacy residential Attribute Registry entries (insert-only; existing keys are never modified)',
  rollback: {
    kind: 'none',
    remediation: 'Registry keys are immutable identity and may already be referenced by form versions; never delete them. Inspect migration_ledger and the registry before any reviewed repair.',
    restoreProcedure: 'Restore the verified pre-migration snapshot to a separate database and compare property_attributes before any production remediation.',
  },
  async preflight({ db }) {
    const { missing, matching, conflicting, inactive } = await scanRegistrySeed(db);
    return {
      eligible: missing.length,
      alreadyApplied: matching.length,
      blockers: conflicting.length ? [{ code: 'PROPERTY_ATTRIBUTE_SEED_CONFLICT', message: `Registry keys exist with a different identity: ${conflicting.join(', ')}` }] : [],
      summary: { missing, conflicting, inactive },
    };
  },
  async migrateBatch({ db }) {
    const inserted = await seedRegistry(db, new Date());
    return { scanned: 1, modified: inserted, done: true };
  },
  async validate({ db }) {
    const { missing, conflicting } = await scanRegistrySeed(db);
    const problems = [...missing, ...conflicting];
    return {
      valid: problems.length === 0,
      errors: problems.map((key) => ({ code: 'PROPERTY_ATTRIBUTE_SEED_MISSING', message: `Registry key ${key} is missing or has a different identity` })),
    };
  },
};

/**
 * M-B (DPF-013): a head plus published legacy v1 for every existing RESIDENTIAL
 * property type only. The legacy form (bedrooms/bathrooms/…, `residential_rooms`
 * media) is residential-only content; eligibility is resolved through the actual
 * `purposeCategoryId` -> `property_purpose_categories.code === 'residential'`
 * relationship, never inferred from type name/code. Non-residential types are
 * left without a form (until Phase 8 authors real ones); an Admin-authored head
 * on any type, residential or not, is never touched.
 */
export const legacyPropertyFormDefinitionsMigration: MigrationDefinition = {
  id: '026-legacy-property-form-definitions',
  version: 1,
  description: 'DPF-013 M-B: create a FormDefinition head and an immutable published legacy residential v1 for every existing residential-purpose property type',
  dependencies: ['025-property-attribute-registry'],
  rollback: {
    kind: 'none',
    remediation: 'Published versions are immutable and may already be pinned by revisions; never delete them. Archive a definition through the Admin lifecycle instead.',
    restoreProcedure: 'Restore the verified pre-migration snapshot to a separate database and compare property_form_definitions/_versions before any production remediation.',
  },
  async preflight({ db }) {
    const registry = await scanRegistrySeed(db);
    const scanResult = await scanLegacyDefinitions(db);
    const registryProblems = [...registry.missing, ...registry.conflicting, ...registry.inactive];
    const eligible = scanResult.withoutHead + scanResult.seededHeadsMissingVersion;
    return {
      eligible,
      alreadyApplied: scanResult.types - eligible,
      blockers: [
        ...(registryProblems.length ? [{ code: 'PROPERTY_ATTRIBUTE_REGISTRY_INCOMPLETE', message: `Legacy registry keys are missing, conflicting or inactive: ${registryProblems.join(', ')}` }] : []),
        ...(scanResult.invalidSeededVersions.length ? [{ code: 'LEGACY_FORM_VERSION_MISMATCH', message: 'Seeded legacy versions do not match the legacy content hash', sampleIds: scanResult.invalidSeededVersions.slice(0, 20) }] : []),
        ...(scanResult.invalidNonResidentialLegacy.length ? [{ code: 'LEGACY_FORM_DEFINITION_INVALID_PURPOSE', message: `Non-residential property types incorrectly carry a seeded legacy-residential form and must be reconciled manually before this migration can run: ${scanResult.invalidNonResidentialLegacy.join(', ')}`, sampleIds: scanResult.invalidNonResidentialLegacy.slice(0, 20) }] : []),
      ],
      summary: { propertyTypes: scanResult.types, residentialTypes: scanResult.residentialTypes, legacyContentHash: LEGACY_RESIDENTIAL_CONTENT_HASH },
    };
  },
  async migrateBatch(context) {
    if (!context.checkpoint) await ensureFormDefinitionIndexes(context.db);
    const residentialIds = await resolveResidentialPurposeCategoryIds(context.db);
    const types = await context.db.collection('property_types')
      .find({ ...afterCheckpoint(context.checkpoint), purposeCategoryId: { $in: residentialIds } }, { projection: { _id: 1 } })
      .sort({ _id: 1 }).limit(context.batchSize).toArray();
    if (!types.length) return { scanned: 0, modified: 0, done: true };
    const now = new Date();
    let modified = 0;
    for (const type of types) {
      const outcome = await seedLegacyDefinition(context.db, type._id as ObjectId, now);
      modified += Number(outcome.headInserted) + Number(outcome.versionInserted);
    }
    return { scanned: types.length, modified, checkpoint: String(types[types.length - 1]._id), done: types.length < context.batchSize };
  },
  async validate({ db }) {
    const scanResult = await scanLegacyDefinitions(db);
    const valid = scanResult.withoutHead === 0 && scanResult.seededHeadsMissingVersion === 0 && scanResult.invalidSeededVersions.length === 0 && scanResult.invalidNonResidentialLegacy.length === 0;
    return {
      valid,
      errors: valid ? [] : [
        ...(scanResult.withoutHead || scanResult.seededHeadsMissingVersion || scanResult.invalidSeededVersions.length
          ? [{ code: 'LEGACY_FORM_DEFINITIONS_INCOMPLETE', message: `${scanResult.withoutHead} residential types without a head, ${scanResult.seededHeadsMissingVersion} seeded heads without their version, ${scanResult.invalidSeededVersions.length} mismatched versions` }]
          : []),
        ...(scanResult.invalidNonResidentialLegacy.length
          ? [{ code: 'LEGACY_FORM_DEFINITION_INVALID_PURPOSE', message: `${scanResult.invalidNonResidentialLegacy.length} non-residential property types incorrectly carry a seeded legacy-residential form: ${scanResult.invalidNonResidentialLegacy.join(', ')}` }]
          : []),
      ],
      summary: scanResult,
    };
  },
};

/**
 * M-C (DPF-014): report only. Run it as a dry-run
 * (`--dry-run --migration=027-legacy-property-data-report`) whenever the
 * report is needed; it writes nothing and never runs in a full apply.
 */
export const legacyPropertyDataReportMigration: MigrationDefinition = {
  id: '027-legacy-property-data-report',
  version: 1,
  description: 'DPF-014 M-C: legacy property data report for product decision PD-2 (read-only; the report is the preflight summary)',
  manualOnly: true,
  rollback: { kind: 'automatic', instructions: 'Nothing to roll back: the report writes no data.' },
  async preflight({ db }) {
    return { eligible: 0, alreadyApplied: 0, blockers: [], summary: await buildLegacyPropertyDataReport(db) };
  },
  async migrateBatch() {
    return { scanned: 0, modified: 0, done: true };
  },
  async validate() {
    return { valid: true, errors: [] };
  },
};

/** M-D (DPF-014): Property.area from the current public revision, only where they differ. */
export const propertyAreaBackfillMigration: MigrationDefinition = {
  id: '028-property-area-backfill',
  version: 1,
  description: 'DPF-014 M-D: set Property.area to its current public revision area where they differ; revisions are never written',
  dependencies: ['015-property-attribution-revisions'],
  rollback: {
    kind: 'none',
    remediation: 'The backfill only copies the approved revision area onto the aggregate (the same sync approval performs). Inspect migration_ledger before any reviewed repair.',
    restoreProcedure: 'Restore the verified pre-migration snapshot to a separate database and compare properties.area before any production remediation.',
  },
  async preflight({ db }) {
    const result = await scanAreaBackfill(db);
    return { eligible: result.differing, alreadyApplied: result.matching, blockers: [], summary: result };
  },
  async migrateBatch(context) {
    const properties = context.db.collection('properties');
    const batch = await properties.find({ currentPublicRevisionId: { $exists: true }, ...afterCheckpoint(context.checkpoint) }, { projection: { area: 1, currentPublicRevisionId: 1 } })
      .sort({ _id: 1 }).limit(context.batchSize).toArray();
    if (!batch.length) return { scanned: 0, modified: 0, done: true };
    let modified = 0;
    for (const { property, revision } of await pairWithPublicRevisions(context.db, batch)) {
      if (areaOutcome(property, revision) !== 'differing') continue;
      // Guarded: skip a row whose public revision or area changed since it was read.
      const result = await properties.updateOne(
        { _id: property._id, currentPublicRevisionId: property.currentPublicRevisionId, area: property.area ?? null },
        { $set: { area: revision!.area } },
      );
      modified += result.modifiedCount;
    }
    return { scanned: batch.length, modified, checkpoint: String(batch[batch.length - 1]._id), done: batch.length < context.batchSize };
  },
  async validate({ db }) {
    const result = await scanAreaBackfill(db);
    return {
      valid: result.differing === 0,
      errors: result.differing ? [{ code: 'PROPERTY_AREA_BACKFILL_INCOMPLETE', message: `${result.differing} properties still differ from their public revision area` }] : [],
      summary: result,
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
  propertyLifecycleMigration,
  managedMarketingRequestIndexesMigration,
  cityCatalogIndexesMigration,
  propertyTypeSelectionBackfillMigration,
  propertyTypeListingIndexesMigration,
  retirePurposeListingIndexMigration,
  propertyAttributeRegistryMigration,
  legacyPropertyFormDefinitionsMigration,
  legacyPropertyDataReportMigration,
  propertyAreaBackfillMigration,
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
