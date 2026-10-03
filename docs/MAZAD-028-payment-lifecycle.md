# MAZAD-028 — Payment lifecycle, confirmation and reconciliation

> Historical implementation/qualification record. Auction functionality and related contracts described here were removed on 2026-10-03. For current scope and migration guidance, see [auction removal report](auction-removal-report.md). Only the retained managed-marketing, KYC, property, notification and outbox behavior applies.

Provider-neutral. No real payment gateway is selected or integrated; the only bindable providers are
`none` (fail closed, the production default) and `fake` (local/development/test only).

> **Legal gate.** Anything about refunds, "non-refundable" wording or other legal obligations is **pending legal
> review**. This implementation performs no refund and implies none; it records facts and flags cases for an operator.

## State machine (both purposes)

```
INITIATED ──(provider-verified success)──▶ SUCCEEDED   terminal
    │
    ├───────(provider-verified failure)──▶ FAILED      terminal, live slot released
    │
    └───────(lifetime elapsed AND a final verification still PENDING)──▶ EXPIRED   terminal, live slot released
```

* Only server code moves an attempt, and only from an outcome it obtained itself from the provider port. No route accepts
  an outcome, an amount or a status from a client.
* `FAILED` and `EXPIRED` allow a new attempt. There is no retry cap. One live attempt per (auction, bidder) / per request.
* `EXPIRED` rows are kept forever (history/audit). There is **no TTL index**.
* A provider success observed for a `FAILED` or `EXPIRED` attempt is **not** a transition: the row gets
  `reconciliationFlag` (`CONFIRMED_AFTER_FAILURE` / `CONFIRMED_AFTER_EXPIRY`), nothing is granted, and the customer is
  blocked from a further attempt until an operator reconciles (so a second charge is never the default).
* Client contract: the entitlement read keeps the wire state `PAYMENT_FAILED` for an expired attempt (older app builds
  reject unknown states) and exposes `payment.status = "EXPIRED"` and `payment.expiredAt`.

## Authoritative confirmation

`confirm(paymentId)` of each purpose's confirmation service is the only path to `SUCCEEDED`. It calls
`provider.verify(reference)` server-to-server, checks reference/currency/amount against the server-owned row, and applies
payment + fulfilment (auction entitlement, or request `PAID`) + audit + outbox event in **one transaction**.

A *trigger* only names a payment:

| Trigger | Entry point |
|---|---|
| Reconciliation worker | `PaymentReconciliationService.reconcileDue` → `confirm(paymentId)` |
| Future provider callback (not built) | signed-webhook adapter → `PaymentConfirmationRouter.confirmByProviderReference(provider, reference)` |
| Development settle route (`trigger: true`) | the same `confirmByProviderReference` |

`confirmByProviderReference` resolves the owning purpose through the unique `(provider, providerReference)` index and
routes to that purpose's service. **No public real-provider webhook route exists yet**; it belongs to the provider
integration ticket (raw-body signature verification lives in the adapter, replays are harmless because the callback
carries no authority).

## Initiation: one provider order per attempt

The attempt row is the serialisation point. The request that creates the row holds `initiationClaimedAt`; a concurrent
request that finds the reference-less row must win that claim by compare-and-set before calling the provider, otherwise
it waits briefly for the stored reference or answers `409 PAYMENT_INITIATION_IN_PROGRESS`. The provider's reference is
returned **only after it was persisted**; a request whose persisting compare-and-set did not match re-reads the row and
returns the stored reference. The provider's opaque `clientHandoff` is stored with the attempt (presentation only, never
read by confirmation) so the same live attempt can be handed back after a lost response or an app restart.

## Reconciliation worker

`PaymentReconciliationWorker` (same shape as the auction lifecycle worker) covers `AUCTION_ENTRY` and
`MANAGED_MARKETING`.

* **Scan:** `status = INITIATED`, no reconciliation flag, `nextVerifyAt <= now` (rows written before this ticket have no
  `nextVerifyAt` and are treated as due), oldest due first, bounded batch per purpose.
* **Claim / lease:** one atomic `findOneAndUpdate` pushes `nextVerifyAt` a lease into the future
  (`PAYMENT_RECONCILIATION_LEASE_SECONDS`, default 60). Any number of instances may run the same tick. A crashed
  claimant loses nothing: nothing is recorded before the confirmation transaction commits, the lease lapses, the attempt
  is due again.
* **Backoff:** still pending / provider error → `nextVerifyAt = now + step` (15s, 30s, 1m, 2m, then 5m), never past the
  attempt's expiry instant.
* **Expiry:** past `PAYMENT_ATTEMPT_TTL_SECONDS` the same pass verifies once more; success and failure take their
  normal paths, and only a still-`PENDING` answer expires the attempt. A provider outage never expires anything.
* **Abandoned attempts:** an `INITIATED` row that never received a provider reference is failed
  (`PROVIDER_INITIATION_ABANDONED`) after a 5-minute technical grace — no hand-off ever reached a client.
* **Idle states:** with no provider bound the worker touches nothing. In staging/production with a provider but no
  explicit lifetime it refuses to run (and startup refuses `PAYMENT_RECONCILIATION_WORKER_ENABLED=true` without it).

### Expiry duration — PRODUCT_DECISION

There is **no production default**. `PAYMENT_ATTEMPT_TTL_SECONDS` must be chosen when a real provider is selected and
must not be shorter than that provider's own checkout-session lifetime. Local/development fall back to 900 seconds, a
development value for the fake provider only.

## Late outcomes

| Situation | Result |
|---|---|
| Provider success after local expiry | `EXPIRED` + `CONFIRMED_AFTER_EXPIRY`, provider event id kept, audit row, **no entitlement / no PAID**, operator review |
| Provider success after the auction was cancelled / ended | truthful `SUCCEEDED` kept, `lateConfirmation: true` on the row, audit and event marked late; the entitlement is inert (bidding requires ACTIVE) |
| Auction cancelled while an attempt is pending | the pending payer is included in the private cancellation notification (which states the cancellation only) |

No refund is performed or implied in any of these.

**Decision (confirmed at the MAZAD-028 checkpoint).** For a success observed after the auction was cancelled or ended,
the payment stays truthfully `SUCCEEDED` **and the entitlement row is kept** for audit/history. It is unusable: every bid
re-checks that the auction is ACTIVE and before its end. No refund behaviour exists; refund policy is still pending
legal/product decisions.

## Development: FakePaymentProvider

Scenarios `success | failed | pending | error` (`FAKE_PAYMENT_SCENARIO`). With the worker running, `success` and `failed`
complete on their own. To finish a `pending` checkout:

```
POST /api/v1/dev/fake-payments/:paymentId/settle
Authorization: Bearer <the payment owner's access token>
{ "outcome": "success" | "failed", "trigger": false }
```

* Changes the fake provider's truth **only**. It never writes a payment, entitlement or request; the worker (or
  `trigger: true`, which calls the normal confirmation-by-reference path) then applies it through the domain rules.
* Authenticated and owner-scoped.
* Returns 404 — before authentication — unless the bound provider is a `FakePaymentProvider` in a local/development
  process. Staging/production cannot even build the fake provider (environment validation and the provider factory).
* Settlements live in process memory: after a restart an unsettled pending payment stays pending until it expires.

## Managed marketing (backend)

`POST /api/v1/managed-marketing/requests/:requestId/payment` (empty body, the request's own advertiser). The amount is the
request's immutable package snapshot price. The shared worker confirms and expires; expiry returns the request to
`paymentStatus: FAILED` (payable and cancellable). The app UI for this payment is not part of this ticket.

## Operations

`GET` admin operations status → `payments: { pending, due, stale, expired, flagged, confirmedAfterExpiry, lateConfirmed }`
(counts across both purposes; no references, amounts or accounts). Attention items:
`payments_reconciliation_required`, `payments_late_confirmed`, `payments_stale`.

### Manual resolution (no Admin tooling yet)

Flagged attempts (`reconciliationFlag` set) and late confirmations need an operator. There is **no** Admin action and no
automatic path: the flag is never cleared by code, and no code path grants an entitlement or marks a request paid outside
a verified confirmation. Until the Admin reconciliation ticket exists:

1. Identify the rows: `reconciliationFlag: { $exists: true }` / `lateConfirmation: true` in `auction_entry_payments`,
   `managed_marketing_payments`; the `auction_entry_payment_rejected` / `managed_marketing_payment_rejected` audit rows
   carry the expected and reported scalars.
2. Verify the payment with the provider's own back office.
3. Decide with product/legal (refund policy is not defined). Any data correction is a reviewed, recorded manual change.

## Migration

`037-mazad028-payment-lifecycle-indexes` — additive index creation only (no document rewrite, no backfill, no TTL). It
also makes the critical unique payment/entitlement indexes explicit migration state (previously they existed only where
Mongoose `autoIndex` had built them). Preflight blocks on a same-name index with different safety options and on existing
documents that violate a unique index still to be built. Run `npm run migration:check` then `npm run migration:apply`.

## Local E2E

```bash
MAZAD028_LOCAL_E2E=1 NODE_ENV=development DEPLOYMENT_ENV=local \
MONGO_URI='mongodb://127.0.0.1:<port>/mazad_phase13_<name>?replicaSet=<rs>' npx jest test/mazad028-payment-e2e.spec.ts
```

Disposable loopback replica set only (built by `phase13-migration-rehearsal.ts`, freshly for each qualification run). Real
HTTP, the live worker on 1-second intervals, the real WebSocket gateway.

The live Flutter half (the production app data layer against the same real backend):

```bash
# backend: boots the app with the fake provider, the live worker and a 12-second TEST attempt lifetime
DEPLOYMENT_ENV=local NODE_ENV=development MONGO_URI='mongodb://127.0.0.1:<port>/mazad_phase13_<name>?replicaSet=<rs>' \
npx ts-node test/e2e/payment-lifecycle-driver.ts --port=39970 --fixture=<dir>/fixture.json --workdir=<empty dir without .env>
# app repo
MAZAD_PAY_E2E_FIXTURE=<dir>/fixture.json flutter test test/e2e/payment_lifecycle_e2e_test.dart
```

The app code never learns about the fake provider: the test itself plays "the customer completed the checkout" through
the development settle route, and the app observes the outcome only by reading the entitlement state.

## Known issues / follow-ups

* **Realtime two-client Flutter E2E — one unexplained failure.** During MAZAD-028 qualification the pre-existing
  `test/e2e/realtime_two_client_e2e_test.dart` (app repo) failed its first test once, in its first 30-second wait, and then
  passed on three consecutive reruns. The output of the failing run was not captured and the failure was not reproduced.
  MAZAD-028 changed `AuctionParticipantsReader.forCancellation` (pending payers are now notified), which that test's
  cancellation step exercises, so the change is **not ruled out**. No speculative fix was made. Follow-up: rerun the suite
  repeatedly with its output saved and, if it recurs, capture the driver log and the failing wait.
* Flagged (`reconciliationFlag`) and late-confirmed payments have no Admin resolution tooling yet (manual procedure above);
  their operational attention items stay raised until an operator acts.
* A provider success after local expiry is observed only when something triggers a verification (a future provider
  callback, or the development trigger); the worker does not keep polling expired attempts.
* Managed marketing: if an expired attempt is flagged while a newer attempt is live, the newer attempt cannot complete until
  an operator intervenes.
* The production attempt lifetime (`PAYMENT_ATTEMPT_TTL_SECONDS`) must be chosen with the real provider.
* Not built (separate tickets): real payment gateway, public provider webhook route, refunds, Admin reconciliation
  tooling, managed-marketing payment UI in the app.
