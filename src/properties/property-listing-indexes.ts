/**
 * Public-listing indexes owned by migrations 023/024 (DPF-007, M-G). The schema
 * declares the same shapes so its index set matches the database once the
 * migrations have run.
 */
export const PROPERTY_PURPOSE_CATEGORY_LISTING_INDEX = {
  key: { status: 1, isOwnerVisible: 1, lifecycleStatus: 1, purposeCategoryId: 1, createdAt: -1 },
  options: { name: 'property_public_listing_purpose_category' },
} as const;

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
export const PROPERTY_TYPE_LISTING_INDEX = {
  key: { status: 1, isOwnerVisible: 1, lifecycleStatus: 1, purposeSubcategoryIds: 1, createdAt: -1 },
  options: { name: 'property_public_listing_type' },
} as const;

export const PROPERTY_TYPE_LISTING_INDEXES = [PROPERTY_PURPOSE_CATEGORY_LISTING_INDEX, PROPERTY_TYPE_LISTING_INDEX] as const;

/** Pre-DPF-007 purpose/primary-type index; retired only by the manual migration 024. */
export const RETIRED_PURPOSE_LISTING_INDEX = {
  key: { status: 1, isOwnerVisible: 1, lifecycleStatus: 1, purposeCategoryId: 1, purposeSubcategoryId: 1, createdAt: -1 },
  options: { name: 'property_public_listing_purpose' },
} as const;
