# MAZAD-018 classified property media rollout

## Contract

- `galleryMedia` is the single authoritative ordered collection of categorized public property photos for new writes. Each new asset carries its server-validated `slotId`.
- The required slot set is derived from the submitted property structure: one `exterior` photo of the building, one separate `entrance` photo, every `living_N`, every `bedroom_N`, every `kitchen_N`, and every `bathroom_N`. Optional supporting photos use unique `additional_N` identifiers.
- `entranceImageAsset` is deprecated historical compatibility only. New writes never populate it. Historical values are appended to the unified read projection without inventing a `slotId` or rewriting stored media.
- `privateEvidenceAssets` is private moderation evidence. API projections expose only opaque index descriptors; provider identifiers and delivery URLs remain server-side.
- A new property submission requires the complete derived photo-slot set. Exterior and entrance are distinct slots requiring distinct files, and both have the same upload, validation, storage, and public projection behavior as every other required slot.
- Marketplace reads use only `currentPublicRevisionId`. Owner and Admin reads may inspect the pending revision. Private evidence is never part of the marketplace projection.

## Compatibility and migration

The additive revision fields were introduced by the MAZAD-015 schema/migration and remain nullable for historical data. MAZAD-018 adds `slotId` only to new media writes and performs no destructive database migration. Existing gallery assets and historical `entranceImageAsset` values remain readable with unknown classification; no category is inferred or backfilled.

Legacy `Property.titleDeed` references remain accessible only through the authenticated evidence proxy. Moving legacy provider assets from public delivery to authenticated delivery remains a deployment gate. Execute provider-side remediation only after a dry-run inventory and backup; never delete or rewrite assets in place without verified rollback data.

## Failure handling

Uploads and the complete slot set are validated before provider calls. If a later database operation fails, all newly uploaded public photos and private evidence assets are sent to immediate compensation. A failed provider deletion is persisted in the existing evidence cleanup queue for bounded reconciliation.

## Deployment gates

- Configure a real provider-neutral malware scanner before claiming uploads are malware-scanned. The current scanner boundary is fail-safe but no vendor is selected.
- Approve evidence retention duration and deletion eligibility with legal/compliance.
- Complete the dry-run legacy title-deed inventory and authenticated-delivery remediation before production launch.
- Keep Cloudinary credentials server-side and verify authenticated delivery and cleanup-worker alerts in staging.
