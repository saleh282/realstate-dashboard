import type { Db, Document } from 'mongodb';
import { PROPERTY_TYPE_LISTING_INDEXES } from '../properties/property-listing-indexes';

/**
 * DPF-006 (M-F): multi-property-type classification data for rows written
 * before DPF-005. Properties get `purposeSubcategoryIds = [purposeSubcategoryId]`;
 * immutable PropertyRevisions are never rewritten and read the same fallback.
 */

/** Properties still lacking the array while carrying a primary type. */
export const PROPERTY_TYPE_SELECTION_BACKFILL_FILTER = {
  purposeSubcategoryIds: { $exists: false },
  purposeSubcategoryId: { $ne: null },
} as const;

/** Aggregation expression: the stored selection, or [primary] for rows without the array. */
export const EFFECTIVE_TYPE_SELECTION: Document = {
  $cond: [
    { $isArray: '$purposeSubcategoryIds' },
    '$purposeSubcategoryIds',
    { $cond: [{ $ifNull: ['$purposeSubcategoryId', false] }, ['$purposeSubcategoryId'], []] },
  ],
};

/** A stored selection (any value, including null) that does not contain the primary type. */
export const SELECTION_MISSING_PRIMARY_FILTER: Document = {
  purposeSubcategoryId: { $ne: null },
  purposeSubcategoryIds: { $exists: true },
  $expr: { $not: [{ $in: ['$purposeSubcategoryId', { $cond: [{ $isArray: '$purposeSubcategoryIds' }, '$purposeSubcategoryIds', []] }] }] },
};

/** Documents carrying more than one selected type. */
export const MULTIPLE_SELECTED_TYPES_FILTER = { 'purposeSubcategoryIds.1': { $exists: true } } as const;

export type PropertyTypeSelectionScan = {
  eligible: number;
  alreadyApplied: number;
  report: {
    propertiesMissingPurposeSubcategoryId: number;
    revisionsMissingPurposeSubcategoryId: number;
    activeTypesWithoutPurposeCategoryId: number;
    propertiesWithMultipleSelectedTypes: number;
    revisionsWithMultipleSelectedTypes: number;
    propertiesWithSelectionMissingPrimary: number;
  };
};

/**
 * Read-only preflight/legacy report. It only counts: suspicious historical data
 * is reported for review, never corrected or treated as a blocker here.
 */
export async function scanPropertyTypeSelection(db: Db): Promise<PropertyTypeSelectionScan> {
  const properties = db.collection('properties');
  const revisions = db.collection('property_revisions');
  const [
    eligible, alreadyApplied, propertiesMissingPurposeSubcategoryId, revisionsMissingPurposeSubcategoryId,
    activeTypesWithoutPurposeCategoryId, propertiesWithMultipleSelectedTypes, revisionsWithMultipleSelectedTypes,
    propertiesWithSelectionMissingPrimary,
  ] = await Promise.all([
    properties.countDocuments(PROPERTY_TYPE_SELECTION_BACKFILL_FILTER),
    properties.countDocuments({ purposeSubcategoryIds: { $exists: true } }),
    properties.countDocuments({ purposeSubcategoryId: null }),
    revisions.countDocuments({ purposeSubcategoryId: null }),
    db.collection('property_types').countDocuments({ isActive: true, purposeCategoryId: null }),
    properties.countDocuments(MULTIPLE_SELECTED_TYPES_FILTER),
    revisions.countDocuments(MULTIPLE_SELECTED_TYPES_FILTER),
    properties.countDocuments(SELECTION_MISSING_PRIMARY_FILTER),
  ]);
  return {
    eligible,
    alreadyApplied,
    report: {
      propertiesMissingPurposeSubcategoryId, revisionsMissingPurposeSubcategoryId, activeTypesWithoutPurposeCategoryId,
      propertiesWithMultipleSelectedTypes, revisionsWithMultipleSelectedTypes, propertiesWithSelectionMissingPrimary,
    },
  };
}

export type ExistingIndex = { name?: string; key?: Record<string, unknown> };

/** Exact compound-key comparison: field order and direction both matter. */
export function indexKeyMatches(existing: ExistingIndex | undefined, key: Record<string, unknown>): boolean {
  return Boolean(existing?.key) && JSON.stringify(existing!.key) === JSON.stringify(key);
}

/** Replacement listing indexes that are missing or exist under their name with a different key. */
export function listingIndexProblems(indexes: ExistingIndex[]) {
  const byName = new Map(indexes.map((index) => [index.name, index]));
  const missing = PROPERTY_TYPE_LISTING_INDEXES.filter((expected) => !byName.has(expected.options.name)).map((expected) => expected.options.name);
  const conflicting = PROPERTY_TYPE_LISTING_INDEXES
    .filter((expected) => byName.has(expected.options.name) && !indexKeyMatches(byName.get(expected.options.name), expected.key))
    .map((expected) => expected.options.name);
  return { missing, conflicting };
}
