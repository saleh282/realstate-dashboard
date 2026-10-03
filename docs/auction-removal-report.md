# Auction removal report

Completed in this repository on 2026-10-03. The dependency audit was completed before edits; see [the audit](auction-removal-audit.md). NestJS remains the application architecture. Only this project was modified.

## Result and shared functionality

Auction origination/review, listings, bidding/ledger, finalization, activation, property locks, entry fees/payments/entitlements, auction notifications and WebSocket delivery are removed from the runtime module graph. Auction controllers, schemas, DTOs, services, workers, permissions, errors, events and configuration have been deleted or removed from shared components.

The property and revision schemas did not contain auction-only fields. Sale/rent operation types, prices, specifications, dynamic forms, catalog data, search/facets, public projections, moderation and property lifecycle are retained. Six auction anchoring/discovery helpers and the property lock dependency were removed; ordinary property updates and visibility changes no longer depend on auction state.

Shared payment provider/verification, managed-marketing payment initiation/confirmation, reconciliation workers, transaction retries, money utilities, clock, audit, notification inbox and transactional outbox remain. The provider port is renamed to PaymentProviderPort / PAYMENT_PROVIDER_PORT, with all retained callers updated. Existing retired inbox records are excluded from listing, unread counts and mark-read operations. KYC, property and marketing notifications and property alerts remain.

Shared partial modifications include application/bootstrap wiring, properties, payment modules/provider/lifecycle/router/reconciliation/dev tooling, authorization/audit enums, notification mapping/preferences, outbox events/routing, health/readiness, operational status/metrics, migration integrity checks, environment validation, scale/restore tooling and mixed regression fixtures/tests. The full path inventory below includes every partial modification. Authentication and user business logic are unchanged.

## Database changes and retained history

Active auction model registrations, collections/schemas, relation/projection helpers and application index declarations were removed with their owning feature. Existing MongoDB collections and data were **not** dropped or altered. No database migration was executed and no production data was accessed.

Migration bodies/IDs 036 and 037 remain frozen; registry entries are manual-only so default migration plans cannot recreate retired collections. Explicit selection still exposes their historical behavior. Historical migration 025 retains its read-only auction anchor report. New migration 038-managed-marketing-payment-indexes creates only the retained marketing payment indexes from frozen definitions. It checks conflicting definitions and duplicate unique keys before creation, validates results, and is safe to rerun. It does not depend on running retired migration 037. Payment history and migration ledger are preserved.

Destructive cleanup is deferred: existing policy retains payment history and the project has no approved retention/archive policy for retired records. An operator must define backups, archive/retention and pending payment handling before a separate reviewed cleanup migration addresses auctions, auction_requests, bids, bid_requests, auction_entry_payments, auction_bid_entitlements, realtime_cutovers, auction outbox/inbox records and notification_preferences.auctionOpportunityAlerts. Keep shared audit history and migration ledger. This is an explicit unresolved database decision, not an automatically applied cleanup.

## Actual routes removed

All HTTP routes below previously used the /api/v1 prefix:

| Method | Route |
| --- | --- |
| POST, GET | /auctions |
| GET | /auctions/mine |
| GET | /auctions/mine/:auctionId |
| POST | /auctions/mine/:auctionId/cancel |
| GET | /auctions/:auctionId |
| POST, GET | /auctions/:auctionId/bids |
| GET | /auctions/:auctionId/bid-state |
| GET | /auctions/:auctionId/outcome |
| GET | /auctions/:auctionId/entry-entitlement |
| POST | /auctions/:auctionId/entry-payment |
| POST | /auction-requests |
| GET | /auction-requests/eligible-properties |
| GET | /auction-requests/mine |
| GET, PATCH | /auction-requests/mine/:requestId |
| POST | /auction-requests/mine/:requestId/resubmit |
| POST | /auction-requests/mine/:requestId/withdraw |
| GET | /admin/auctions |
| GET | /admin/auctions/:auctionId |
| GET | /admin/auctions/:auctionId/bids |
| POST | /admin/auctions/:auctionId/cancel |
| GET | /admin/auction-requests |
| GET | /admin/auction-requests/:requestId |
| POST | /admin/auction-requests/:requestId/review |

The WebSocket /api/v1/realtime and its subscription/events protocol are removed. No Swagger installation/setup exists in this repository; controller DTOs and the endpoint policy inventory were updated directly.

## Dependencies and configuration

Removed direct dependencies @nestjs/platform-ws and @nestjs/websockets, plus development dependencies ws and @types/ws. The lockfile was refreshed; any transitively required ws remains owned by its remaining dependency. Other dependencies remain, including the existing NestJS HTTP platform adapter. Auction/realtime configuration validation, .env.example settings and realtime readiness are removed. Payment/outbox workers and their environment settings remain.

## Intentionally retained references

- Frozen migration 025 reporting and 036/037 definitions/registry history, plus their historical migration tests: preserve applied migration meaning and ledger compatibility.
- Clearly labelled historical MAZAD payment/outbox/notification records: document the original implementation without advertising current endpoints.
- Existing package/database names and Cloudinary real-estate-auction folders: preserve deployment identities, seed target protection and existing assets.
- This audit/report and removal regression assertions: explain and verify the removal.
- The word winner in payment-attempt-opening refers to the successful concurrent initiation claim, not an auction.

A final source/test/docs/config search found no active auction feature paths outside those documented historical definitions. Generic infrastructure terminology and unrelated substrings such as FORBIDDEN remain valid.

## Verification

- `npm run build`: passed (NestJS compilation).
- `npm run typecheck`: passed, including retained tests and new removal regression tests.
- `npm test -- --silent`: passed; 102 suites passed, 2 opt-in MongoDB suites skipped; 1,868 tests passed, 10 skipped, 0 failed. HTTP/in-memory coverage includes authentication/authorization, users, property creation/retrieval/editing/lifecycle, sale/rent listings, search/filter/specifications, managed marketing payments, KYC, notifications and outbox behavior.
- New regressions verify the retained module/controller graph, absence of retired feature modules/routes, retired notifications hidden from every inbox operation, default migrations excluding 036/037, marketing-only migration dry-run/apply/rerun and conflict/duplicate blockers.
- `npm run migration:list`: passed; historical 036/037 are manual-only and 038 is registered.
- `git diff --check`: passed. No lint or formatting script/config is available; imports and formatting were reviewed and TypeScript validation was run.
- Final reference search covered source, tests, docs, package/config and fixtures. No retained runtime implementation provides auction/bid routes, jobs, notifications or WebSocket behavior.
- Test environment used dummy JWT settings and a localhost MongoDB URI solely for eager configuration validation. Opt-in database tests were not enabled and no database was contacted by those suites. Database migration execution, real MongoDB E2E and production provider testing remain unverified.

## Rollout/manual steps and risks

1. Retire clients using the deleted routes, WebSocket protocol, auction preference and removed operational/readiness response fields.
2. Remove realtime/auction deployment settings and run the normal migration dry-run against a reviewed target. Apply migration 038 using the existing CLI only after reviewing preflight and backups. Do not explicitly select 036/037 for new deployments.
3. Resolve the retention/archive and outstanding auction payment decision described above before any destructive database cleanup.
4. Run opt-in real MongoDB integration/E2E suites on a disposable replica set; this environment did not have a configured disposable database. No live payment provider qualification was performed.

Recommended commit message: feat: remove auction feature

## Added files

- docs/auction-removal-audit.md
- docs/auction-removal-report.md
- src/migrations/038-managed-marketing-payment-indexes.ts
- src/payments/payment-provider.port.ts
- test/auction-removal-regression.spec.ts

## Deleted files

- `docs/MAZAD-032-realtime-auction-updates.md`
- `src/auctions/admin-auction-requests.controller.ts`
- `src/auctions/admin-auctions.controller.ts`
- `src/auctions/auction-activation-gate.ts`
- `src/auctions/auction-admin.service.ts`
- `src/auctions/auction-bid-acceptance.service.ts`
- `src/auctions/auction-bid-entitlement.port.ts`
- `src/auctions/auction-bid-existence.port.ts`
- `src/auctions/auction-bidding-read.service.ts`
- `src/auctions/auction-bids.controller.ts`
- `src/auctions/auction-finalization.service.ts`
- `src/auctions/auction-finalization.worker.ts`
- `src/auctions/auction-lifecycle.service.ts`
- `src/auctions/auction-lifecycle.worker.ts`
- `src/auctions/auction-participants.reader.ts`
- `src/auctions/auction-projections.ts`
- `src/auctions/auction-request.types.ts`
- `src/auctions/auction-requests.controller.ts`
- `src/auctions/auction-requests.service.ts`
- `src/auctions/auction-rule-snapshot.ts`
- `src/auctions/auction-transitions.ts`
- `src/auctions/auction.types.ts`
- `src/auctions/auctions-query.service.ts`
- `src/auctions/auctions.controller.ts`
- `src/auctions/auctions.module.ts`
- `src/auctions/auctions.service.ts`
- `src/auctions/dto/auction-request.dto.ts`
- `src/auctions/dto/auction-validation.pipe.ts`
- `src/auctions/dto/cancel-auction.dto.ts`
- `src/auctions/dto/create-auction.dto.ts`
- `src/auctions/dto/list-auctions.dto.ts`
- `src/auctions/dto/list-bid-history.dto.ts`
- `src/auctions/dto/parse-auction-id.pipe.ts`
- `src/auctions/dto/place-bid.dto.ts`
- `src/auctions/schemas/auction-request.schema.ts`
- `src/auctions/schemas/auction.schema.ts`
- `src/bids/bid-ledger.service.ts`
- `src/bids/bid-pricing.ts`
- `src/bids/bid-projections.ts`
- `src/bids/bids.module.ts`
- `src/bids/schemas/bid-request.schema.ts`
- `src/bids/schemas/bid.schema.ts`
- `src/common/errors/auction-error-codes.ts`
- `src/common/errors/bid-error-codes.ts`
- `src/common/errors/realtime-error-codes.ts`
- `src/payments/auction-entry-entitlement.service.ts`
- `src/payments/auction-entry-fee.service.ts`
- `src/payments/auction-entry-payment.service.ts`
- `src/payments/auction-entry-payments.controller.ts`
- `src/payments/auction-payment-confirmation.service.ts`
- `src/payments/auction-payment-provider.port.ts`
- `src/payments/dto/initiate-entry-payment.dto.ts`
- `src/payments/persistent-bid-entitlement.port.ts`
- `src/payments/schemas/auction-bid-entitlement.schema.ts`
- `src/payments/schemas/auction-entry-payment.schema.ts`
- `src/properties/property-auction-lock.service.ts`
- `src/realtime/realtime-auction-access.ts`
- `src/realtime/realtime-authenticator.ts`
- `src/realtime/realtime-client-address.ts`
- `src/realtime/realtime-cutover.service.ts`
- `src/realtime/realtime-cutover.store.ts`
- `src/realtime/realtime-events.ts`
- `src/realtime/realtime-frames.ts`
- `src/realtime/realtime-outbox.consumer.ts`
- `src/realtime/realtime.constants.ts`
- `src/realtime/realtime.gateway.ts`
- `src/realtime/realtime.hub.ts`
- `src/realtime/realtime.module.ts`
- `src/realtime/realtime.settings.ts`
- `src/realtime/schemas/realtime-cutover.schema.ts`
- `test/auction-api.spec.ts`
- `test/auction-entry-payments-http.spec.ts`
- `test/auction-finalization.spec.ts`
- `test/auction-http.spec.ts`
- `test/auction-lifecycle.spec.ts`
- `test/auction-payments.spec.ts`
- `test/auctions.spec.ts`
- `test/bid-acceptance.spec.ts`
- `test/bid-http.spec.ts`
- `test/bid-ledger.spec.ts`
- `test/bid-request-schema.spec.ts`
- `test/bid-state-history.spec.ts`
- `test/e2e/payment-lifecycle-driver.ts`
- `test/e2e/realtime-two-client-driver.ts`
- `test/mazad028-payment-e2e.spec.ts`
- `test/mazad035-auction-review.spec.ts`
- `test/mazad035-local-db.spec.ts`
- `test/outbox-domain-events.spec.ts`
- `test/property-auction-lock.spec.ts`
- `test/realtime-consumer.spec.ts`
- `test/realtime-cutover.spec.ts`
- `test/realtime-events.spec.ts`
- `test/realtime-gateway.spec.ts`
- `test/realtime-hub.spec.ts`
- `test/realtime-support.spec.ts`
- `test/support/realtime-fixtures.ts`

## Modified files

- `.env.example`
- `README.md`
- `docs/DPF-006-007-multi-type-search-rollout.md`
- `docs/MAZAD-017-retention-safe-deletion.md`
- `docs/MAZAD-019-property-lifecycle-rollout.md`
- `docs/MAZAD-028-payment-lifecycle.md`
- `docs/MAZAD-031-transactional-outbox.md`
- `docs/MAZAD-036-persistent-notifications.md`
- `docs/PHASE-13-operations-runbooks.md`
- `docs/PHASE-13-release-runbook.md`
- `docs/mazad-016-endpoint-policy-inventory.md`
- `package-lock.json`
- `package.json`
- `src/app.module.ts`
- `src/app.setup.ts`
- `src/audit/audit-log.service.ts`
- `src/audit/schemas/audit-log.schema.ts`
- `src/authorization/authorization-error-codes.ts`
- `src/authorization/authorization-policy.service.ts`
- `src/authorization/capability.ts`
- `src/common/errors/payment-error-codes.ts`
- `src/common/errors/property-error-codes.ts`
- `src/common/http/api-prefix.ts`
- `src/common/mongo/transaction-runner.ts`
- `src/common/observability/operational-metrics.ts`
- `src/common/time/clock.service.ts`
- `src/config/environment.validation.ts`
- `src/health/health.service.ts`
- `src/migrations/framework/core-migrations.ts`
- `src/migrations/integrity-checker.ts`
- `src/notifications/dto/update-notification-preferences.dto.ts`
- `src/notifications/notification-event.mapper.ts`
- `src/notifications/notification.types.ts`
- `src/notifications/notifications.service.ts`
- `src/notifications/schemas/notification-preference.schema.ts`
- `src/operations/operational-status.service.ts`
- `src/outbox/outbox-consumer.port.ts`
- `src/outbox/outbox-dispatcher.service.ts`
- `src/outbox/outbox-dispatcher.worker.ts`
- `src/outbox/outbox-events.ts`
- `src/outbox/outbox-wakeup.ts`
- `src/outbox/outbox.constants.ts`
- `src/outbox/outbox.module.ts`
- `src/outbox/outbox.service.ts`
- `src/outbox/schemas/outbox-event.schema.ts`
- `src/payments/dev/fake-payments-dev.guard.ts`
- `src/payments/dev/fake-payments-dev.service.ts`
- `src/payments/fake-payment-provider.ts`
- `src/payments/managed-marketing-payment-confirmation.service.ts`
- `src/payments/managed-marketing-payment.service.ts`
- `src/payments/payment-attempt-opening.ts`
- `src/payments/payment-confirmation-router.service.ts`
- `src/payments/payment-lifecycle.port.ts`
- `src/payments/payment-provider.factory.ts`
- `src/payments/payment-reconciliation.service.ts`
- `src/payments/payment-reconciliation.worker.ts`
- `src/payments/payment.types.ts`
- `src/payments/payments.module.ts`
- `src/payments/schemas/managed-marketing-payment.schema.ts`
- `src/properties/dto/list-published-properties.dto.ts`
- `src/properties/properties.module.ts`
- `src/properties/properties.service.ts`
- `src/scripts/phase13-restore-drill.ts`
- `src/scripts/phase13-scale-harness.ts`
- `test/authorization-endpoint-contract.spec.ts`
- `test/authorization-policy.spec.ts`
- `test/environment.validation.spec.ts`
- `test/health.spec.ts`
- `test/idempotency.spec.ts`
- `test/managed-marketing-payments.spec.ts`
- `test/mazad028-fake-payments-dev.spec.ts`
- `test/mazad028-payment-lifecycle.spec.ts`
- `test/mazad028-payment-migration.spec.ts`
- `test/notifications-routing-completion.spec.ts`
- `test/notifications.spec.ts`
- `test/outbox-dispatcher.spec.ts`
- `test/outbox-events.spec.ts`
- `test/outbox-module-wiring.spec.ts`
- `test/outbox-multi-consumer.spec.ts`
- `test/phase12-gates.spec.ts`
- `test/phase12-local-integration.spec.ts`
- `test/phase13-fake-payment-provider.spec.ts`
- `test/phase13-local-e2e.spec.ts`
- `test/phase13-observability.spec.ts`
- `test/phase9-search-facets.spec.ts`
- `test/properties.spec.ts`
- `test/property-approval-sync-and-public-projection.spec.ts`
- `test/property-dynamic-form-submit-approval.spec.ts`
- `test/property-form-foundation-migrations.spec.ts`
- `test/property-multi-type-classification.spec.ts`
- `test/property-multi-type-completion.spec.ts`
- `test/property-photo-slot-error-details.spec.ts`
- `test/property-search.spec.ts`
- `test/property-specifications.spec.ts`
- `test/support/fake-outbox.ts`
- `test/support/fake-payments-mongo.ts`
- `test/support/property-world.ts`
