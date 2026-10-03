# DPF-006/007 multi-type classification backfill and search rollout

## Behavior

`purposeSubcategoryId` stays the primary Property Type; `purposeSubcategoryIds` holds every selected type (DPF-005). Public search keeps the query parameter `purposeSubcategoryId=X`, which now matches listings that selected X as primary **or** additional type.

The search filter reads `purposeSubcategoryIds` only, so every Property must carry the array before the search switch is live. PropertyRevisions are never rewritten; revisions without the array read as `[purposeSubcategoryId]`.

## Migrations

| Migration | Effect | Run by a full `migration:apply` |
|---|---|---|
| `022-property-type-selection-backfill` | sets `purposeSubcategoryIds = [purposeSubcategoryId]` where the array is missing; guarded per document; dry-run reports legacy data | yes |
| `023-property-type-listing-indexes` | creates `property_public_listing_purpose_category` and multikey `property_public_listing_type`; blocks on a same-name index with another key | yes |
| `024-retire-property-purpose-listing-index` | drops `property_public_listing_purpose` only; blocks unless both replacement indexes exist and 022 left nothing to backfill | no — `--migration=024-retire-property-purpose-listing-index` only |

The schema no longer declares `property_public_listing_purpose`, so autoIndex never re-creates it after 024. With autoIndex enabled, the application builds the two new indexes at startup as well; 023 then records them as already applied.

## Order

1. DPF-005 write code is live (every write sets the array; the backfill guard relies on it).
2. Dry-run, then apply 022 and 023 with reviewed output and a verified backup.
3. Deploy the DPF-007 search switch. Listings still lacking the array would be missing from type-filtered search.
4. Verify public type search and the integrity report.
5. Only then run 024 explicitly.

If a run of 022 fails validation with `PROPERTY_TYPE_SELECTION_BACKFILL_INCOMPLETE` because a row was re-pointed without the array while it ran, a plain rerun resumes after the checkpoint and does not revisit that row; inspect the row and the ledger before any reviewed repair.

## Qualification

Qualified on a disposable MongoDB 8.0.32 single-node replica set (never against Atlas): backfill, idempotency, untouched revisions (identical `dbHash`), guarded concurrent writes, integrity findings, any-type search, exact index shapes, conflict blocking, and 024 manual-only retirement all behaved as specified.

## Follow-up: index-provided listing order

Not part of DPF-007. Public listings sort by `{ createdAt: -1, _id: -1 }` (price sorts add the same `_id` tie-breaker). No public listing index supplies that order today because:

- `isOwnerVisible: { $ne: false }` and `lifecycleStatus: { $nin: [...] }` become multi-range bounds ahead of the sort field;
- no listing index ends with `_id`.

`explain("executionStats")`, 20,000 properties, first page of 20:

| Query | Winning index | Plan | Keys examined | Docs examined | Returned |
|---|---|---|---|---|---|
| type only | `property_public_listing_type` (multikey) | blocking SORT | 5,084 | 5,077 | 20 |
| type + price range | `property_public_listing_price` | blocking SORT | 3,316 | 3,307 | 20 |
| type + governorate | `property_public_listing_governorate` | blocking SORT | 3,441 | 3,432 | 20 |
| pre-DPF-007 primary-only | `property_public_listing_purpose` | blocking SORT | 3,927 | 3,918 | 20 |

Keys and documents examined track the matching listings, so the indexes narrow correctly, but every match is sorted in memory. With point visibility bounds and a `createdAt`-only sort, the same type index returned the page with 20 keys and no SORT stage, so the index shape itself is not the limitation. DPF-007 does not regress the previous behavior. Optimizing the visibility predicates, tie-breaker, or index shapes for index-provided order needs its own task with its own pagination-stability review.
