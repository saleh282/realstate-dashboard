import { ObjectId, type Collection, type Db, type Document } from 'mongodb';
import {
  LEGACY_PROPERTY_ATTRIBUTE_SEED,
  LEGACY_SPEC_FIELDS,
  type PropertyAttributeSeed,
} from '../property-attributes/property-attribute.constants';
import { PropertyAttributeSchema } from '../property-attributes/schemas/property-attribute.schema';
import {
  LEGACY_RESIDENTIAL_CONTENT,
  LEGACY_RESIDENTIAL_CONTENT_HASH,
  computeFormContentHash,
  computeLegacyWritable,
} from '../property-form-definitions/property-form-definition.constants';
import { PropertyFormDefinitionSchema } from '../property-form-definitions/schemas/property-form-definition.schema';
import { PropertyFormDefinitionVersionSchema } from '../property-form-definitions/schemas/property-form-definition-version.schema';
import { scanPropertyTypeSelection } from './022-property-type-selection';

/**
 * Dynamic Property Form foundation data (DPF-013/014):
 *   M-A registry seed, M-B legacy definitions, M-C legacy report, M-D area backfill.
 * None of them writes PropertyRevision documents.
 */

export const ATTRIBUTES = 'property_attributes';
export const DEFINITIONS = 'property_form_definitions';
export const VERSIONS = 'property_form_definition_versions';
export const PURPOSE_CATEGORIES = 'property_purpose_categories';
/** The legacy residential form (M-B) may only ever attach to this purpose. */
export const RESIDENTIAL_PURPOSE_CODE = 'residential';
const SCAN_BATCH = 1000;

/** Pages through a collection by `_id` (no cursor state survives between pages). */
export async function* scan(collection: Collection, filter: Document = {}, projection?: Document): AsyncGenerator<Document> {
  let last: ObjectId | undefined;
  while (true) {
    const page = await collection
      .find({ ...filter, ...(last ? { _id: { $gt: last } } : {}) }, projection ? { projection } : undefined)
      .sort({ _id: 1 })
      .limit(SCAN_BATCH)
      .toArray();
    for (const document of page) yield document;
    if (page.length < SCAN_BATCH) return;
    last = page[page.length - 1]._id as ObjectId;
  }
}

/** The schema-declared indexes, created by the migration so uniqueness holds before the app first starts. */
export async function ensureSchemaIndexes(db: Db, collectionName: string, schema: { indexes(): Array<[Record<string, unknown>, Record<string, unknown>?]> }) {
  for (const [key, options] of schema.indexes()) {
    const { background: _background, ...rest } = options ?? {};
    await db.collection(collectionName).createIndex(key as Document, rest);
  }
}

// ---------------------------------------------------------------- M-A registry seed

const IDENTITY_FIELDS = ['dataType', 'unit', 'optionSource', 'catalogGroup', 'facetKey', 'origin'] as const;

export function registryDocument(seed: PropertyAttributeSeed, now: Date): Document {
  return {
    key: seed.key,
    dataType: seed.dataType,
    ...(seed.unit ? { unit: seed.unit } : {}),
    labelAr: seed.labelAr,
    ...(seed.labelEn ? { labelEn: seed.labelEn } : {}),
    hardBounds: { ...seed.hardBounds },
    ...(seed.optionSource ? { optionSource: seed.optionSource } : {}),
    ...(seed.catalogGroup ? { catalogGroup: seed.catalogGroup } : {}),
    ...(seed.facetKey ? { facetKey: seed.facetKey } : {}),
    status: 'active',
    origin: 'system',
    createdAt: now,
    updatedAt: now,
  };
}

/** Seed keys that are missing, already present with the same identity, or present with a different identity. */
export async function scanRegistrySeed(db: Db) {
  const existing = await db.collection(ATTRIBUTES).find({ key: { $in: LEGACY_PROPERTY_ATTRIBUTE_SEED.map((seed) => seed.key) } }).toArray();
  const byKey = new Map(existing.map((document) => [document.key as string, document]));
  const missing: string[] = [];
  const matching: string[] = [];
  const conflicting: string[] = [];
  for (const seed of LEGACY_PROPERTY_ATTRIBUTE_SEED) {
    const stored = byKey.get(seed.key);
    if (!stored) missing.push(seed.key);
    else if (IDENTITY_FIELDS.every((field) => (stored[field] ?? null) === ((registryDocument(seed, new Date()) as any)[field] ?? null))) matching.push(seed.key);
    else conflicting.push(seed.key);
  }
  const inactive = existing.filter((document) => document.status !== 'active').map((document) => document.key as string);
  return { missing, matching, conflicting, inactive };
}

export async function seedRegistry(db: Db, now: Date): Promise<number> {
  await ensureSchemaIndexes(db, ATTRIBUTES, PropertyAttributeSchema);
  let inserted = 0;
  for (const seed of LEGACY_PROPERTY_ATTRIBUTE_SEED) {
    // Insert-only: an existing key is never modified (identity is immutable).
    const result = await db.collection(ATTRIBUTES).updateOne({ key: seed.key }, { $setOnInsert: registryDocument(seed, now) }, { upsert: true });
    inserted += result.upsertedCount ?? 0;
  }
  return inserted;
}

// ---------------------------------------------------------------- M-B legacy definitions

/** A head created by M-B: no Admin author, exactly one published version so far. */
export function isSeededLegacyHead(head: Document): boolean {
  return !head.createdBy && head.currentVersion === 1 && head.nextVersionNumber === 2 && head.version === 1 && Boolean(head.currentVersionId);
}

export function legacyVersionDocument(versionId: ObjectId, definitionId: ObjectId, purposeSubcategoryId: ObjectId, now: Date): Document {
  return {
    _id: versionId,
    definitionId,
    purposeSubcategoryId,
    version: 1,
    state: 'published',
    fields: LEGACY_RESIDENTIAL_CONTENT.fields.map((field) => ({ ...field })),
    mediaProfile: LEGACY_RESIDENTIAL_CONTENT.mediaProfile,
    amenitiesEnabled: LEGACY_RESIDENTIAL_CONTENT.amenitiesEnabled,
    changeNote: 'Legacy residential form (seeded by migration 026)',
    draftRevision: 0,
    rendererVersion: LEGACY_RESIDENTIAL_CONTENT.rendererVersion,
    legacyWritable: computeLegacyWritable(LEGACY_RESIDENTIAL_CONTENT),
    contentHash: LEGACY_RESIDENTIAL_CONTENT_HASH,
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

/** Recomputes a stored version's hash from its own stored content. */
export function storedContentHash(version: Document): string {
  return computeFormContentHash({ rendererVersion: version.rendererVersion, fields: version.fields, mediaProfile: version.mediaProfile, amenitiesEnabled: version.amenitiesEnabled });
}

/**
 * Resolves residential eligibility through the actual purpose relationship
 * (never by type name/code): the ids of every `property_purpose_categories`
 * document whose `code` is exactly `residential`.
 */
export async function resolveResidentialPurposeCategoryIds(db: Db): Promise<ObjectId[]> {
  const purposes = await db.collection(PURPOSE_CATEGORIES).find({ code: RESIDENTIAL_PURPOSE_CODE }, { projection: { _id: 1 } }).toArray();
  return purposes.map((purpose) => purpose._id as ObjectId);
}

export type LegacyDefinitionsScan = {
  types: number;
  residentialTypes: number;
  withoutHead: number;
  seededHeadsMissingVersion: number;
  invalidSeededVersions: string[];
  /** BUG GUARD (never expected): a non-residential type carrying a seeded legacy-residential head. */
  invalidNonResidentialLegacy: string[];
};

/**
 * The legacy residential form is RESIDENTIAL ONLY: a property type is only
 * ever eligible when its `purposeCategoryId` resolves to the `residential`
 * purpose. Non-residential types are left alone even when they have no head
 * at all; an Admin-authored head (on any purpose) is never touched or judged.
 */
export async function scanLegacyDefinitions(db: Db): Promise<LegacyDefinitionsScan> {
  const residentialIds = new Set((await resolveResidentialPurposeCategoryIds(db)).map((id) => String(id)));
  let types = 0;
  let residentialTypes = 0;
  let withoutHead = 0;
  let seededHeadsMissingVersion = 0;
  const invalidSeededVersions: string[] = [];
  const invalidNonResidentialLegacy: string[] = [];
  const definitions = db.collection(DEFINITIONS);
  const versions = db.collection(VERSIONS);
  for await (const type of scan(db.collection('property_types'), {}, { _id: 1, purposeCategoryId: 1 })) {
    types += 1;
    const isResidential = type.purposeCategoryId != null && residentialIds.has(String(type.purposeCategoryId));
    if (isResidential) residentialTypes += 1;
    const head = await definitions.findOne({ purposeSubcategoryId: type._id });
    if (!head) { if (isResidential) withoutHead += 1; continue; }
    if (!isSeededLegacyHead(head)) continue;
    if (!isResidential) { invalidNonResidentialLegacy.push(String(type._id)); continue; }
    const version = await versions.findOne({ _id: head.currentVersionId });
    if (!version) seededHeadsMissingVersion += 1;
    else if (version.state !== 'published' || version.contentHash !== LEGACY_RESIDENTIAL_CONTENT_HASH || storedContentHash(version) !== LEGACY_RESIDENTIAL_CONTENT_HASH) invalidSeededVersions.push(String(version._id));
  }
  return { types, residentialTypes, withoutHead, seededHeadsMissingVersion, invalidSeededVersions, invalidNonResidentialLegacy };
}

/**
 * Creates head + published legacy v1 for one property type if it has no head.
 * The head is written first with pre-assigned ids, so an interrupted run leaves
 * a seeded head whose version is missing, which the next run repairs with the
 * same ids; nothing is ever orphaned. Callers must only pass residential-purpose
 * type ids (see `resolveResidentialPurposeCategoryIds`) — this function itself
 * does not re-check purpose, so it stays a plain per-id repair primitive.
 */
export async function seedLegacyDefinition(db: Db, purposeSubcategoryId: ObjectId, now: Date): Promise<{ headInserted: boolean; versionInserted: boolean }> {
  const definitions = db.collection(DEFINITIONS);
  const versions = db.collection(VERSIONS);
  let headInserted = false;
  let head = await definitions.findOne({ purposeSubcategoryId });
  if (!head) {
    const candidate = { _id: new ObjectId(), purposeSubcategoryId, status: 'active', currentVersionId: new ObjectId(), currentVersion: 1, nextVersionNumber: 2, version: 1, createdAt: now, updatedAt: now };
    const result = await definitions.updateOne({ purposeSubcategoryId }, { $setOnInsert: candidate }, { upsert: true });
    headInserted = Boolean(result.upsertedCount);
    head = await definitions.findOne({ purposeSubcategoryId });
  }
  if (!head || !isSeededLegacyHead(head)) return { headInserted, versionInserted: false };
  const versionId = head.currentVersionId as ObjectId;
  const result = await versions.updateOne({ _id: versionId }, { $setOnInsert: legacyVersionDocument(versionId, head._id as ObjectId, purposeSubcategoryId, now) }, { upsert: true });
  return { headInserted, versionInserted: Boolean(result.upsertedCount) };
}

export async function ensureFormDefinitionIndexes(db: Db) {
  await ensureSchemaIndexes(db, DEFINITIONS, PropertyFormDefinitionSchema);
  await ensureSchemaIndexes(db, VERSIONS, PropertyFormDefinitionVersionSchema);
}

// ---------------------------------------------------------------- M-C legacy data report

type Stats = { count: number; min: number | null; max: number | null; mode: number | null; missing: number; frequencies: Map<number, number> };
const ROOM_FIELDS = ['bedrooms', 'livingRooms', 'kitchens', 'bathrooms'] as const;
const DISTRIBUTION_FIELDS = ['bedrooms', 'livingRooms', 'kitchens', 'bathrooms', 'buildingYear', 'floor', 'totalFloors'] as const;
const newStats = (): Stats => ({ count: 0, min: null, max: null, mode: null, missing: 0, frequencies: new Map() });
function observe(stats: Stats, value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) { stats.missing += 1; return; }
  stats.count += 1;
  stats.min = stats.min === null ? value : Math.min(stats.min, value);
  stats.max = stats.max === null ? value : Math.max(stats.max, value);
  stats.frequencies.set(value, (stats.frequencies.get(value) ?? 0) + 1);
}
/** Mode ties resolve to the smallest value, so the report is deterministic. */
function summarize(stats: Stats) {
  let mode: number | null = null;
  let best = -1;
  for (const [value, frequency] of stats.frequencies) if (frequency > best || (frequency === best && value < (mode as number))) { mode = value; best = frequency; }
  return { count: stats.count, missing: stats.missing, min: stats.min, max: stats.max, mode, modeCount: best < 0 ? 0 : best };
}
const idKey = (value: unknown) => (value === undefined || value === null ? null : String(value));
const isValidArea = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 1;
const pinned = (revision: Document) => Boolean(revision.formDefinitionVersionId);

/**
 * Frozen §H9 (+ multi-type amendment §12) legacy-data report. Read-only:
 * evidence for product decision PD-2, never a correction. Historical room
 * values are counted, not judged.
 */
export async function buildLegacyPropertyDataReport(db: Db) {
  const [types, purposes, catalog] = await Promise.all([
    db.collection('property_types').find({}, { projection: { code: 1, nameAr: 1, purposeCategoryId: 1, isActive: 1 } }).toArray(),
    db.collection('property_purpose_categories').find({}, { projection: { code: 1, nameAr: 1 } }).toArray(),
    db.collection('property_options').find({ group: { $in: ['finishing_status', 'delivery_status'] } }, { projection: { group: 1, code: 1, isActive: 1 } }).toArray(),
  ]);
  const typeById = new Map(types.map((type) => [String(type._id), type]));
  const purposeById = new Map(purposes.map((purpose) => [String(purpose._id), purpose]));
  const catalogState = new Map(catalog.map((option) => [`${option.group}:${option.code}`, option.isActive !== false]));
  const describeType = (purposeSubcategoryId: unknown, legacyCode?: unknown) => {
    const type = typeById.get(String(purposeSubcategoryId));
    return { purposeSubcategoryId: idKey(purposeSubcategoryId), typeCode: type?.code ?? (legacyCode as string | undefined) ?? null, typeNameAr: type?.nameAr ?? null };
  };
  const describePurpose = (purposeCategoryId: unknown) => {
    const purpose = purposeById.get(String(purposeCategoryId));
    return { purposeCategoryId: idKey(purposeCategoryId), purposeCode: purpose?.code ?? null, purposeNameAr: purpose?.nameAr ?? null };
  };

  // Properties first: which revisions are current-public, and property-level facts.
  const publicRevisionOf = new Map<string, string>();
  const propertyRows: Document[] = [];
  let propertiesAreaZeroOrMissing = 0;
  for await (const property of scan(db.collection('properties'), {}, { status: 1, purposeCategoryId: 1, purposeSubcategoryId: 1, propertyTypeCode: 1, currentPublicRevisionId: 1, area: 1 })) {
    propertyRows.push(property);
    if (property.currentPublicRevisionId) publicRevisionOf.set(String(property._id), String(property.currentPublicRevisionId));
    if (!isValidArea(property.area)) propertiesAreaZeroOrMissing += 1;
  }
  const publicRevisionIds = new Set(publicRevisionOf.values());

  const revisionsByGroup = new Map<string, Document>();
  const distributions = new Map<string, { type: ReturnType<typeof describeType>; revisions: number; allRoomCountsOne: number; stats: Record<string, Stats> }>();
  const catalogIssues = new Map<string, { field: string; code: string; state: 'missing' | 'inactive'; revisions: number }>();
  const publicRevisionFacts = new Map<string, { area: unknown; pinned: boolean }>();
  let revisionsTotal = 0;
  let revisionsPinned = 0;
  let revisionsMissingPurposeSubcategoryId = 0;
  let revisionsAreaZeroOrMissing = 0;
  let revisionsFloorAboveTotalFloors = 0;
  let revisionsMissingFinishing = 0;
  let revisionsMissingDelivery = 0;
  const projection = Object.fromEntries(['propertyId', 'moderationStatus', 'purposeCategoryId', 'purposeSubcategoryId', 'legacyPropertyTypeCode', 'formDefinitionVersionId', 'area', ...LEGACY_SPEC_FIELDS].map((field) => [field, 1]));
  for await (const revision of scan(db.collection('property_revisions'), {}, projection)) {
    revisionsTotal += 1;
    if (publicRevisionIds.has(String(revision._id))) publicRevisionFacts.set(String(revision._id), { area: revision.area, pinned: pinned(revision) });
    if (!isValidArea(revision.area)) revisionsAreaZeroOrMissing += 1;
    if (revision.purposeSubcategoryId === undefined || revision.purposeSubcategoryId === null) revisionsMissingPurposeSubcategoryId += 1;
    if (pinned(revision)) { revisionsPinned += 1; continue; }

    const type = describeType(revision.purposeSubcategoryId, revision.legacyPropertyTypeCode);
    const group = { ...describePurpose(revision.purposeCategoryId), ...type, moderationStatus: revision.moderationStatus ?? null };
    const groupKey = JSON.stringify(group);
    const counted = revisionsByGroup.get(groupKey) ?? { ...group, count: 0 };
    counted.count += 1;
    revisionsByGroup.set(groupKey, counted);

    const distributionKey = `${type.purposeSubcategoryId ?? ''}|${type.typeCode ?? ''}`;
    const distribution = distributions.get(distributionKey) ?? { type, revisions: 0, allRoomCountsOne: 0, stats: Object.fromEntries(DISTRIBUTION_FIELDS.map((field) => [field, newStats()])) };
    distribution.revisions += 1;
    for (const field of DISTRIBUTION_FIELDS) observe(distribution.stats[field], revision[field]);
    if (ROOM_FIELDS.every((field) => revision[field] === 1)) distribution.allRoomCountsOne += 1;
    distributions.set(distributionKey, distribution);

    if (typeof revision.floor === 'number' && typeof revision.totalFloors === 'number' && revision.floor > revision.totalFloors) revisionsFloorAboveTotalFloors += 1;
    for (const [field, group2] of [['finishingStatusCode', 'finishing_status'], ['deliveryStatusCode', 'delivery_status']] as const) {
      const code = revision[field];
      if (code === undefined || code === null || code === '') {
        if (field === 'finishingStatusCode') revisionsMissingFinishing += 1; else revisionsMissingDelivery += 1;
        continue;
      }
      const active = catalogState.get(`${group2}:${code}`);
      if (active === true) continue;
      const state = active === undefined ? 'missing' : 'inactive';
      const issueKey = `${field}:${code}`;
      const issue = catalogIssues.get(issueKey) ?? { field, code: String(code), state, revisions: 0 };
      issue.revisions += 1;
      catalogIssues.set(issueKey, issue);
    }
  }

  const propertiesByGroup = new Map<string, Document>();
  let propertiesWithoutPin = 0;
  let propertyAreaDiffersFromPublicRevision = 0;
  let propertiesWithDanglingPublicRevision = 0;
  for (const property of propertyRows) {
    const publicRevisionId = publicRevisionOf.get(String(property._id));
    const facts = publicRevisionId ? publicRevisionFacts.get(publicRevisionId) : undefined;
    if (publicRevisionId && !facts) propertiesWithDanglingPublicRevision += 1;
    if (facts && isValidArea(facts.area) && facts.area !== property.area) propertyAreaDiffersFromPublicRevision += 1;
    if (facts?.pinned) continue;
    propertiesWithoutPin += 1;
    const group = { ...describePurpose(property.purposeCategoryId), ...describeType(property.purposeSubcategoryId, property.propertyTypeCode), status: property.status ?? null };
    const groupKey = JSON.stringify(group);
    const counted = propertiesByGroup.get(groupKey) ?? { ...group, count: 0 };
    counted.count += 1;
    propertiesByGroup.set(groupKey, counted);
  }

  const liveAuctionPropertyIds = new Set((await db.collection('auctions').find({ status: { $in: ['scheduled', 'active'] } }, { projection: { propertyId: 1 } }).toArray()).map((auction) => String(auction.propertyId)));
  const approvedAnchoredByLiveAuctions = propertyRows.filter((property) => property.status === 'approved' && liveAuctionPropertyIds.has(String(property._id))).length;
  const multiType = await scanPropertyTypeSelection(db);
  const byCount = (a: Document, b: Document) => b.count - a.count || String(a.typeCode ?? '').localeCompare(String(b.typeCode ?? ''));

  return {
    reportVersion: 1,
    pins: {
      revisionsTotal,
      revisionsPinned,
      revisionsWithoutPin: revisionsTotal - revisionsPinned,
      revisionsWithoutPinByType: [...revisionsByGroup.values()].sort(byCount),
      propertiesTotal: propertyRows.length,
      propertiesWithoutPin,
      propertiesWithoutPinByType: [...propertiesByGroup.values()].sort(byCount),
    },
    roomDistributions: [...distributions.values()]
      .map((distribution) => ({
        ...distribution.type,
        revisions: distribution.revisions,
        allRoomCountsOne: distribution.allRoomCountsOne,
        allRoomCountsOneShare: distribution.revisions ? Number((distribution.allRoomCountsOne / distribution.revisions).toFixed(4)) : 0,
        fields: Object.fromEntries(DISTRIBUTION_FIELDS.map((field) => [field, summarize(distribution.stats[field])])),
      }))
      .sort((a, b) => b.revisions - a.revisions || String(a.typeCode ?? '').localeCompare(String(b.typeCode ?? ''))),
    auctions: { approvedListingsAnchoredByScheduledOrActiveAuctions: approvedAnchoredByLiveAuctions },
    classification: {
      revisionsMissingPurposeSubcategoryId,
      propertiesMissingPurposeSubcategoryId: multiType.report.propertiesMissingPurposeSubcategoryId,
      activeTypesWithoutPurposeCategoryId: multiType.report.activeTypesWithoutPurposeCategoryId,
      propertiesWithMultipleSelectedTypes: multiType.report.propertiesWithMultipleSelectedTypes,
      revisionsWithMultipleSelectedTypes: multiType.report.revisionsWithMultipleSelectedTypes,
      propertiesWithSelectionMissingPrimary: multiType.report.propertiesWithSelectionMissingPrimary,
    },
    area: { propertyAreaDiffersFromPublicRevision, propertiesAreaZeroOrMissing, revisionsAreaZeroOrMissing, propertiesWithDanglingPublicRevision },
    catalog: {
      revisionsMissingFinishingStatus: revisionsMissingFinishing,
      revisionsMissingDeliveryStatus: revisionsMissingDelivery,
      invalidCodes: [...catalogIssues.values()].sort((a, b) => a.field.localeCompare(b.field) || a.code.localeCompare(b.code)),
    },
    crossField: { revisionsFloorAboveTotalFloors },
  };
}

// ---------------------------------------------------------------- M-D Property.area backfill

export type AreaBackfillScan = { differing: number; matching: number; danglingPublicRevision: number; invalidRevisionArea: number; foreignRevision: number };

/** Compares each property's `area` with its current public revision's `area`. */
export async function scanAreaBackfill(db: Db): Promise<AreaBackfillScan> {
  const result: AreaBackfillScan = { differing: 0, matching: 0, danglingPublicRevision: 0, invalidRevisionArea: 0, foreignRevision: 0 };
  let page: Document[] = [];
  const flush = async () => {
    for (const { property, revision } of await pairWithPublicRevisions(db, page)) {
      const outcome = areaOutcome(property, revision);
      result[outcome] += 1;
    }
    page = [];
  };
  for await (const property of scan(db.collection('properties'), { currentPublicRevisionId: { $exists: true } }, { area: 1, currentPublicRevisionId: 1 })) {
    page.push(property);
    if (page.length === SCAN_BATCH) await flush();
  }
  await flush();
  return result;
}

export async function pairWithPublicRevisions(db: Db, properties: Document[]) {
  const ids = properties.map((property) => property.currentPublicRevisionId).filter(Boolean);
  const revisions = ids.length ? await db.collection('property_revisions').find({ _id: { $in: ids } }, { projection: { area: 1, propertyId: 1 } }).toArray() : [];
  const byId = new Map(revisions.map((revision) => [String(revision._id), revision]));
  return properties.map((property) => ({ property, revision: byId.get(String(property.currentPublicRevisionId)) }));
}

export function areaOutcome(property: Document, revision?: Document): keyof AreaBackfillScan {
  if (!revision) return 'danglingPublicRevision';
  if (String(revision.propertyId) !== String(property._id)) return 'foreignRevision';
  if (!isValidArea(revision.area)) return 'invalidRevisionArea';
  return revision.area === property.area ? 'matching' : 'differing';
}
