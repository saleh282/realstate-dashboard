'use strict';

const { canonicalize, sha256 } = require('../services/idempotency.service');
const {
  FROZEN_MEDIA_PROFILE_HASHES,
  mediaProfileDefinitionHash,
} = require('../domain/properties/media-profiles');
const {
  computeFormContentHash,
} = require('../domain/property-form-definitions/property-form-definition.constants');
const { storedContent } = require('../domain/property-form-definitions/form-definition-drafts');
const MANIFEST_VERSION = 1;
/** Fields that never describe the baseline: identity, audit, counters. */
const VOLATILE = [
  '_id',
  '__v',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
  'usageCount',
  'version',
];
const CATALOGS = {
  purposes: {
    collection: 'property_purpose_categories',
    identity: (row) => String(row.code),
    display: ['nameAr', 'nameEn', 'descriptionAr', 'sortOrder', 'isActive'],
  },
  propertyTypes: {
    collection: 'property_types',
    identity: (row) => String(row.code),
    display: ['nameAr', 'nameEn', 'iconKey', 'sortOrder', 'isActive'],
  },
  attributes: {
    collection: 'property_attributes',
    identity: (row) => String(row.key),
    display: ['labelAr', 'labelEn', 'helpAr', 'helpEn', 'sortOrder', 'status'],
  },
  amenities: {
    collection: 'amenities',
    identity: (row) => String(row.code),
    display: ['nameAr', 'nameEn', 'iconKey', 'sortOrder', 'isActive'],
  },
  propertyOptions: {
    collection: 'property_options',
    identity: (row) => `${row.group}:${row.code}`,
    display: ['nameAr', 'nameEn', 'descriptionAr', 'iconKey', 'sortOrder', 'isActive', 'isDefault'],
  },
  governorates: {
    collection: 'governorates',
    identity: (row) => String(row.code),
    display: ['nameAr', 'nameEn', 'iconKey', 'sortOrder', 'isActive', 'mapViewport'],
  },
  cities: {
    collection: 'cities',
    identity: (row) => `${row.governorateCode}:${row.code}`,
    display: ['nameAr', 'nameEn', 'sortOrder', 'isActive'],
  },
};
const CATALOG_NAMES = Object.keys(CATALOGS);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function toEntry(name, row) {
  const spec = CATALOGS[name];
  const strict = {};
  const display = {};
  for (const [key, value] of Object.entries(row)) {
    if (VOLATILE.includes(key) || value === undefined) continue;
    (spec.display.includes(key) ? display : strict)[key] = value;
  }
  return { id: spec.identity(row), strict, display };
}
/** References are expressed as stable codes so the manifest carries no ObjectId. */
async function readCatalog(db, name) {
  const spec = CATALOGS[name];
  const rows = await db.collection(spec.collection).find({}).toArray();
  let resolved = rows;
  if (name === 'propertyTypes') {
    const purposes = new Map(
      (await db.collection(CATALOGS.purposes.collection).find({}).toArray()).map((row) => [
        String(row._id),
        row.code,
      ]),
    );
    resolved = rows.map(({ purposeCategoryId, ...rest }) => ({
      ...rest,
      purposeCode: purposes.get(String(purposeCategoryId)) ?? null,
    }));
  }
  if (name === 'cities') {
    const governorates = new Map(
      (await db.collection(CATALOGS.governorates.collection).find({}).toArray()).map((row) => [
        String(row._id),
        row.code,
      ]),
    );
    resolved = rows.map(({ governorateId, ...rest }) => ({
      ...rest,
      governorateCode: governorates.get(String(governorateId)) ?? null,
    }));
  }
  return resolved.map((row) => toEntry(name, row)).sort(byId);
}
/** The current published form of every property type, keyed by type code. Types without one are simply absent. */
async function readLiveForms(db) {
  const [types, heads] = await Promise.all([
    db.collection('property_types').find({}).toArray(),
    db
      .collection('property_form_definitions')
      .find({ currentVersionId: { $exists: true } })
      .toArray(),
  ]);
  const typeById = new Map(types.map((row) => [String(row._id), row]));
  const versions = await db
    .collection('property_form_definition_versions')
    .find({ _id: { $in: heads.map((head) => head.currentVersionId) } })
    .toArray();
  const versionById = new Map(versions.map((row) => [String(row._id), row]));
  const live = new Map();
  for (const head of heads) {
    const type = typeById.get(String(head.purposeSubcategoryId));
    const version = versionById.get(String(head.currentVersionId));
    if (!type?.code || !version || version.state !== 'published' || head.status !== 'active')
      continue;
    const content = storedContent(version);
    live.set(String(type.code), {
      propertyTypeCode: String(type.code),
      contentHash: computeFormContentHash(content),
      storedContentHash: version.contentHash,
      content,
    });
  }
  return live;
}
function currentMediaProfileHashes() {
  return Object.fromEntries(
    Object.keys(FROZEN_MEDIA_PROFILE_HASHES)
      .sort()
      .map((key) => [key, mediaProfileDefinitionHash(key)]),
  );
}
function manifestHashOf(manifest) {
  return sha256(canonicalize(manifest));
}
/** Builds a manifest from a database. Read-only. Throws if a form is incomplete or its stored hash is wrong. */
async function buildManifest(db, releaseId) {
  const catalogs = {};
  for (const name of CATALOG_NAMES) catalogs[name] = await readCatalog(db, name);
  const live = await readLiveForms(db);
  const forms = [];
  for (const type of catalogs.propertyTypes) {
    const form = live.get(type.id);
    if (!form) throw new Error(`Property type ${type.id} has no current published form`);
    if (form.storedContentHash !== form.contentHash)
      throw new Error(`Stored contentHash of ${type.id} does not match its content`);
    forms.push({ propertyTypeCode: type.id, contentHash: form.contentHash, content: form.content });
  }
  const body = {
    manifestVersion: MANIFEST_VERSION,
    releaseId,
    mediaProfiles: currentMediaProfileHashes(),
    catalogs,
    forms,
  };
  return { ...body, manifestHash: manifestHashOf(body) };
}
/** Self-consistency of the manifest file: the hash, every form hash, the frozen media profile hashes. */
function manifestIntegrityProblems(manifest) {
  const problems = [];
  const { manifestHash, ...body } = manifest;
  if (manifest.manifestVersion !== MANIFEST_VERSION)
    problems.push(`unsupported manifestVersion ${manifest.manifestVersion}`);
  if (manifestHashOf(body) !== manifestHash)
    problems.push('manifestHash does not match the manifest content');
  for (const form of manifest.forms) {
    if (computeFormContentHash(form.content) !== form.contentHash)
      problems.push(`form ${form.propertyTypeCode}: contentHash does not match its content`);
  }
  const typeCodes = manifest.catalogs.propertyTypes.map((entry) => entry.id);
  if (new Set(manifest.forms.map((form) => form.propertyTypeCode)).size !== manifest.forms.length)
    problems.push('duplicate form entries');
  for (const code of typeCodes)
    if (!manifest.forms.some((form) => form.propertyTypeCode === code))
      problems.push(`property type ${code} has no form in the manifest`);
  for (const form of manifest.forms)
    if (!typeCodes.includes(form.propertyTypeCode))
      problems.push(`form for unknown property type ${form.propertyTypeCode}`);
  for (const [profile, hash] of Object.entries(manifest.mediaProfiles)) {
    if (FROZEN_MEDIA_PROFILE_HASHES[profile] !== hash)
      problems.push(`media profile ${profile}: manifest hash differs from the frozen code hash`);
  }
  for (const form of manifest.forms)
    if (!(form.content.mediaProfile in manifest.mediaProfiles))
      problems.push(
        `form ${form.propertyTypeCode} uses media profile ${form.content.mediaProfile} which the manifest does not pin`,
      );
  return problems;
}
function tally(items) {
  const counts = { match: 0, missing: 0, diverge: 0, drift: 0, extra: 0, invalid: 0 };
  for (const item of items) counts[item.verdict] += 1;
  return counts;
}
/**
 * Compares a database with the manifest. `ok` is false on any missing,
 * divergent or invalid item; drift (display-only) and extra live rows are
 * reported but do not fail, because Admins may retune display text and add
 * their own catalog rows.
 */
async function verifyAgainstManifest(db, manifest) {
  const items = [];
  for (const problem of manifestIntegrityProblems(manifest))
    items.push({ area: 'manifest', id: 'self', verdict: 'invalid', detail: problem });
  for (const [profile, expected] of Object.entries(manifest.mediaProfiles)) {
    const actual = currentMediaProfileHashes()[profile];
    items.push({
      area: 'mediaProfile',
      id: profile,
      verdict: actual === expected ? 'match' : 'diverge',
      ...(actual === expected
        ? {}
        : { detail: 'the running code defines this profile differently from the release' }),
    });
  }
  for (const name of CATALOG_NAMES) {
    const live = new Map((await readCatalog(db, name)).map((entry) => [entry.id, entry]));
    for (const expected of manifest.catalogs[name]) {
      const found = live.get(expected.id);
      if (!found) items.push({ area: name, id: expected.id, verdict: 'missing' });
      else if (canonicalize(found.strict) !== canonicalize(expected.strict))
        items.push({
          area: name,
          id: expected.id,
          verdict: 'diverge',
          detail: 'structural fields differ',
        });
      else if (canonicalize(found.display) !== canonicalize(expected.display))
        items.push({
          area: name,
          id: expected.id,
          verdict: 'drift',
          detail: 'display fields differ',
        });
      else items.push({ area: name, id: expected.id, verdict: 'match' });
      live.delete(expected.id);
    }
    for (const id of live.keys()) items.push({ area: name, id, verdict: 'extra' });
  }
  const liveForms = await readLiveForms(db);
  for (const form of manifest.forms) {
    const found = liveForms.get(form.propertyTypeCode);
    if (!found)
      items.push({
        area: 'forms',
        id: form.propertyTypeCode,
        verdict: 'missing',
        detail: 'no active current published version',
      });
    else if (found.storedContentHash !== found.contentHash)
      items.push({
        area: 'forms',
        id: form.propertyTypeCode,
        verdict: 'invalid',
        detail: 'stored contentHash does not match the stored content',
      });
    else if (found.contentHash !== form.contentHash)
      items.push({
        area: 'forms',
        id: form.propertyTypeCode,
        verdict: 'diverge',
        detail: `live ${found.contentHash.slice(0, 12)} != release ${form.contentHash.slice(0, 12)}`,
      });
    else items.push({ area: 'forms', id: form.propertyTypeCode, verdict: 'match' });
    liveForms.delete(form.propertyTypeCode);
  }
  for (const code of liveForms.keys()) items.push({ area: 'forms', id: code, verdict: 'extra' });
  const counts = tally(items);
  return {
    ok: counts.missing + counts.diverge + counts.invalid === 0,
    manifestHash: manifest.manifestHash,
    counts,
    items,
  };
}

Object.assign(exports, {
  MANIFEST_VERSION,
  CATALOG_NAMES,
  readLiveForms,
  currentMediaProfileHashes,
  manifestHashOf,
  buildManifest,
  manifestIntegrityProblems,
  verifyAgainstManifest,
});
