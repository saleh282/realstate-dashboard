import type { Db } from 'mongodb';
import { PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED } from './029-non-residential-attribute-registry';
import { ATTRIBUTES } from './025-property-form-foundation';

/**
 * Phase 9 (Search & Facets): promotes exactly 7 of the 17 Phase 8
 * non-residential Attribute Registry entries to typed search facets, by
 * setting `facetKey` (always == key, the existing registry invariant) on
 * each. Never touches migrations 025 or 029, never mutates any identity
 * field (key/dataType/unit/options/hardBounds) — the only write this
 * migration ever performs is moving `facetKey` from unset to `key` on an
 * already-seeded entry, exactly once.
 */

export const PHASE9_PROMOTED_FACET_KEYS: readonly string[] = [
  'shopFloorLevel',
  'commercialUseTypes',
  'builtAreaSqm',
  'powerSource',
  'industrialUseType',
  'soilType',
  'waterSource',
];

const PHASE8_KEYS = new Set(PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.map((seed) => seed.key));
for (const key of PHASE9_PROMOTED_FACET_KEYS) {
  if (!PHASE8_KEYS.has(key)) throw new Error(`Phase 9 facet promotion references an unknown Phase 8 attribute key: ${key}`);
}

export type Phase9FacetPromotionScan = {
  /** Approved promotion keys not yet present in the registry (029 has not run, or ran incompletely). */
  missing: string[];
  /** Present, `facetKey` unset: this migration will set it. */
  eligible: string[];
  /** Present, `facetKey` already equals its own key: idempotent no-op. */
  alreadyPromoted: string[];
  /** Present, `facetKey` set to something unexpected: fail closed, never overwritten. */
  conflicting: string[];
};

export async function scanPhase9FacetPromotion(db: Db): Promise<Phase9FacetPromotionScan> {
  const existing = await db.collection(ATTRIBUTES).find({ key: { $in: [...PHASE9_PROMOTED_FACET_KEYS] } }).toArray();
  const byKey = new Map(existing.map((document) => [document.key as string, document]));
  const missing: string[] = [];
  const eligible: string[] = [];
  const alreadyPromoted: string[] = [];
  const conflicting: string[] = [];
  for (const key of PHASE9_PROMOTED_FACET_KEYS) {
    const stored = byKey.get(key);
    if (!stored) { missing.push(key); continue; }
    if (!stored.facetKey) { eligible.push(key); continue; }
    if (stored.facetKey === key) { alreadyPromoted.push(key); continue; }
    conflicting.push(key);
  }
  return { missing, eligible, alreadyPromoted, conflicting };
}

/** Sets `facetKey = key` on every eligible entry. Never touches an entry whose `facetKey` is already set (idempotent, insert-once semantics). */
export async function promotePhase9Facets(db: Db): Promise<number> {
  const { eligible } = await scanPhase9FacetPromotion(db);
  let modified = 0;
  for (const key of eligible) {
    const result = await db.collection(ATTRIBUTES).updateOne({ key, facetKey: { $exists: false } }, { $set: { facetKey: key } });
    modified += result.modifiedCount ?? 0;
  }
  return modified;
}
