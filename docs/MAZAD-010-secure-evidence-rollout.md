# MAZAD-010 secure evidence rollout

## Storage contract

- `PUBLIC_PROPERTY_MEDIA` is delivered by the public image CDN. Public DTOs contain only the display URL and label; provider IDs are server-only.
- `PRIVATE_PROPERTY_EVIDENCE`, `PRIVATE_KYC_EVIDENCE`, and the reusable `PRIVATE_BROKER_EVIDENCE` primitive use Cloudinary `authenticated` delivery.
- New private records store a provider asset ID, resource type, delivery type, classification, format, and byte count. They do not store a permanent delivery URL.
- Admin and owner access is authorized by the API before bytes are proxied with `private, no-store` and `nosniff` headers.

## Compatibility and migration

Existing KYC authenticated assets remain readable. Legacy KYC URL columns are not returned by an API and are no longer populated by new submissions.

Legacy property title deeds were uploaded with public delivery. Their raw URLs are no longer returned by public, owner, or Admin DTOs. The authorized proxy can read the legacy URL temporarily so moderation does not break, but knowledge of an old provider URL can still bypass the API. Before production launch, operations must:

1. Inventory every `properties.titleDeed` without `deliveryType: authenticated`.
2. Copy each source asset to an authenticated asset using a controlled, resumable job.
3. Conditionally update the property only when its original `publicId` still matches, recording the old and new provider IDs in the migration report.
4. Validate authorized owner/Admin delivery and verify public delivery is denied.
5. Delete the old public asset only after backup/validation and record the result. There is no automatic destructive migration or rollback.

This rollout is a production launch gate; it is not safe to assume legacy public URLs became private merely because DTO exposure was removed.

## Cleanup and reconciliation

Upload compensation first attempts provider deletion. Failed deletions are upserted into `evidence_cleanup_tasks` without raw URLs or provider error details. A deployment worker must call `CloudinaryAssetService.reconcilePendingCleanup()` on a bounded schedule and alert on old or repeatedly failing pending tasks. Cleanup tasks are retained for operational traceability; retention duration requires legal/operations approval.

## Malware scanning boundary

`EvidenceMalwareScanner` defines the provider-neutral integration boundary. V1 has no configured scanning provider and does not label uploads as scanned. Selecting, operating, and monitoring a real scanning provider remains a deployment security requirement. Signature, MIME consistency, size, file count, structural integrity, and image dimension limits are enforced now.

## Legal/operations launch items

- Evidence retention and deletion periods require legal approval.
- Access-log retention requires legal/operations approval.
- A malware scanning provider and failure policy require security/operations approval.
- The legacy public title-deed inventory and migration must be completed and verified before production launch.
