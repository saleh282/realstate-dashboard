'use strict';

/**
 * Public-listing indexes owned by migrations 023/024 (DPF-007, M-G). The schema
 * declares the same shapes so its index set matches the database once the
 * migrations have run.
 */
const PROPERTY_PURPOSE_CATEGORY_LISTING_INDEX = {
  key: { status: 1, isOwnerVisible: 1, lifecycleStatus: 1, purposeCategoryId: 1, createdAt: -1 },
  options: { name: 'property_public_listing_purpose_category' },
};
/**
 * Multikey: `purposeSubcategoryIds` is an array (at most 4 entries per listing).
 * The equality match on it narrows the scan to listings that selected the type
 * (keys examined ≈ matching listings, no duplicate rows).
 *
 * It does NOT supply the public `createdAt` order for the query the service
 * issues (verified with explain() on MongoDB 8.0): the visibility predicates
 * `isOwnerVisible: { $ne: false }` and `lifecycleStatus: { $nin: [...] }` become
 * range bounds ahead of `createdAt`, and the `_id` tie-breaker in
 * `{ createdAt: -1, _id: -1 }` is in no index, so MongoDB runs a blocking top-k
 * SORT. That is pre-existing: the replaced primary-only query and index behave
 * the same way. Optimizing listing sorts is a separate follow-up.
 */
const PROPERTY_TYPE_LISTING_INDEX = {
  key: {
    status: 1,
    isOwnerVisible: 1,
    lifecycleStatus: 1,
    purposeSubcategoryIds: 1,
    createdAt: -1,
  },
  options: { name: 'property_public_listing_type' },
};
const PROPERTY_TYPE_LISTING_INDEXES = [
  PROPERTY_PURPOSE_CATEGORY_LISTING_INDEX,
  PROPERTY_TYPE_LISTING_INDEX,
];
/** Pre-DPF-007 purpose/primary-type index; retired only by the manual migration 024. */
const RETIRED_PURPOSE_LISTING_INDEX = {
  key: {
    status: 1,
    isOwnerVisible: 1,
    lifecycleStatus: 1,
    purposeCategoryId: 1,
    purposeSubcategoryId: 1,
    createdAt: -1,
  },
  options: { name: 'property_public_listing_purpose' },
};
/**
 * Phase 13 sortable listing indexes (migration 034). The public listing sorts by
 * `{ createdAt: -1, _id: -1 }` or `{ totalPriceMinor: ±1, _id: ±1 }`; with the
 * `_id` tie-breaker in the index key AND set-membership visibility predicates
 * (`isOwnerVisible: { $in: [true, null] }`, `lifecycleStatus: { $in: ['active', null] }`
 * instead of `$ne` / `$nin`) MongoDB serves the first page by merging a few index
 * ranges (SORT_MERGE) instead of scanning and sorting every visible listing.
 * Measured on 100k listings: 83,797 keys and ~74 ms p50 down to 20 keys and ~1 ms.
 *
 * New names, not new keys under old names: an existing database keeps its old
 * indexes untouched (autoIndex would otherwise fail on a same-name key change)
 * until the manual migration 035 retires them.
 */
const VISIBILITY = { status: 1, isOwnerVisible: 1, lifecycleStatus: 1 };
const NEWEST = { createdAt: -1, _id: -1 };
const PROPERTY_SORTABLE_LISTING_INDEXES = [
  { key: { ...VISIBILITY, ...NEWEST }, options: { name: 'property_public_listing_newest_v2' } },
  {
    key: { ...VISIBILITY, operationType: 1, ...NEWEST },
    options: { name: 'property_public_listing_operation_type_v2' },
  },
  {
    key: { ...VISIBILITY, governorateCode: 1, ...NEWEST },
    options: { name: 'property_public_listing_governorate_v2' },
  },
  {
    key: { ...VISIBILITY, purposeCategoryId: 1, ...NEWEST },
    options: { name: 'property_public_listing_purpose_category_v2' },
  },
  {
    key: { ...VISIBILITY, purposeSubcategoryIds: 1, ...NEWEST },
    options: { name: 'property_public_listing_type_v2' },
  },
  // Ascending; walked in reverse for `price_desc` (whose sort is { totalPriceMinor: -1, _id: -1 }).
  {
    key: { ...VISIBILITY, totalPriceMinor: 1, _id: 1 },
    options: { name: 'property_public_listing_price_v2' },
  },
];
/** Indexes superseded by the sortable set; dropped only by the manual migration 035. */
const SUPERSEDED_LISTING_INDEXES = [
  { key: { ...VISIBILITY, createdAt: -1 }, options: { name: 'property_public_listing_newest' } },
  {
    key: { ...VISIBILITY, operationType: 1, createdAt: -1 },
    options: { name: 'property_public_listing_operation_type' },
  },
  {
    key: { ...VISIBILITY, governorateCode: 1, createdAt: -1 },
    options: { name: 'property_public_listing_governorate' },
  },
  PROPERTY_PURPOSE_CATEGORY_LISTING_INDEX,
  PROPERTY_TYPE_LISTING_INDEX,
  {
    key: { ...VISIBILITY, totalPriceMinor: 1 },
    options: { name: 'property_public_listing_price' },
  },
];

Object.assign(exports, {
  PROPERTY_PURPOSE_CATEGORY_LISTING_INDEX,
  PROPERTY_TYPE_LISTING_INDEX,
  PROPERTY_TYPE_LISTING_INDEXES,
  RETIRED_PURPOSE_LISTING_INDEX,
  PROPERTY_SORTABLE_LISTING_INDEXES,
  SUPERSEDED_LISTING_INDEXES,
});
