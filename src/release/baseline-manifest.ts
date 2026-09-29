/**
 * Release baseline manifest (Phase 13).
 *
 * A deterministic, environment-independent description of the Dynamic Property
 * System baseline: the catalogs it needs (referenced only by stable codes,
 * never ObjectIds), the 19 published FormDefinitions (canonical content plus
 * its contentHash) and the hashes of the shipped media profiles. The manifest
 * is generated from a verified environment and checked in; `verify` compares
 * any database against it and reports, per item, one of:
 *   match | missing | diverge | drift (display-only) | extra | invalid
 * Nothing here writes to a database.
 */
import type { Db } from 'mongodb';
import { canonicalize, sha256 } from '../common/idempotency/idempotency.service';
import { FROZEN_MEDIA_PROFILE_HASHES, mediaProfileDefinitionHash } from '../properties/media-profiles';
import { computeFormContentHash, type FormVersionContent } from '../property-form-definitions/property-form-definition.constants';
import { storedContent } from '../property-form-definitions/form-definition-drafts';

export const MANIFEST_VERSION = 1;

type Row = Record<string, unknown>;

/** Fields that never describe the baseline: identity, audit, counters. */
const VOLATILE = ['_id', '__v', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'usageCount', 'version'];

export type CatalogName = 'purposes' | 'propertyTypes' | 'attributes' | 'amenities' | 'propertyOptions' | 'governorates' | 'cities';

type CatalogSpec = {
  collection: string;
  /** Stable code identifying an entry. */
  identity: (row: Row) => string;
  /** Fields an Admin may legitimately retune later: reported as drift, never as divergence. */
  display: string[];
};

const CATALOGS: Record<CatalogName, CatalogSpec> = {
  purposes: { collection: 'property_purpose_categories', identity: (row) => String(row.code), display: ['nameAr', 'nameEn', 'descriptionAr', 'sortOrder', 'isActive'] },
  propertyTypes: { collection: 'property_types', identity: (row) => String(row.code), display: ['nameAr', 'nameEn', 'iconKey', 'sortOrder', 'isActive'] },
  attributes: { collection: 'property_attributes', identity: (row) => String(row.key), display: ['labelAr', 'labelEn', 'helpAr', 'helpEn', 'sortOrder', 'status'] },
  amenities: { collection: 'amenities', identity: (row) => String(row.code), display: ['nameAr', 'nameEn', 'iconKey', 'sortOrder', 'isActive'] },
  propertyOptions: { collection: 'property_options', identity: (row) => `${row.group}:${row.code}`, display: ['nameAr', 'nameEn', 'descriptionAr', 'iconKey', 'sortOrder', 'isActive', 'isDefault'] },
  governorates: { collection: 'governorates', identity: (row) => String(row.code), display: ['nameAr', 'nameEn', 'iconKey', 'sortOrder', 'isActive', 'mapViewport'] },
  cities: { collection: 'cities', identity: (row) => `${row.governorateCode}:${row.code}`, display: ['nameAr', 'nameEn', 'sortOrder', 'isActive'] },
};
export const CATALOG_NAMES = Object.keys(CATALOGS) as CatalogName[];

export type CatalogEntry = { id: string; strict: Row; display: Row };
export type ManifestForm = { propertyTypeCode: string; contentHash: string; content: FormVersionContent };
export type BaselineManifest = {
  manifestVersion: number;
  releaseId: string;
  mediaProfiles: Record<string, string>;
  catalogs: Record<CatalogName, CatalogEntry[]>;
  forms: ManifestForm[];
  manifestHash: string;
};

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function toEntry(name: CatalogName, row: Row): CatalogEntry {
  const spec = CATALOGS[name];
  const strict: Row = {};
  const display: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (VOLATILE.includes(key) || value === undefined) continue;
    (spec.display.includes(key) ? display : strict)[key] = value;
  }
  return { id: spec.identity(row), strict, display };
}

/** References are expressed as stable codes so the manifest carries no ObjectId. */
async function readCatalog(db: Db, name: CatalogName): Promise<CatalogEntry[]> {
  const spec = CATALOGS[name];
  const rows = (await db.collection(spec.collection).find({}).toArray()) as Row[];
  let resolved: Row[] = rows;
  if (name === 'propertyTypes') {
    const purposes = new Map((await db.collection(CATALOGS.purposes.collection).find({}).toArray()).map((row) => [String(row._id), row.code]));
    resolved = rows.map(({ purposeCategoryId, ...rest }) => ({ ...rest, purposeCode: purposes.get(String(purposeCategoryId)) ?? null }));
  }
  if (name === 'cities') {
    const governorates = new Map((await db.collection(CATALOGS.governorates.collection).find({}).toArray()).map((row) => [String(row._id), row.code]));
    resolved = rows.map(({ governorateId, ...rest }) => ({ ...rest, governorateCode: governorates.get(String(governorateId)) ?? null }));
  }
  return resolved.map((row) => toEntry(name, row)).sort(byId);
}

export type LiveForm = { propertyTypeCode: string; contentHash: string; storedContentHash?: string; content: FormVersionContent };

/** The current published form of every property type, keyed by type code. Types without one are simply absent. */
export async function readLiveForms(db: Db): Promise<Map<string, LiveForm>> {
  const [types, heads] = await Promise.all([
    db.collection('property_types').find({}).toArray(),
    db.collection('property_form_definitions').find({ currentVersionId: { $exists: true } }).toArray(),
  ]);
  const typeById = new Map(types.map((row) => [String(row._id), row]));
  const versions = await db.collection('property_form_definition_versions').find({ _id: { $in: heads.map((head) => head.currentVersionId) } }).toArray();
  const versionById = new Map(versions.map((row) => [String(row._id), row]));
  const live = new Map<string, LiveForm>();
  for (const head of heads) {
    const type = typeById.get(String(head.purposeSubcategoryId));
    const version = versionById.get(String(head.currentVersionId));
    if (!type?.code || !version || version.state !== 'published' || head.status !== 'active') continue;
    const content = storedContent(version as never);
    live.set(String(type.code), { propertyTypeCode: String(type.code), contentHash: computeFormContentHash(content), storedContentHash: version.contentHash as string | undefined, content });
  }
  return live;
}

export function currentMediaProfileHashes(): Record<string, string> {
  return Object.fromEntries(Object.keys(FROZEN_MEDIA_PROFILE_HASHES).sort().map((key) => [key, mediaProfileDefinitionHash(key as never)]));
}

export function manifestHashOf(manifest: Omit<BaselineManifest, 'manifestHash'>): string {
  return sha256(canonicalize(manifest));
}

/** Builds a manifest from a database. Read-only. Throws if a form is incomplete or its stored hash is wrong. */
export async function buildManifest(db: Db, releaseId: string): Promise<BaselineManifest> {
  const catalogs = {} as Record<CatalogName, CatalogEntry[]>;
  for (const name of CATALOG_NAMES) catalogs[name] = await readCatalog(db, name);
  const live = await readLiveForms(db);
  const forms: ManifestForm[] = [];
  for (const type of catalogs.propertyTypes) {
    const form = live.get(type.id);
    if (!form) throw new Error(`Property type ${type.id} has no current published form`);
    if (form.storedContentHash !== form.contentHash) throw new Error(`Stored contentHash of ${type.id} does not match its content`);
    forms.push({ propertyTypeCode: type.id, contentHash: form.contentHash, content: form.content });
  }
  const body = { manifestVersion: MANIFEST_VERSION, releaseId, mediaProfiles: currentMediaProfileHashes(), catalogs, forms };
  return { ...body, manifestHash: manifestHashOf(body) };
}

export type Verdict = 'match' | 'missing' | 'diverge' | 'drift' | 'extra' | 'invalid';
export type VerifyItem = { area: string; id: string; verdict: Verdict; detail?: string };
export type VerifyReport = {
  ok: boolean;
  manifestHash: string;
  counts: Record<Verdict, number>;
  items: VerifyItem[];
};

/** Self-consistency of the manifest file: the hash, every form hash, the frozen media profile hashes. */
export function manifestIntegrityProblems(manifest: BaselineManifest): string[] {
  const problems: string[] = [];
  const { manifestHash, ...body } = manifest;
  if (manifest.manifestVersion !== MANIFEST_VERSION) problems.push(`unsupported manifestVersion ${manifest.manifestVersion}`);
  if (manifestHashOf(body) !== manifestHash) problems.push('manifestHash does not match the manifest content');
  for (const form of manifest.forms) {
    if (computeFormContentHash(form.content) !== form.contentHash) problems.push(`form ${form.propertyTypeCode}: contentHash does not match its content`);
  }
  const typeCodes = manifest.catalogs.propertyTypes.map((entry) => entry.id);
  if (new Set(manifest.forms.map((form) => form.propertyTypeCode)).size !== manifest.forms.length) problems.push('duplicate form entries');
  for (const code of typeCodes) if (!manifest.forms.some((form) => form.propertyTypeCode === code)) problems.push(`property type ${code} has no form in the manifest`);
  for (const form of manifest.forms) if (!typeCodes.includes(form.propertyTypeCode)) problems.push(`form for unknown property type ${form.propertyTypeCode}`);
  for (const [profile, hash] of Object.entries(manifest.mediaProfiles)) {
    if (FROZEN_MEDIA_PROFILE_HASHES[profile] !== hash) problems.push(`media profile ${profile}: manifest hash differs from the frozen code hash`);
  }
  for (const form of manifest.forms) if (!(form.content.mediaProfile in manifest.mediaProfiles)) problems.push(`form ${form.propertyTypeCode} uses media profile ${form.content.mediaProfile} which the manifest does not pin`);
  return problems;
}

function tally(items: VerifyItem[]): Record<Verdict, number> {
  const counts: Record<Verdict, number> = { match: 0, missing: 0, diverge: 0, drift: 0, extra: 0, invalid: 0 };
  for (const item of items) counts[item.verdict] += 1;
  return counts;
}

/**
 * Compares a database with the manifest. `ok` is false on any missing,
 * divergent or invalid item; drift (display-only) and extra live rows are
 * reported but do not fail, because Admins may retune display text and add
 * their own catalog rows.
 */
export async function verifyAgainstManifest(db: Db, manifest: BaselineManifest): Promise<VerifyReport> {
  const items: VerifyItem[] = [];
  for (const problem of manifestIntegrityProblems(manifest)) items.push({ area: 'manifest', id: 'self', verdict: 'invalid', detail: problem });

  for (const [profile, expected] of Object.entries(manifest.mediaProfiles)) {
    const actual = currentMediaProfileHashes()[profile];
    items.push({ area: 'mediaProfile', id: profile, verdict: actual === expected ? 'match' : 'diverge', ...(actual === expected ? {} : { detail: 'the running code defines this profile differently from the release' }) });
  }

  for (const name of CATALOG_NAMES) {
    const live = new Map((await readCatalog(db, name)).map((entry) => [entry.id, entry]));
    for (const expected of manifest.catalogs[name]) {
      const found = live.get(expected.id);
      if (!found) items.push({ area: name, id: expected.id, verdict: 'missing' });
      else if (canonicalize(found.strict) !== canonicalize(expected.strict)) items.push({ area: name, id: expected.id, verdict: 'diverge', detail: 'structural fields differ' });
      else if (canonicalize(found.display) !== canonicalize(expected.display)) items.push({ area: name, id: expected.id, verdict: 'drift', detail: 'display fields differ' });
      else items.push({ area: name, id: expected.id, verdict: 'match' });
      live.delete(expected.id);
    }
    for (const id of live.keys()) items.push({ area: name, id, verdict: 'extra' });
  }

  const liveForms = await readLiveForms(db);
  for (const form of manifest.forms) {
    const found = liveForms.get(form.propertyTypeCode);
    if (!found) items.push({ area: 'forms', id: form.propertyTypeCode, verdict: 'missing', detail: 'no active current published version' });
    else if (found.storedContentHash !== found.contentHash) items.push({ area: 'forms', id: form.propertyTypeCode, verdict: 'invalid', detail: 'stored contentHash does not match the stored content' });
    else if (found.contentHash !== form.contentHash) items.push({ area: 'forms', id: form.propertyTypeCode, verdict: 'diverge', detail: `live ${found.contentHash.slice(0, 12)} != release ${form.contentHash.slice(0, 12)}` });
    else items.push({ area: 'forms', id: form.propertyTypeCode, verdict: 'match' });
    liveForms.delete(form.propertyTypeCode);
  }
  for (const code of liveForms.keys()) items.push({ area: 'forms', id: code, verdict: 'extra' });

  const counts = tally(items);
  return { ok: counts.missing + counts.diverge + counts.invalid === 0, manifestHash: manifest.manifestHash, counts, items };
}
