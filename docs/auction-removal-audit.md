# Auction dependency audit

Completed before implementation on 2026-10-03. Scope: this NestJS repository only. The working tree was clean. No AGENTS.md was found in the repository or its ancestor directories.

## Classification

| Component | Classification | Action |
| --- | --- | --- |
| `src/auctions`, `src/bids` | Auction-only: origination/review, discovery, bidding/ledger, lifecycle/finalization workers, schemas, DTOs, controllers | Remove |
| `src/realtime` | Auction-only gateway, rooms, access checks, cutover and outbox consumer; no non-auction subscriptions exist | Remove, including WebSocket bootstrap and dependencies |
| Property auction lock and six auction anchoring/discovery helpers | Auction-only; usage traced in source and tests | Remove; retain ordinary public projections and specifications |
| Property/revision schemas, sale/rent operation types, prices, facets, catalogs, search, moderation, media | Required by property listings | Preserve |
| Auction-entry payment/fee/entitlement services, schemas, controller and DTO | Auction-only | Remove |
| Provider port, fake provider, payment verification, lifecycle, reconciliation and development settlement | Shared with managed marketing | Preserve; rename provider port to remove auction terminology; remove entry-payment purpose and routing |
| Outbox and transactional runner, money, clock, audit infrastructure | Shared with property/KYC/managed marketing/notifications | Preserve; remove auction event builders, routing keys and audit actions |
| Authorization capabilities/policy | Shared | Remove only auction/bidding/entry-payment capabilities |
| Notifications/inbox/preferences | Shared with KYC/property/marketing | Remove auction mappings, types and preference; exclude retired notifications from inbox reads/counts/updates |
| Health/operations/environment | Shared | Remove auction workers, readiness and counters; retain Mongo health, cleanup, payment reconciliation and deployment protection |
| Scale/restore harnesses and mixed tests | Shared | Remove auction scenarios, retain non-auction checks |
| Migration 036 and mixed migration 037 | Historical, frozen by the migration policy | Preserve bodies and IDs; mark manual-only, add independent marketing-only index migration |
| Integrity checker | Shared | Remove auction checks |
| Cloudinary folder names, existing database/package identifiers | Required by existing deployments/assets | Preserve names to avoid unrelated storage or identity changes |

## Routes

All controller routes under `/api/v1/auctions`, `/api/v1/auction-requests`, `/api/v1/admin/auctions`, and `/api/v1/admin/auction-requests` are auction-only, including bid-state, outcome, bid history, entry-entitlement and entry-payment. The WebSocket `/api/v1/realtime` is auction-only. No Swagger package or Swagger setup is present.

## Dependencies

`@nestjs/platform-ws`, `@nestjs/websockets`, development `ws`, and `@types/ws` serve only the auction realtime channel/tests. All other dependencies remain required by retained features. NestJS and its existing platform adapter remain unchanged.

## Database decision

The migration CLI is separate from application startup and defaults to dry-run. Its policy forbids changing the meaning of applied migrations. Payment migration documentation explicitly retains payment history forever. No retention/archive decision exists for auction payments, bids, requests, audit rows or related outbox/notification records. Consequently, destructive collection/data cleanup is deferred rather than guessed. No database connection or production-data mutation is authorized as part of this implementation. Existing records remain inert; active auction schemas and application registrations are removed. Historical migrations remain available only by explicit selection, with their original behavior intact.

An operator must decide retention and backups before a separate, reviewed cleanup migration removes `auctions`, `auction_requests`, `bids`, `bid_requests`, `auction_entry_payments`, `auction_bid_entitlements`, `realtime_cutovers`, auction outbox/inbox rows, and `notification_preferences.auctionOpportunityAlerts`. Migration ledger and shared audit history must be preserved.
