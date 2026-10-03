# MAZAD-031 — Transactional outbox & reliable domain-event dispatch

> Historical implementation/qualification record. Auction functionality and related contracts described here were removed on 2026-10-03. For current scope and migration guidance, see [auction removal report](auction-removal-report.md). Only the retained managed-marketing, KYC, property, notification and outbox behavior applies.

Foundation only. No WebSocket/SSE, no notifications, no HTTP surface. MAZAD-032
(realtime) and MAZAD-036 (notifications) plug in as independent consumers, each with its own delivery progress.

## The invariant

> If a business transaction commits, its required domain event is durably in
> `outbox_events`, written in the **same** Mongo transaction. If it aborts,
> no event exists.

`OutboxService.recordRequired(draft, session)` is the only writer. It refuses to
run without a transactional session and is never best-effort: a failing insert
(or a contract violation) aborts the business transaction.

## Events (all `schemaVersion` 1)

| Event | Emitted by | Aggregate | Audience |
|---|---|---|---|
| `AUCTION_ACTIVATED` | lifecycle worker, SCHEDULED → ACTIVE | AUCTION | PUBLIC |
| `AUCTION_END_EXTENDED` | anti-sniping write (`extendIfWithinAntiSnipingWindow`) | AUCTION | PUBLIC |
| `BID_ACCEPTED` | bid acceptance transaction | AUCTION | PUBLIC (+ private routing) |
| `AUCTION_ENDED_NO_BIDS` | lifecycle worker, ACTIVE → ENDED_NO_BIDS | AUCTION | PUBLIC |
| `AUCTION_ENDED_PENDING_CLOSE` | lifecycle worker, ACTIVE → ENDED_PENDING_CLOSE | AUCTION | PUBLIC |
| `AUCTION_CANCELLED` | `AuctionLifecycleService.cancel` | AUCTION | PUBLIC |
| `AUCTION_FINALIZED` | finalization, ENDED_PENDING_CLOSE → COMPLETED | AUCTION | PUBLIC (+ private routing) |
| `AUCTION_ENTRY_PAYMENT_CONFIRMED` | verified AUCTION_ENTRY payment success | AUCTION_ENTRY_PAYMENT | PRIVATE |
| `MANAGED_MARKETING_PAYMENT_CONFIRMED` | verified MANAGED_MARKETING payment success | MANAGED_MARKETING_REQUEST | PRIVATE |

`status` values use the same vocabulary as the HTTP API (`active`, `ended_pending_close`, …).
Payloads hold identifiers, statuses, integer minor-unit amounts and ISO-8601 UTC times only.
Account ids are never in `payload`; the few that private consumers need are in
`privateRouting` (`bidderAccountId`, `winnerAccountId`, `advertiserAccountId`).
The cancellation reason (free text) is deliberately not carried. `PUBLIC` does **not**
mean "broadcast unconditionally": consumers must apply the same visibility gate as the
HTTP read APIs (COMPLETED auctions are not in the public visibility set today).

Within one bid transaction the order is `AUCTION_END_EXTENDED` (if the bid was inside the
anti-sniping window) then `BID_ACCEPTED`; `BID_ACCEPTED.extended/currentEndAt/previousEndAt`
repeat the outcome so a consumer needs only one of them.

## Consumers and delivery state (multi-consumer model)

One immutable event, **independent delivery progress per consumer**. `outbox_events`
holds each event once, written by the business transaction. Each consumer's progress
lives on that same document under `delivery.<consumerName>` (`status`, `attemptCount`,
`nextAttemptAt` = retry time or lease expiry, `claimedBy`, `leaseToken`, `processedAt`,
`deadLetteredAt`, `lastErrorClass`, `lastErrorName`). So `realtime: PROCESSED` with
`notifications: PENDING` (or retrying, or DEAD_LETTER) is an ordinary state, and a
consumer only ever writes its own `delivery.<its name>.*`, always through a conditional
(status + lease token) write. No delivery field exists at the top level and the payload is
never copied per consumer.

**The obligation is derived, not created.** The producing transaction writes no delivery
state and knows no consumer. An event is owed to a consumer while its type is one the
consumer subscribes to and `delivery.<name>` is absent (never touched) or unfinished
(PENDING/PROCESSING). "Absent" is PENDING and due now. So there is no cursor, no lag
window and no backfill job: nothing committed can be silently skipped, and no business
transaction or existing consumer changes when a consumer is added.

**Registration.** A consumer implements `OutboxEventConsumer` (`name`, `subscribedTypes`,
`configured`, `deliver`) and registers itself with the exported `OutboxConsumerRegistry`
from its own module's `onModuleInit` (`registry.register(consumer)`). The registry is
empty today. Names must match `^[a-z][a-z0-9_]{1,39}$` (they become a Mongo field name and
an index name), are permanent (renaming creates a new consumer that re-receives history) and
must be unique. `OutboxDispatcherService.dispatchConsumer(name)` serves one consumer;
`OutboxDispatcherWorker` runs a pass for every registered, configured consumer each tick,
each with its own in-flight guard, so a slow consumer only delays itself.

**Late-added consumers** discover existing events by the same rule: every committed event of
a subscribed type with no `delivery.<name>` is owed, including all history from before the
consumer existed, delivered in per-aggregate version order. A consumer that does not want
old events acknowledges and ignores them (e.g. by `occurredAt`). When a consumer first
dispatches it ensures its own scan index `outbox_delivery_scan_<name>` =
`{type, delivery.<name>.status, delivery.<name>.nextAttemptAt, _id}` (idempotent; a failed
build is retried and never stops delivery). Changing a consumer's subscribed types needs no
migration: added types are simply owed, removed types are no longer scanned or blocking.

**A consumer that does not subscribe to a type** never receives it, is never held back by it
(the ordering gate ignores unsubscribed types) and never blocks anyone else.

## Delivery semantics: at-least-once, per consumer

The outbox guarantees: no event before its transaction commits; a committed event is
durable; an event a consumer has not acknowledged is retried **for that consumer**. It does
**not** guarantee exactly-once. A worker that dies after the consumer succeeded but before the
PROCESSED marker is stored, a consumer timeout that hid a success, or a lease that expires
under a slow consumer all redeliver. **Every consumer must deduplicate by `eventId`** (and
may ignore any `aggregateVersion` it has already applied).

## Ordering

`aggregateVersion` is a dense, 1-based counter per `(aggregateType, aggregateId)`, assigned
inside the producing transaction after the aggregate's own document was written (the
serialisation point) and protected by a unique index. Guarantee, **per consumer**: for one
aggregate, that consumer's deliveries **start** in version order, and version N+1 is not
started before N (of a type the consumer subscribes to) is PROCESSED or DEAD_LETTERED
**for that consumer**. Different consumers may be at different versions of the same
aggregate; one being ahead, behind or dead-lettered never alters another's gate. There is no
ordering across aggregates and no global sequence (that would serialise every business
transaction). Duplicates from redelivery can still arrive after a newer version; dedupe by
`eventId`.

## Dispatcher (`OutboxDispatcherService.dispatchConsumer`)

Scan the events owed to the consumer (never touched, plus retryable: status PENDING/PROCESSING
with `nextAttemptAt ≤ now`; subscribed types only; ordered by `(due time, _id)`, bounded;
aggregates found blocked are excluded from up to three follow-up scans so a stuck aggregate
cannot starve newer ones) → group by aggregate → walk versions in order, skipping any whose
predecessor is unfinished for this consumer → **claim** with one conditional
`findOneAndUpdate` on `delivery.<name>` (status PROCESSING, random `leaseToken`,
`nextAttemptAt = now + lease`, `attemptCount + 1`) → deliver with a timeout strictly below the
lease → **acknowledge** with a write conditional on `{delivery.<name>.status: PROCESSING,
delivery.<name>.leaseToken}`. No process-local lock participates in correctness.

* **No consumer registered / switched off** (the state until MAZAD-032/036): the pass returns
  immediately, no database access, events stay durable and nothing is marked delivered.
* **Lease recovery** (per consumer): `nextAttemptAt` doubles as the lease expiry, so an
  abandoned claim is simply due again — no reaper. A delivery claimed more times than
  `OUTBOX_MAX_ATTEMPTS` without ever being acknowledged (a crash loop) is dead-lettered
  without another attempt.
* **Retries** (per consumer): transient failure → PENDING with `min(cap, base·2^(attempt-1)) ×
  [0.8, 1.0]` (defaults 2 s base, 600 s cap, 12 attempts ≈ 30–37 min of backoff).
  `OutboxPermanentDeliveryError` → DEAD_LETTER immediately. A failing head holds back only
  its own aggregate, for its own consumer.
* **DEAD_LETTER** is per consumer and a parking state: the event and every other consumer's
  delivery are untouched; the delivery is inspectable (`lastErrorClass` from a closed set,
  `lastErrorName`, `attemptCount`, `deadLetteredAt`); the log line carries the consumer name,
  identifiers and classification only. Nothing re-opens or deletes it.

Configuration (all optional, shared by every consumer): `OUTBOX_DISPATCHER_ENABLED`,
`_INTERVAL_SECONDS` (5, min 1), `_BATCH_SIZE` (100, max 500), `OUTBOX_LEASE_SECONDS` (60),
`OUTBOX_CONSUMER_TIMEOUT_SECONDS` (15, ≤ lease/2), `OUTBOX_MAX_ATTEMPTS` (12),
`OUTBOX_RETRY_BASE_SECONDS` (2), `OUTBOX_RETRY_MAX_SECONDS` (600).

## Retention

No TTL: nothing may delete an event that any consumer still owes or dead-lettered. PROCESSED
events are kept until an explicit, operator-approved archival job exists (the product has not
chosen a window — deferred). An event may only be archived once every registered consumer
that subscribes to it has a terminal delivery; DEAD_LETTER deliveries are never deleted
automatically.

## Known limits / follow-ups

* Lifecycle-worker audit rows (activation/expiry) remain best-effort telemetry written
  after the transition commits (unchanged MAZAD-024 behaviour); the event itself is
  transactional. Making that audit in-transaction is a separate decision.
* Operator alerting for DEAD_LETTER / a growing PENDING backlog (per consumer) needs
  monitoring wiring. Redriving a DEAD_LETTER delivery is a manual operator action (no tool yet).
* Per-consumer delivery tuning (lease/attempts/backoff) is global today; a consumer that
  needs different values can be given per-consumer settings later.
* Real-Mongo qualification (transactional insert with business writes, multi-instance
  claiming per consumer, lease-expiry races, WriteConflict, the unique index, snapshot +
  majority, crash redelivery, and the query plans of the per-consumer scan index — `null`
  matching an absent `delivery.<name>.status`, `$in` on `type` with the `(nextAttemptAt, _id)`
  sort) has not been run: only an in-memory model of MongoDB was available.
