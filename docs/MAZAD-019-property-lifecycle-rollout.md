# MAZAD-019 property lifecycle rollout

## Authority

`Property` is the aggregate and owns attribution, lifecycle visibility, revision pointers, and optimistic lifecycle version. `PropertyRevision` owns listing content and the moderation decision. New content is never written into the current approved revision.

## State machine

| From | Command | To | Public effect |
|---|---|---|---|
| none | create | DRAFT revision 1 | none |
| DRAFT | submit with matching version | PENDING_REVIEW | existing approved revision remains public |
| PENDING_REVIEW | Admin approve with matching version | APPROVED | public pointer moves atomically |
| PENDING_REVIEW | Admin reject with matching version and reason | REJECTED | public pointer is unchanged |
| APPROVED/REJECTED | create edited revision | new sequential DRAFT | prior approved revision remains immutable/public |

Only one `PENDING_REVIEW` revision is allowed per property. The aggregate pointer and the partial unique index enforce this rule. Rejected revisions are immutable review history; corrections create a new sequential draft.

Aggregate lifecycle is `active`, `archived`, or `admin_hidden`. Archive/hide changes visibility without deleting revision pointers, media, evidence, or history. The `PropertyAuctionLockService` boundary rejects archive or revision creation with `PROPERTY_AUCTION_LOCKED` once the future auction module supplies a scheduled/active lock implementation.

## Compatibility

- Legacy aggregate listing fields remain read-only compatibility data.
- Historical revision 1 records remain readable without fabricating purpose, marketing mode, or classified media.
- Modern validation applies when a new draft/revision enters the new submission flow.
- Public reads require an active, visible aggregate and `currentPublicRevisionId`; pending/rejected/private content is never projected.

## Migration

Run `npm run migration:check` first. Migration `019-property-lifecycle`:

- blocks on multiple pending revisions per property;
- additively backfills only technical aggregate lifecycle controls;
- creates the one-pending, moderation-queue, and public-lifecycle indexes;
- never deletes or rewrites historical content.

Do not run `migration:apply` against staging/production without a backup, reviewed dry-run output, and rollback rehearsal.
