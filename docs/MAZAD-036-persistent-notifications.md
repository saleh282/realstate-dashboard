# MAZAD-036 — Persistent notifications backend foundation

## Scope

Backend-only durable inbox foundation on top of the MAZAD-031 multi-consumer
outbox. It does not add Flutter/Admin UI, broker interests, push tokens, FCM,
APNs, email or SMS delivery.

## Durable records

### `notifications`

One immutable inbox row per recipient and mapped source fact. Customer APIs may
change only `readAt`.

- `recipientAccountId`
- versioned `type` + `schemaVersion`
- internal `sourceEventId`, `aggregateType`, `aggregateId`
- fixed server-owned `title` and `message`
- `required`
- closed `target: { type, id }`
- `createdAt`, optional `readAt`

The unique index `(sourceEventId, recipientAccountId, type)` is the durable
idempotency boundary. The API deliberately omits recipient ids, source event
ids, aggregate metadata and outbox `privateRouting`.

### `notification_deliveries`

Provider-neutral delivery ledger. V1 records only `IN_APP / DELIVERED`, meaning
the durable inbox row was persisted. It must not be interpreted as push, email
or SMS delivery. `(notificationId, channel)` is unique.

### `notification_preferences`

Required transactional notifications are always written to the inbox and are
not disableable. The V1 optional broker-opportunity modes are:

- `newPropertyAlerts`: `IMMEDIATE | OFF`
- `auctionOpportunityAlerts`: `IMMEDIATE | OFF`

Defaults are `IMMEDIATE`. `DAILY_DIGEST` is post-V1. MAZAD-036A owns matching
interests and creation of those opportunity notifications; this task only
freezes the preference persistence/API contract.

## Outbox consumer

Stable name: `notifications`. It is always configured and has delivery progress
that is independent from `realtime`.

Subscribed mappings supported by current private routing:

| Outbox event | Recipient | Inbox type | Target |
| --- | --- | --- | --- |
| `AUCTION_ACTIVATED` | `privateRouting.advertiserAccountId` | `AUCTION_STARTED` | auction |
| `AUCTION_CANCELLED` | `privateRouting.advertiserAccountId` | `AUCTION_CANCELLED` | auction |
| `BID_ACCEPTED` | `privateRouting.previousHighestBidderAccountId` when different from the new bidder | `OUTBID` | auction |
| `AUCTION_FINALIZED` | `privateRouting.winnerAccountId` | `AUCTION_WON` | auction |
| `AUCTION_FINALIZED` | each unique `privateRouting.losingBidderAccountIds`, excluding the winner | `AUCTION_LOST` | auction |
| `AUCTION_ENTRY_PAYMENT_CONFIRMED` | `privateRouting.bidderAccountId` | `AUCTION_ENTRY_PAYMENT_CONFIRMED` | auction |
| `MANAGED_MARKETING_PAYMENT_CONFIRMED` | `privateRouting.advertiserAccountId` | `MANAGED_MARKETING_PAYMENT_CONFIRMED` | managed-marketing request |
| `KYC_APPROVED` / `KYC_REJECTED` | `privateRouting.subjectAccountId` | matching KYC decision | KYC/account |
| `PROPERTY_APPROVED` / `PROPERTY_REJECTED` | `privateRouting.advertiserAccountId` | matching property decision | property |

The notification row and its IN_APP delivery row are upserted in one Mongo
transaction. Duplicate delivery, process restart, an acknowledgement loss and
concurrent delivery converge through unique indexes. Malformed/unsupported
event contracts dead-letter for this consumer; transient database failures are
thrown so the outbox retries.

Every recipient above is captured from authoritative state inside the same
transaction as the domain transition. Account ids remain exclusively in
`privateRouting`; realtime/public payloads are unchanged. Auction cancellation
reasons and KYC/property rejection reasons are intentionally absent from the
generic notification event/message and remain in their protected domain/audit
records. Historical outbox rows created before recipient-routing fields existed
are acknowledged without fabricating recipients.

## HTTP API

All routes are JWT-authenticated and derive the recipient from `req.user.userId`.
No route accepts `recipientAccountId`.

- `GET /api/v1/notifications?page=1&limit=20&unread=true|false`
- `GET /api/v1/notifications/unread-count`
- `PATCH /api/v1/notifications/:notificationId/read`
- `PATCH /api/v1/notifications/read-all`
- `GET /api/v1/notifications/preferences`
- `PATCH /api/v1/notifications/preferences`

Lists are newest-first, page size is capped at 50 and page number at 10,000, and account ownership is in
every read/update filter. Cross-account ids return the same not-found result as
missing ids. Mark-one and mark-all are idempotent. The first `readAt` value is
preserved.

Stable error codes:

- `NOTIFICATION_ID_INVALID`
- `NOTIFICATION_NOT_FOUND`
- `NOTIFICATION_QUERY_INVALID`
- `NOTIFICATION_PREFERENCE_INVALID`

The global MAZAD response/error envelope and `requestId` behavior are unchanged.

## Account status and retention

The existing JWT database-state check remains authoritative: ACTIVE and
SUSPENDED accounts can authenticate/read; BLOCKED, PERMANENTLY_BANNED,
DELETION_PENDING and ANONYMIZED accounts cannot use the inbox API. Restoring an
account does not alter its inbox.

Account anonymization keeps the user document under its stable id. Notification
content contains no contact/identity PII and is not cascade-deleted. No legal
retention duration or final purge behavior is invented. The final retention and
purge policy remains a production/legal gate alongside MAZAD-017.

## Required vs optional

Every mapped notification above is `required: true` and is always written; no
preference field can suppress one. Only the two optional broker-opportunity
modes are preferences (their notifications belong to MAZAD-036A). Outbid
routing is captured inside the bid-acceptance transaction from the ledger state
read after the auction compare-and-set (`privateRouting.previousHighestBidderAccountId`,
omitted for a first bid or when the same account raises its own bid).

## Production qualification still required

Do not point tests at Atlas merely to close these items. Before production,
qualify on a disposable replica set:

1. all three indexes exist and are used by expected query plans;
2. concurrent duplicate delivery produces one notification and one delivery;
3. a transaction rollback cannot leave only one of those records;
4. `realtime` and `notifications` progress independently on the same outbox row;
5. recipient/newest and recipient/unread query plans remain indexed at expected
   data volume;
6. outbid routing under real concurrent bidding, and the KYC/property outbox
   transactions, on a real replica set.

No destructive migration or retention worker is part of MAZAD-036.
