# Phase 13 — release, rollout and readiness runbook

Status: engineering runbook for the Dynamic Property System. It deliberately **does not** define production backup
retention, schedule, PITR, RPO or RTO — those are Operations decisions still to be made (see "Open decisions").

## 1. Release artifacts

| Artifact | Where | Verified by |
|---|---|---|
| Baseline manifest (catalogs by stable code, 19 published forms with `contentHash`, media-profile hashes) | `src/release/baseline-manifest.v1.json` | `npm run release:manifest -- verify` |
| Migrations (23 registered, 3 manual-only: 024, 027, 035) | `src/migrations/framework/core-migrations.ts` | `npm run migration:check` |
| Integrity report | `npm run migration:integrity` | must show 0 errors |
| Frozen media-profile hashes | `FROZEN_MEDIA_PROFILE_HASHES` | `test/phase13-media-profile-pinning.spec.ts`, manifest verify |

**Ownership.** Governorates, cities and property options are code-owned and seeded on application boot
(`onModuleInit`). Purposes, the 7 legacy types and 7 amenities come from `baseline-catalog.seed`; the attribute
registry, facets and the 5 later amenities come from migrations 025/029–033; the 7 residential forms from migration
026. The 12 non-residential forms are **not** migration-owned: the manifest publishes them through the real Admin
service. ObjectIds, timestamps, actors, version numbers and ledger run ids stay dynamic per environment.

### Regenerating the manifest (only when the baseline intentionally changes)

```bash
# from a verified environment, never from production data:
DEPLOYMENT_ENV=local NODE_ENV=development MONGO_URI=<verified db> \
  npm run release:manifest -- export --out=src/release/baseline-manifest.vNEXT.json
```
Review the diff, bump the file name/`releaseId`, commit it. The export refuses an incomplete form or a stored hash that
does not match its content.

### Manifest commands

```bash
npm run release:manifest -- verify [--strict]          # read-only; exit 1 on missing/diverge/invalid
npm run release:manifest -- apply --dry-run            # plan only
npm run release:manifest -- apply                      # create missing forms via the Admin service
npm run release:manifest -- apply --allow-publish=shop # additionally publish a NEW version for a divergent type
```
`verify` verdicts: `match`, `missing`, `diverge`, `invalid` (fail), `drift` (display text differs) and `extra`
(an Admin-added row; informational). `apply` never creates catalogs (run seeds/migrations first), never publishes a
divergent form unless its type code is named, and re-verifies afterwards. Published versions are immutable: correcting a
form means publishing a corrective version; historical revisions keep the version they were pinned to.

## 2. Rehearsal ladder (before any staging/production apply)

1. **Disposable clone** — `src/scripts/phase13-migration-rehearsal.ts` (see operations runbooks §9):
   dry-run writes nothing, a SIGKILL mid-batch leaves the ledger `running` with a checkpoint and a held lock, a second
   runner is refused, the lease expires, the run resumes from its checkpoint and every row is backfilled exactly once, a
   failing validation marks the ledger `failed` and releases the lock, re-runs are no-ops, manual migrations run in the
   documented order **024 before 035**, then manifest apply + verify and integrity.
2. **Restore drill** — `src/scripts/phase13-restore-drill.ts` (operations runbooks §10).
3. **Scale harness** — `src/scripts/phase13-scale-harness.ts` (operations runbooks §11) after any listing/index change.
4. **Staging copy** of a sanitized production-like dataset: repeat 1–2 with real volumes and record durations.

## 3. Rollout order (derived from client compatibility)

Old Flutter clients send no `formSchema=1` and only see types whose current form is legacy-writable; new clients
render FormDefinitions and treat unknown renderer versions / media profiles as unsupported. Admin only calls the backend.
Therefore: **Backend → Admin → Flutter**, and never rely on all clients updating together.

1. Backend compatible release (all new fields additive).
2. Migrations (034 is additive; 035 is manual and only after the sortable indexes are seen in use).
3. `release:manifest verify`, then `apply` if forms are missing.
4. `migration:integrity`, smoke tests (create → submit → approve → public read → auction read).
5. Admin release.
6. Flutter staged rollout. Publish a **new or narrowed** FormDefinition (new `allowedAmenityCodes`, new fields) only after
   the client version that renders it is broadly adopted; until then old clients simply do not see such types.

## 4. GO / NO-GO gates

* **Code:** clean repos; backend `typecheck`, `test`, `build`; Flutter `analyze`, `test`; Admin `typecheck`, `lint`, `test`, `build`, Playwright; no secrets; manifest self-consistent.
* **Environment:** `DEPLOYMENT_ENV`, `DB_ENV_ALLOWLIST` and the identity marker in place; `PAYMENT_PROVIDER` unset (fail closed) — payment-dependent features stay disabled until a real adapter exists; SUPER_ADMIN bootstrap only with the break-glass token, then the variables removed.
* **Database:** a pre-migration snapshot exists and its id is recorded (`MIGRATION_BACKUP_CONFIRM`); migration dry-run clean; no held lock; `migration:integrity` accepted; `release:manifest verify` ok.
* **Performance:** `phase13-scale-harness` shows no `SORT` stage on the public listing at 100k listings; auction discovery within the agreed envelope (see §6).
* **Operations:** `/health/ready` green; `GET /api/v1/admin/operations/status` has an empty `attention` list; alerts wired to the structured events in operations runbooks §1; runbooks reviewed.
* **Clients:** signed builds, HTTPS `API_BASE_URL`, compatibility window agreed (§3).

## 5. Cutover sequence

* **T-24h** verify artifacts and manifest; take and verify the snapshot; dry-run migrations on a staging clone; confirm config validation passes.
* **T-1h** pause form publishing and other sensitive Admin actions; confirm no migration lock.
* **Deploy** backend → `migration:apply` → manifest verify/apply → integrity → smoke → Admin → Flutter staged rollout.
* **After** watch `admin/operations/status` and the alerts; re-run integrity after 24 h.
* **Rollback:** application rollback is safe (migrations are additive). Data problems are remediated by a corrective form
  publish or, when the damage is broader, by restoring the recorded snapshot (rehearsed in the restore drill).

## 6. Known scaling characteristics (measured on synthetic data, disposable local MongoDB)

| Query (100k listings) | Before Phase 13 | After |
|---|---|---|
| Public listing, first page, any sort/filter | blocking `SORT` over the whole visible set (e.g. 83,797 keys, p50 74 ms, p95 315 ms) | `SORT_MERGE`, 20–120 keys, p50 ≈ 1 ms, p95 ≈ 3 ms |
| Deep page (page 50) | full scan | 1,000 keys (skip cost, linear in page depth) |
| `total` (`countDocuments`) | ~40 ms unfiltered | unchanged (~40 ms) — linear; watch at ≥ 1M listings |
| Free-text `q` (regex) | full visible scan | index-ordered scan with residual regex (~1.9k keys) |
| Auction discovery (≈2k listable auctions) | ~125 ms | unchanged — sort follows two `$lookup`s, linear in listable auctions (~60 µs each) |

The auction figure is the recommended trigger for a post-V1 denormalization of frozen classification/location onto
the auction: schedule it when listable auctions approach ~10k. 1M-listing runs were **not** performed locally; run the
harness on a staging-sized cluster. All targets are proposed engineering targets, not contractual SLAs.

## 7. Known post-V1 scaling items (single-instance V1)

The V1 backend is a **single instance**. Deliberately not addressed: shared rate limiting (the throttler is per
process), multi-instance realtime (exactly one instance may serve realtime), cursor pagination, a media-profile
registry entity, auction denormalization. `TRUST_PROXY` stays generic (state your topology explicitly).

## 8. Client readiness

* **Flutter:** `--dart-define=APP_ENV=production --dart-define=API_BASE_URL=https://…` (release builds reject `development`
  and non-HTTPS); Android needs the four `ANDROID_KEY*` signing inputs and `MAPS_API_KEY`; iOS needs `Secrets.xcconfig`
  with `MAPS_API_KEY` plus team/provisioning (not verifiable from the repository). No crash reporting and **no force-upgrade
  mechanism** exist (deferred: it needs new dependencies and UI; the backend/Flutter design is to send the app version and
  answer `426 APP_UPGRADE_REQUIRED`). App version is `1.0.0+1`.
* **Admin:** `BACKEND_API_URL` (HTTPS in production), `TRUSTED_PROXY_HOPS`, optional `CSP_*`/`HSTS_*`; deploy from branch `master`.

## 9. Open decisions (Operations / Product — not defined here)

Production backup schedule and retention, PITR, RPO, RTO; the real payment provider and its webhook verification;
hosting topology (replica count, proxy); crash-reporting/analytics vendor; the minimum supported app version policy.
