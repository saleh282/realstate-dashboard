# MAZAD-017 retention-safe deletion operations

## Implemented lifecycle

`ACTIVE -> DELETION_PENDING -> RESTORED | ANONYMIZING -> ANONYMIZED`

- A deletion request is an atomic user/workflow transition and immediately revokes all refresh sessions.
- Normal access and refresh are denied from `DELETION_PENDING`; valid login credentials return only the safe recovery deadline and workflow version.
- Recovery is explicit, requires the account password followed by an emailed one-time code, uses the workflow version/state predicate, and requires a new login. Password reset never restores the account.
- Email and phone remain reserved while pending. Anonymization unsets eligible identifiers, so any later registration creates a new User ID and cannot inherit old history.
- Published/pending property relationships remain attached to the original internal User ID. They block anonymization until their lifecycle is resolved; no ownership transfer occurs.
- Future settlement, payment, dispute, and regulatory modules plug into `ACCOUNT_DELETION_BLOCKER_PROVIDERS`. Missing future modules do not fabricate blockers.
- Legal hold is an audited optimistic transition on the workflow. Customer projections never expose its reason or investigation details.

## Evidence and history

KYC, broker, property evidence, audit logs, property revisions, and other historical records are retained with `RETAIN_PENDING_POLICY`. MAZAD-010 cleanup is not invoked until an asset is explicitly eligible under an approved retention policy. This prevents provider deletion from racing or destroying referenced evidence.

The anonymized account keeps its internal `_id`, receives a non-public `pseudonymousActorId`, and exposes the generic name `Deleted Account` without email or phone. Public DTOs must never expose the pseudonymous ID.

## Final purge gate

Final physical purge is deliberately disabled (`finalPurgeEnabled: false`). No legal retention duration is approved. Enabling purge requires all of the following outside this task:

1. approved legal retention/erasure policy per data class;
2. verified backups and restore drill;
3. all blocker providers deployed and reconciled;
4. reviewed evidence-cleanup eligibility and retry operations;
5. a separate privileged purge command/job with required audit and no automatic rollback.

Do not run `migration:apply` against staging or production without backup and target approval. Use MAZAD-011 dry-run/preflight first; `017-account-deletion-indexes` creates only additive workflow indexes and never fabricates deletion states.
