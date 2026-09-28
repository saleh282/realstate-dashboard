import type { Db, Document } from 'mongodb';
import {
  PropertyAttributeDataType,
  PropertyAttributeUnit,
} from '../property-attributes/property-attribute.constants';
import { PropertyAttributeSchema } from '../property-attributes/schemas/property-attribute.schema';
import { ensureSchemaIndexes, ATTRIBUTES } from './025-property-form-foundation';

/**
 * Phase 10 (Complete Remaining Property Types): the engineering-owned
 * Attribute Registry entry for `unitFloorLevel`, a generic floor-level
 * concept for office/clinic/commercial_unit. Deliberately a distinct key
 * from `shopFloorLevel` (product decision: no reuse across those types).
 * Insert-only, same pattern as migration 025 M-A / 029: an existing key is
 * never modified, this file never touches 025/029/030/031. No `facetKey` —
 * Phase 10 does not expand search/facet scope.
 */

export type Phase10AttributeOption = { code: string; labelAr: string; labelEn: string };

export type Phase10AttributeSeed = {
  key: string;
  dataType: PropertyAttributeDataType;
  unit?: PropertyAttributeUnit;
  labelAr: string;
  labelEn: string;
  hardBounds: { min?: number; max?: number; scale?: number; maxItems?: number };
  options?: readonly Phase10AttributeOption[];
};

export const PHASE10_NEW_ATTRIBUTE_SEED: readonly Phase10AttributeSeed[] = [
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

const IDENTITY_FIELDS = ['dataType', 'unit'] as const;

function optionCodes(options?: readonly Phase10AttributeOption[]): string[] {
  return [...(options ?? [])].map((option) => option.code).sort();
}

/** Builds the registry document for one Phase 10 seed entry (mirrors migration 029's phase8RegistryDocument, kept independent so 025/029/030/031 are never touched). */
export function phase10RegistryDocument(seed: Phase10AttributeSeed, now: Date): Document {
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
      ? { options: seed.options.map((option) => ({ code: option.code, labelAr: option.labelAr, labelEn: option.labelEn, status: 'active' })) }
      : {}),
    status: 'active',
    origin: 'system',
    createdAt: now,
    updatedAt: now,
  };
}

/** Seed keys that are missing, already present with the same identity, or present with a different identity/options. */
export async function scanPhase10RegistrySeed(db: Db) {
  const existing = await db.collection(ATTRIBUTES).find({ key: { $in: PHASE10_NEW_ATTRIBUTE_SEED.map((seed) => seed.key) } }).toArray();
  const byKey = new Map(existing.map((document) => [document.key as string, document]));
  const missing: string[] = [];
  const matching: string[] = [];
  const conflicting: string[] = [];
  for (const seed of PHASE10_NEW_ATTRIBUTE_SEED) {
    const stored = byKey.get(seed.key);
    if (!stored) { missing.push(seed.key); continue; }
    const identityMatches = IDENTITY_FIELDS.every((field) => (stored[field] ?? null) === ((phase10RegistryDocument(seed, new Date()) as any)[field] ?? null));
    const optionsMatch = JSON.stringify(optionCodes(stored.options)) === JSON.stringify(optionCodes(seed.options));
    if (identityMatches && optionsMatch) matching.push(seed.key);
    else conflicting.push(seed.key);
  }
  const inactive = existing.filter((document) => document.status !== 'active').map((document) => document.key as string);
  return { missing, matching, conflicting, inactive };
}

export async function seedPhase10Registry(db: Db, now: Date): Promise<number> {
  await ensureSchemaIndexes(db, ATTRIBUTES, PropertyAttributeSchema);
  let inserted = 0;
  for (const seed of PHASE10_NEW_ATTRIBUTE_SEED) {
    // Insert-only: an existing key is never modified (identity is immutable).
    const result = await db.collection(ATTRIBUTES).updateOne({ key: seed.key }, { $setOnInsert: phase10RegistryDocument(seed, now) }, { upsert: true });
    inserted += result.upsertedCount ?? 0;
  }
  return inserted;
}
