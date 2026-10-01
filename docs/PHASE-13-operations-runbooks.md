# Phase 13 — operations runbooks

Each entry: symptom → what the system does by itself → operator action → safe retry → data repair. Where an operation
has **no automatic rollback** it says so. Structured events are single-line JSON (no payloads, no PII).

## 1. Signals: logs, counters, status endpoint, alerts

* **Status endpoint:** `GET /api/v1/admin/operations/status` (staff, `ADMIN_DASHBOARD_READ`). Returns deployment env,
  payment provider in use, migration ledger summary (`failed`, `running`, `lockHeld`), evidence-cleanup queue age,
  process counters since boot and an `attention` list. It is intentionally **not** part of `/health/ready`: a failed migration or
  a stalled queue must alert an operator, never pull healthy instances out of rotation.
* **Structured events worth alerting on:** `http_5xx`, `unhandled_exception`, `domain_rejection` (stale form
  `PROPERTY_FORM_VERSION_OUTDATED`, amenity/spec rejections, form-lifecycle conflicts, payment trouble), `rate_limited`,
  `form_definition_published|archived|restored`, `auction_anchor_unresolved`, `outbox_event_dead_lettered`,
  `auction_finalization_failed|inconsistent`, `evidence_cleanup_run_failed`, `idempotency_completion_failed`,
  `uncaught_exception`, `unhandled_rejection`, `environment_verified` (startup).
* **Suggested alerts (proposed):** any `outbox_event_dead_lettered` or `auction_anchor_unresolved`; `attention` non-empty for
  10 min; 5xx rate above your baseline; `domain_rejection{PAYMENT_RECONCILIATION_REQUIRED}` or `PAYMENT_STATE_INCONSISTENT`;
  a spike in `domain_rejection{PROPERTY_FORM_VERSION_OUTDATED}` right after a form publish (clients are on a stale form).

## 2. Migration failed or was interrupted

* **Symptom:** `attention` contains `migrations_failed` / `migrations_interrupted`; CLI printed `{"status":"failed",…}`.
* **Automatic:** the runner records the failure phase in `migration_ledger` and releases the lock; a hard crash leaves the
  ledger `running` and the lock until its lease (default 5 min) expires. Batches are checkpointed.
* **Operator:** read the ledger row (`phase`, message) and `migration:integrity`. Fix the cause, then re-run
  `migration:apply` — it resumes from the checkpoint (`resumedFromCheckpoint`) and completed migrations are skipped.
* **Never** edit the ledger by hand. A published migration cannot change version. Manual-only migrations (024, 027, 035) run
  only with `--migration=<id>`; run **024 before 035**.
* **No automatic rollback** for data migrations (`rollback.kind: none`): restore the recorded pre-migration snapshot into a
  *separate* database, compare, then apply a reviewed remediation. 034/035 are index-only; 035's rollback is to recreate the
  six indexes it lists.

## 3. Form publication problems

* **Symptom:** a publish returned `FORM_DEFINITION_PUBLISH_INVALID` / `..._VERSION_CONFLICT`, or clients report
  `PROPERTY_FORM_VERSION_OUTDATED` after a publish.
* **Automatic:** publish is a transaction with token checks (`expectedVersion`, `expectedDraftRevision`); a failed publish changes nothing.
  Stale clients get a 409 with the current version and re-fetch (Flutter recovers without losing input).
* **Operator:** read the structured validation errors; fix the draft; retry with fresh tokens.
* **Emergency stop:** archive the definition (new writes stop; history and existing listings untouched); restore when the
  current version is intact. **Correction** = publish a corrective version (published versions are immutable).
* **Verify:** `release:manifest verify`. A `diverge` on a form that was not meant to change means an unreviewed publish.

## 4. Property approval fails

* **Symptom:** approve returns a conflict or a validation error (`PROPERTY_ATTRIBUTES_INVALID`, `PROPERTY_AMENITY_NOT_ALLOWED`,
  `SUBCATEGORIES_INVALID`, `PROPERTY_FORM_DEFINITION_*`).
* **Automatic:** approval is one transaction (revision decision, aggregate sync, audit, outbox event). Any failure — including an outbox
  write — rolls **everything** back; the revision stays `pending_review` and the same version token can be retried.
  Approval re-checks that additional property types are still active, in the purpose and listing-enabled.
* **Operator:** fix the cause (re-activate the type / republish the form) or **reject** with a reason; an admin can always reject.

## 5. Outbox event dead-lettered

* **Symptom:** `outbox_event_dead_lettered`; `attention: outbox_dead_lettered`. The event is parked per consumer, never deleted.
* **Operator:** identify the consumer and cause from the log (`eventId`, class — never the payload). Fix the consumer, then redrive
  deliberately (nothing redrives automatically). Other consumers are unaffected. Find parked events with an aggregation on
  `outbox_events.delivery.<consumer>.status == "DEAD_LETTER"`.

## 6. Media upload / Cloudinary cleanup

* **Symptom:** create/edit fails after upload; `evidence_cleanup_stalled`; `evidence_cleanup_run_failed`.
* **Automatic:** a failed property write compensates its uploaded assets (`deleteOrEnqueue`, reason `property-create-failed`): deleted
  immediately, otherwise queued in `evidence_cleanup_tasks` and retried by the worker (`CLEANUP_*`).
* **Operator:** check the worker is enabled and Cloudinary credentials/quota; the queue drains itself. Pending tasks are safe to retry.

## 7. Payments

* **V1 state:** no real gateway exists. With `PAYMENT_PROVIDER` unset the provider is fail-closed: initiation/verification answer
  `PAYMENT_PROVIDER_UNAVAILABLE` (503) and payment-dependent features stay unavailable. `PAYMENT_PROVIDER=fake` exists only for
  local/development/test and is refused in staging/production.
* **When a real adapter exists:** an INITIATED attempt with a gateway reference is never failed by a timeout — reconcile it by
  calling `verify` again (a callback is only a trigger). `PAYMENT_RECONCILIATION_REQUIRED` means the server flagged a mismatch
  (amount/currency/reference, success after failure): an operator must reconcile before another attempt can be opened.
* **Repair:** entitlements are created only by a verified success and are unique per (auction, bidder); there is no manual path that
  grants one.
* **MAZAD-028 lifecycle** (see `docs/MAZAD-028-payment-lifecycle.md`): the reconciliation worker verifies INITIATED attempts of both
  purposes with a database lease and backoff, and expires them (`EXPIRED`, kept forever) only after a final verification still says
  pending. `PAYMENT_ATTEMPT_TTL_SECONDS` has **no production default**; a protected deployment must set it before enabling the worker.
  The operations status reports `payments.{pending,due,stale,expired,flagged,confirmedAfterExpiry,lateConfirmed}`.
  `payments_reconciliation_required` / `payments_late_confirmed` need **manual** operator review (no Admin tooling yet, no automatic
  refund, refund policy pending legal review); `payments_stale` means the worker is not keeping up or expiry is not configured.

## 8. Auction anchors, finalization, idempotency, account deletion, notifications

* **Auction anchor broken** (`AUCTION_ANCHOR_BROKEN` integrity error, `auction_anchor_unresolved` log): the auction is already excluded from
  discovery and counts. Investigate each id manually (the anchored revision is missing or belongs to another property); never
  re-point an auction to a different revision.
* **Finalization** (`auction_finalization_failed|inconsistent`): the worker retries; an `inconsistent` result needs a manual look at bids and winner
  fields — winner selection is never overridden by hand.
* **Idempotency** (`idempotency_completion_failed`): a repeated key replays the recorded result or answers "in progress" (retry after the advertised
  seconds); records expire after 24 h. Safe to retry with the same key.
* **Account deletion / notification delivery:** follow `docs/MAZAD-017-retention-safe-deletion.md` and `docs/MAZAD-036-persistent-notifications.md`;
  there is no additional Phase 13 tooling for these.

## 9. Migration rehearsal (engineering evidence, disposable database only)

```bash
DEPLOYMENT_ENV=local NODE_ENV=development DESTRUCTIVE_CONFIRM=RESET_DISPOSABLE_DATABASE \
MONGO_URI='mongodb://127.0.0.1:<port>/mazad_phase13_rehearsal?replicaSet=<rs>' \
npx ts-node src/scripts/phase13-migration-rehearsal.ts --out=/tmp/rehearsal.json
```
Refuses any target that is not localhost + `mazad_phase13_*`. Drops that database first. Expect 11/11 PASS.

## 10. Disposable backup / restore drill (NOT a production backup policy)

```bash
DEPLOYMENT_ENV=local NODE_ENV=development DESTRUCTIVE_CONFIRM=RESET_DISPOSABLE_DATABASE \
MONGO_URI='mongodb://127.0.0.1:<port>/mazad_phase13_drill?replicaSet=<rs>' \
npx ts-node src/scripts/phase13-restore-drill.ts --source=mazad_phase13_rehearsal [--keep] [--out=/tmp/drill.json]
```
Clone → verify healthy → snapshot (logical copy of documents and indexes into `<db>_snapshot`) → a release that goes wrong
(divergent form + a migration failing halfway) → prove detection → restore → verify ledger, catalog counts, all 19 form hashes,
integrity and the smoke flows (`test/phase13-local-e2e.spec.ts`). Expect 10/10 PASS. Production backup retention, schedule, PITR, RPO and RTO
are **Operations decisions** and are intentionally not defined by this drill.

## 11. Scale harness

```bash
DEPLOYMENT_ENV=local NODE_ENV=development DESTRUCTIVE_CONFIRM=RESET_DISPOSABLE_DATABASE \
MONGO_URI='mongodb://127.0.0.1:<port>/mazad_phase13_scale?replicaSet=<rs>' \
npx ts-node src/scripts/phase13-scale-harness.ts --scale=100000 --catalog-from=<db with the catalog> --out=/tmp/scale.json
# re-measure after an index/query change without reloading (still needs the same env vars: it rebuilds the indexes):  ... --measure-only
```
Loads a deterministic skewed marketplace, builds the indexes declared by the **current** schemas, and reports explain
(`SORT` stage, keys/docs examined) plus p50/p95 for the real listing/auction/admin-queue queries.

## 12. Extended local E2E (property → auction → fake payments → bidding → managed marketing)

```bash
PHASE13_LOCAL_E2E=1 NODE_ENV=development DEPLOYMENT_ENV=local MONGO_URI='mongodb://127.0.0.1:<port>/mazad_phase13_<name>?replicaSet=<rs>' \
npx jest test/phase13-local-e2e.spec.ts
```
Skipped unless `PHASE13_LOCAL_E2E=1`; refuses non-disposable targets. Uses the `FakePaymentProvider` (deterministic scenarios `success`, `failed`, `pending`, `error`;
`settle()` resolves a pending payment; `failNextVerifications()` simulates a gateway outage). This suite confirms payments by hand.

The complete lifecycle with the LIVE reconciliation worker, real HTTP and realtime (MAZAD-028):

```bash
MAZAD028_LOCAL_E2E=1 NODE_ENV=development DEPLOYMENT_ENV=local MONGO_URI='mongodb://127.0.0.1:<port>/mazad_phase13_<name>?replicaSet=<rs>' \
npx jest test/mazad028-payment-e2e.spec.ts
```
