'use strict';

const { PropertyAttributeSchema } = require('../models/property-attribute.model');
const { ensureSchemaIndexes, ATTRIBUTES } = require('./025-property-form-foundation');
const PHASE10_NEW_ATTRIBUTE_SEED = [
  {
    key: 'unitFloorLevel',
    dataType: 'singleSelect',
    labelAr: 'مستوى الوحدة',
    labelEn: 'Unit Floor Level',
    hardBounds: {},
    options: [
      { code: 'ground', labelAr: 'الدور الأرضي', labelEn: 'Ground Floor' },
      { code: 'basement', labelAr: 'البدروم', labelEn: 'Basement' },
      { code: 'mezzanine', labelAr: 'الميزانين', labelEn: 'Mezzanine' },
      { code: 'upper', labelAr: 'دور علوي', labelEn: 'Upper Floor' },
    ],
  },
];
const IDENTITY_FIELDS = ['dataType', 'unit'];
function optionCodes(options) {
  return [...(options ?? [])].map((option) => option.code).sort();
}
/** Builds the registry document for one Phase 10 seed entry (mirrors migration 029's phase8RegistryDocument, kept independent so 025/029/030/031 are never touched). */
function phase10RegistryDocument(seed, now) {
  const select = seed.dataType === 'singleSelect' || seed.dataType === 'multiSelect';
  return {
    key: seed.key,
    dataType: seed.dataType,
    ...(seed.unit ? { unit: seed.unit } : {}),
    labelAr: seed.labelAr,
    labelEn: seed.labelEn,
    hardBounds: { ...seed.hardBounds },
    ...(select ? { optionSource: 'inline' } : {}),
    ...(seed.options
      ? {
          options: seed.options.map((option) => ({
            code: option.code,
            labelAr: option.labelAr,
            labelEn: option.labelEn,
            status: 'active',
          })),
        }
      : {}),
    status: 'active',
    origin: 'system',
    createdAt: now,
    updatedAt: now,
  };
}
/** Seed keys that are missing, already present with the same identity, or present with a different identity/options. */
async function scanPhase10RegistrySeed(db) {
  const existing = await db
    .collection(ATTRIBUTES)
    .find({ key: { $in: PHASE10_NEW_ATTRIBUTE_SEED.map((seed) => seed.key) } })
    .toArray();
  const byKey = new Map(existing.map((document) => [document.key, document]));
  const missing = [];
  const matching = [];
  const conflicting = [];
  for (const seed of PHASE10_NEW_ATTRIBUTE_SEED) {
    const stored = byKey.get(seed.key);
    if (!stored) {
      missing.push(seed.key);
      continue;
    }
    const identityMatches = IDENTITY_FIELDS.every(
      (field) =>
        (stored[field] ?? null) === (phase10RegistryDocument(seed, new Date())[field] ?? null),
    );
    const optionsMatch =
      JSON.stringify(optionCodes(stored.options)) === JSON.stringify(optionCodes(seed.options));
    if (identityMatches && optionsMatch) matching.push(seed.key);
    else conflicting.push(seed.key);
  }
  const inactive = existing
    .filter((document) => document.status !== 'active')
    .map((document) => document.key);
  return { missing, matching, conflicting, inactive };
}
async function seedPhase10Registry(db, now) {
  await ensureSchemaIndexes(db, ATTRIBUTES, PropertyAttributeSchema);
  let inserted = 0;
  for (const seed of PHASE10_NEW_ATTRIBUTE_SEED) {
    // Insert-only: an existing key is never modified (identity is immutable).
    const result = await db
      .collection(ATTRIBUTES)
      .updateOne(
        { key: seed.key },
        { $setOnInsert: phase10RegistryDocument(seed, now) },
        { upsert: true },
      );
    inserted += result.upsertedCount ?? 0;
  }
  return inserted;
}

Object.assign(exports, {
  PHASE10_NEW_ATTRIBUTE_SEED,
  phase10RegistryDocument,
  scanPhase10RegistrySeed,
  seedPhase10Registry,
});
