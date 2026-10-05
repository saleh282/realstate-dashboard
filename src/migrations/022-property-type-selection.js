'use strict';

const { PROPERTY_TYPE_LISTING_INDEXES } = require('../domain/properties/property-listing-indexes');
/**
 * DPF-006 (M-F): multi-property-type classification data for rows written
 * before DPF-005. Properties get `purposeSubcategoryIds = [purposeSubcategoryId]`;
 * immutable PropertyRevisions are never rewritten and read the same fallback.
 */
/** Properties still lacking the array while carrying a primary type. */
const PROPERTY_TYPE_SELECTION_BACKFILL_FILTER = {
  purposeSubcategoryIds: { $exists: false },
  purposeSubcategoryId: { $ne: null },
};
/** Aggregation expression: the stored selection, or [primary] for rows without the array. */
const EFFECTIVE_TYPE_SELECTION = {
  $cond: [
    { $isArray: '$purposeSubcategoryIds' },
    '$purposeSubcategoryIds',
    { $cond: [{ $ifNull: ['$purposeSubcategoryId', false] }, ['$purposeSubcategoryId'], []] },
  ],
};
/** A stored selection (any value, including null) that does not contain the primary type. */
const SELECTION_MISSING_PRIMARY_FILTER = {
  purposeSubcategoryId: { $ne: null },
  purposeSubcategoryIds: { $exists: true },
  $expr: {
    $not: [
      {
        $in: [
          '$purposeSubcategoryId',
          { $cond: [{ $isArray: '$purposeSubcategoryIds' }, '$purposeSubcategoryIds', []] },
        ],
      },
    ],
  },
};
/** Documents carrying more than one selected type. */
const MULTIPLE_SELECTED_TYPES_FILTER = { 'purposeSubcategoryIds.1': { $exists: true } };
/**
 * Read-only preflight/legacy report. It only counts: suspicious historical data
 * is reported for review, never corrected or treated as a blocker here.
 */
async function scanPropertyTypeSelection(db) {
  const properties = db.collection('properties');
  const revisions = db.collection('property_revisions');
  const [
    eligible,
    alreadyApplied,
    propertiesMissingPurposeSubcategoryId,
    revisionsMissingPurposeSubcategoryId,
    activeTypesWithoutPurposeCategoryId,
    propertiesWithMultipleSelectedTypes,
    revisionsWithMultipleSelectedTypes,
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
      propertiesMissingPurposeSubcategoryId,
      revisionsMissingPurposeSubcategoryId,
      activeTypesWithoutPurposeCategoryId,
      propertiesWithMultipleSelectedTypes,
      revisionsWithMultipleSelectedTypes,
      propertiesWithSelectionMissingPrimary,
    },
  };
}
/** Exact compound-key comparison: field order and direction both matter. */
function indexKeyMatches(existing, key) {
  return Boolean(existing?.key) && JSON.stringify(existing.key) === JSON.stringify(key);
}
/**
 * Whether an expected named+unique index is already satisfied: by its intended
 * name, or by an equivalent index under a different name (same key, same
 * uniqueness) — e.g. one preserved across an environment reset. A same-key
 * index with different uniqueness is `incompatible-key`: never silently
 * accepted as equivalent, and never dropped/renamed to force a match.
 */
function reconcileIndex(existing, expected) {
  const byName = existing.find((index) => index.name === expected.options.name);
  if (byName) return { outcome: 'satisfied-by-name', existingName: byName.name };
  const byKey = existing.find((index) => indexKeyMatches(index, expected.key));
  if (!byKey) return { outcome: 'missing' };
  return Boolean(byKey.unique) === Boolean(expected.options.unique)
    ? { outcome: 'satisfied-by-equivalent-key', existingName: byKey.name }
    : { outcome: 'incompatible-key', existingName: byKey.name };
}
/** Replacement listing indexes that are missing or exist under their name with a different key. */
function listingIndexProblems(indexes) {
  const byName = new Map(indexes.map((index) => [index.name, index]));
  const missing = PROPERTY_TYPE_LISTING_INDEXES.filter(
    (expected) => !byName.has(expected.options.name),
  ).map((expected) => expected.options.name);
  const conflicting = PROPERTY_TYPE_LISTING_INDEXES.filter(
    (expected) =>
      byName.has(expected.options.name) &&
      !indexKeyMatches(byName.get(expected.options.name), expected.key),
  ).map((expected) => expected.options.name);
  return { missing, conflicting };
}

Object.assign(exports, {
  PROPERTY_TYPE_SELECTION_BACKFILL_FILTER,
  EFFECTIVE_TYPE_SELECTION,
  SELECTION_MISSING_PRIMARY_FILTER,
  MULTIPLE_SELECTED_TYPES_FILTER,
  scanPropertyTypeSelection,
  indexKeyMatches,
  reconcileIndex,
  listingIndexProblems,
});
