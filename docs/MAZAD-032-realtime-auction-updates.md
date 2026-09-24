# MAZAD-032 — Realtime auction updates over WebSocket

Backend only. The socket carries **increments**; HTTP stays the source of truth.

```
authoritative transaction ─▶ transactional OutboxEvent (MAZAD-031)
                          ─▶ `realtime` outbox consumer ─▶ RealtimeHub (rooms) ─▶ WebSocket clients
```

The WebSocket is never authoritative. A client always loads state over HTTP
first, and re-reads it after any reconnect, gap or doubt. There is no
replay-every-missed-packet protocol and no second copy of auction state.

## Deployment topology — READ THIS FIRST (single instance)

**Fan-out works inside ONE backend process. Cross-instance fan-out is NOT solved.**

- The room registry (`RealtimeHub`) is in-process memory.
- The MAZAD-031 outbox gives each event to exactly **one** claimant of the
  `realtime` consumer (per-consumer, lease-protected claim). It is not a broadcast.
- So with several realtime-enabled replicas, an event is consumed by one of
  them and only that process's sockets see it. Clients connected elsewhere
  **silently miss it** (they recover only when they resync).

What the code does about it (correctness first, no broker invented):

1. Realtime is **OFF by default** (`REALTIME_ENABLED`, opt-in). While off, the
   `realtime` consumer is *not configured*: the dispatcher skips it (nothing is
   claimed or marked), the gateway closes any socket with `4503`, and events stay
   in the outbox. A replica that serves no sockets therefore never steals events.
   (What happens to those events on the FIRST enable is decided by the activation
   cutover — see "First enablement".)
2. Enable it on **exactly one** instance and route WebSocket traffic
   (`/api/v1/realtime`) to it. Every other replica keeps `REALTIME_ENABLED=false`.
3. **Production refuses to start** with `REALTIME_ENABLED=true` unless
   `REALTIME_TOPOLOGY=single_instance` is declared (`environment.validation.ts`).
   `single_instance` is the only accepted value until a shared adapter exists.

The code cannot detect a second realtime-enabled replica; that is an operator
guarantee. **Release-qualification / distributed-runtime item:** shared
pub/sub fan-out (so any replica can consume and every replica can serve), or a
single-active-instance election, is deferred to the deployment/runtime work.
No Redis/Kafka/RabbitMQ was added — there is no existing architectural
justification for one.

## Transport

`@nestjs/websockets` + `@nestjs/platform-ws` (the standard NestJS integration)
on `ws`, i.e. a **plain WebSocket** any client library can speak (Flutter's
`web_socket_channel` needs nothing special). Chosen over Socket.IO because it is
the smaller, standard protocol; rooms are trivial to own in-process, and a
Socket.IO client would have been an extra client-side dependency for no need here.

- Endpoint: `GET /api/v1/realtime` (WebSocket upgrade), installed by
  `configureApp` (`app.useWebSocketAdapter(new WsAdapter(app))`).
- Packages added: `@nestjs/websockets@^10.4.22`, `@nestjs/platform-ws@^10.4.22`
  (dependencies); `@types/ws`, `ws@8.18.0` (devDependencies — `src` imports only
  `ws` *types*; the runtime `ws` is the copy `platform-ws` pins, deduplicated).
- The gateway parses frames itself (Nest's `@SubscribeMessage` routing swallows
  unparseable frames silently and has no size/rate hook), so every malformed
  input gets a stable error frame.

## Client protocol

Messages are JSON text frames. Binary frames are rejected.

### Connect

Optional `Authorization: Bearer <access token>` header on the upgrade request
(mobile/native clients; browsers cannot set it and connect as guests). A token in
the URL is deliberately **not** supported (URLs are logged).

- No header → **guest**. Guests may watch publicly visible auctions: login is
  never required to watch what the HTTP API already shows the public.
- A header that is present but unacceptable → the socket is closed with `4401`
  (never silently downgraded to guest, matching `OptionalJwtAuthGuard`). The
  check is the real `JwtStrategy.validate`: access-token type, live session,
  and account status (blocked / banned / deletion-pending / anonymised refused).
- A dependency failure during the check → `1013` (retry), *not* `4401`, so a
  client does not discard a good token.

Identity changes **nothing a client can observe** today: every frame is public
auction state, identical for guests and users. The principal is established at
connect time and not re-validated while the socket stays open. Any future
private channel must re-validate.

First server frame:

```json
{ "type": "ready", "protocolVersion": 1, "serverTime": "…", "authenticated": false,
  "limits": { "maxSubscriptions": 50, "maxMessageBytes": 2048 } }
```

### Client → server

```json
{ "op": "subscribe" | "unsubscribe", "auctionId": "<24 hex>", "requestId": "<optional, ≤64 [A-Za-z0-9._:-]>" }
```

Only those three keys exist; any other key (a `room`, a `channel`) is rejected.
`auctionId` must be exactly 24 hex characters (lower-cased server-side to match
the outbox aggregate id). The client never names a room: the server builds
`auction:<id>` from the validated id. Messages of one socket are processed
strictly in order, one at a time.

### Server → client

| `type` | When |
|---|---|
| `ready` | after connect (and credential check) |
| `subscribed` | subscribe acknowledged; carries `alreadySubscribed` and the `resync` hint |
| `unsubscribed` | unsubscribe acknowledged; `wasSubscribed` says whether it changed anything |
| `event` | one auction event (below) |
| `closed` | the server ended a subscription because the auction stopped being publicly visible |
| `error` | `{ code, message, requestId?, auctionId?, serverTime }`, stable codes below |

Error codes: `REALTIME_MESSAGE_MALFORMED`, `REALTIME_MESSAGE_TOO_LARGE`,
`REALTIME_OPERATION_UNKNOWN`, `REALTIME_AUCTION_ID_INVALID`,
`REALTIME_AUCTION_NOT_AVAILABLE` (missing **and** hidden — one code, so ids
cannot be probed), `REALTIME_SUBSCRIPTION_LIMIT_REACHED`, `REALTIME_RATE_LIMITED`,
`REALTIME_TEMPORARILY_UNAVAILABLE` (visibility could not be checked; nothing was
subscribed; safe to retry). `message` is display text (Arabic); clients switch on `code`.
No stack, internal error text, connection string or token ever reaches a client.

Close codes: `1001` server going away · `1008` policy · `1009` frame above the hard
ceiling · `1013` try again later (at capacity / auth dependency down) · `4401`
unauthorized · `4403` origin not allowed · `4408` slow consumer · `4429` rate limited /
too many connections · `4503` realtime disabled on this instance.

## Event contract (`type: "event"`)

Explicit and versioned; never the raw outbox document. Every frame:

| Field | Meaning |
|---|---|
| `event` | `BID_ACCEPTED`, `AUCTION_ACTIVATED`, `AUCTION_END_EXTENDED`, `AUCTION_ENDED_PENDING_CLOSE`, `AUCTION_ENDED_NO_BIDS`, `AUCTION_CANCELLED`, `AUCTION_FINALIZED` |
| `eventId` | stable across redeliveries — **deduplicate on it** |
| `schemaVersion` | version of this contract (1) |
| `auctionId` | the auction |
| `streamVersion` | dense per-auction counter (the outbox `aggregateVersion`); a jump ≥ 2 means missed events |
| `occurredAt` | when the change committed (server clock) |
| `serverTime` | when the frame was produced (server clock) — the countdown reference |
| `terminal` | `true` = last event of the auction's public life; the subscription is removed |
| `data` | the per-event fields below |

| Event | `data` |
|---|---|
| `BID_ACCEPTED` | `sequence`, `amountMinor`, `currency`, `acceptedAt`, `acceptedBidCount`, `currentEndAt`, `previousEndAt`, `extended`, `nextMinimumBidMinor` (null at the money ceiling) |
| `AUCTION_END_EXTENDED` | `status`, `previousEndAt`, `currentEndAt` |
| `AUCTION_ACTIVATED` | `status`, `currentEndAt` |
| `AUCTION_ENDED_PENDING_CLOSE` | `status`, `currentEndAt`, `acceptedBidCount` (not terminal) |
| `AUCTION_ENDED_NO_BIDS` | `status`, `currentEndAt` (terminal) |
| `AUCTION_CANCELLED` | `status`, `previousStatus`, `cancelledAt` (terminal; no reason, no actor) |
| `AUCTION_FINALIZED` | `status`, `finalizedAt`, `acceptedBidCount`, `result { winningBidSequence, winningBidAmountMinor, currency }` (terminal; no identity) |

The mapper (`realtime-events.ts`) names every field; the outbox payload is never
spread. Anything that is not a well-formed **PUBLIC auction** event of a known
schema version (PRIVATE audience, another aggregate, a payload naming a different
auction, a missing/ill-typed field) is a *permanent* failure: dead-lettered for the
`realtime` consumer only.

## Anti-sniping

The server decides every extension inside the bid transaction (MAZAD-027/031). A
bid that extends emits `AUCTION_END_EXTENDED` (version *n*) then `BID_ACCEPTED`
(*n+1*); **both** carry the authoritative `currentEndAt` (and `previousEndAt`,
`extended`). Clients display the countdown from `currentEndAt` and the frame's
`serverTime`; they never compute an extension and never use the device clock as authority.

## Visibility

Realtime never shows more than the HTTP contract.

- **Subscribe:** `AuctionsQueryService.getPubliclyVisible` — the same gate as
  `GET /auctions/:id`, `/bid-state`, `/bids` (exists, public status, anchored
  property still public). No second "realtime" rule. Hidden or missing →
  `REALTIME_AUCTION_NOT_AVAILABLE`; lookup failure → `REALTIME_TEMPORARILY_UNAVAILABLE`
  (fail closed).
- **Publish:** for every non-terminal event of a room that has members the gate is
  re-checked (an auction can stop being public without an outbox event, e.g. its
  property is unpublished). If it stopped, the room is closed with a `closed`
  frame and the event is **not** sent; the delivery is acknowledged (its only
  possible audience is now forbidden, and retrying would only loop).
- **COMPLETED stays hidden.** COMPLETED auctions are outside the public HTTP
  visibility set and this task does not change that. A fresh subscription to a
  completed auction is refused. A client that was *already* subscribed receives
  the terminal `AUCTION_FINALIZED` with the identity-free outcome only (amount,
  sequence, currency, time — the winner *is* the highest accepted bid, which the
  subscriber already has from `BID_ACCEPTED` frames and the anonymised public history,
  so nothing new is disclosed), then its subscription is removed; any later resync uses HTTP,
  which will hide the auction. If the product later makes COMPLETED public,
  realtime follows automatically because it uses the same gate.
- No seller/Admin private realtime view exists. Not invented here.

## Terminal behavior

`AUCTION_ENDED_NO_BIDS`, `AUCTION_CANCELLED`, `AUCTION_FINALIZED` are terminal:
delivered to existing members with `terminal: true`, then the room is closed
(every member's subscription removed; sockets stay connected for other auctions).
`AUCTION_ENDED_PENDING_CLOSE` is *not* terminal: the auction stays publicly visible
until finalized. Terminal events are the notice itself and are not gated on
"still visible". Room membership therefore never outlives the auction's public life.
Edge: a client that subscribes in the instant between the visibility check and a
terminal event can hold a room that never receives anything; the mandatory
post-ack resync tells it the truth and the membership is harmless (no events
follow) until it disconnects.

## Delivery semantics

- **At-least-once per consumer** (MAZAD-031). **Not exactly-once to clients**;
  a redelivery may reach a client twice with the same `eventId`.
- **Server-side:** a room remembers the highest `streamVersion` it fanned out and skips
  anything at or below it, so a redelivery (lost acknowledgement, lease expiry, timeout
  race) is harmless while the room lives. This is an optimisation — memory is lost on
  restart or when the room empties — clients still deduplicate on `eventId`.
- **Ordering:** per auction, in outbox order. The dispatcher awaits each delivery before
  the next of the same auction, and `deliver` only awaits or runs synchronously
  (`hub.publish` never yields, per-socket send queues are FIFO), so there is no
  fire-and-forget step that could reorder frames. **No global cross-auction order.**
  A client that detects an inconsistency resyncs over HTTP.
- **A late/stale event** (e.g. after an operator redrive, or a redelivery after a restart)
  is either skipped by the room or carries a `streamVersion` the client can see is
  not the next one. Client rule: apply an event only if it advances what you hold
  (`sequence` / `acceptedBidCount` / a later `currentEndAt`). History from before realtime
  was first activated is not sent at all (see "First enablement").

## First enablement — the activation cutover

**The problem.** The MAZAD-031 outbox derives what a consumer is owed from the committed
events, so a consumer registered late is owed *all history*. For a durable consumer that is
right. Realtime is an ephemeral transport: telling connected clients about a bid accepted
last month "as if it just happened" is wrong, even though the delivery is owed. The generic
outbox guarantee is **not** changed; the `realtime` consumer decides what to *do* with an
owed event.

**No clock takes part.** Classification uses no host clock, no `occurredAt`, no `createdAt`
and no timestamp inside an event id, and there is no safety window. Those cannot order a
transaction's *commit* (an id is stamped by the producing host's clock at insert, before
commit; `occurredAt` is business time). The only commit-ordered quantity in the persistence
model is the per-auction `aggregateVersion`, so the cutover is built from that.

**Why `aggregateVersion` is commit-ordered (proved from the model, not assumed).** Every
auction producer (activation, end-of-bidding, cancellation, bid acceptance, finalization)
writes the Auction document in its transaction **before** `OutboxService.recordRequired`
(the code comment states the rule; the call sites do it). Concurrent transactions on one
auction therefore serialise on that document's write; `recordRequired` assigns
`max + 1` inside the same transaction; the unique `(aggregateType, aggregateId,
aggregateVersion)` index is the backstop. So, per auction, versions are dense and a higher
version was committed strictly after a lower one.

**The mechanism.** At first activation the store reads, from *majority-committed* outbox data,
the highest committed version of every auction — its **mark** — and persists all marks in one
document, created once (`$setOnInsert`, first writer wins). Then, for an event
`(auctionId, version)`:

| | |
|---|---|
| `version ≤ mark(auctionId)` | **history**: committed before the marks were read |
| anything else (a higher version, or an auction with no mark) | **live**: committed after |

**Where it is persisted.** One document, `_id: "realtime"`, in its own collection
`realtime_cutovers`: `{ marks: { <auctionId>: <version> }, aggregateCount, establishedBy }`.
No time field. It is created by a single `findOneAndUpdate` with `$setOnInsert` on the
majority write concern and is never updated. It is not part of any outbox event; the outbox and
its `delivery.<consumer>` state are untouched — the cutover's only access to the outbox is the
one read-only aggregate (`$match`/`$sort`/`$group`/`$limit`, majority read concern).

**Exact race semantics — a business transaction in flight while realtime is enabled.**
A transaction's rows are invisible to every other reader until it commits. So the marks read
either *sees* an event (committed before the read ⇒ counted in its mark ⇒ **history**) or
*does not* (uncommitted, or committed after ⇒ not counted). An event that was not counted takes
version `mark + 1` or higher — versions are assigned in commit order — so it is **live**, and it
stays live whatever its id, `occurredAt` or the clocks say and however long realtime was down.
There is no third case, and nothing about it depends on when the row was *created*, only on
whether the read saw it *committed*. One nuance, in the harmless direction: an event that commits
after the read but before the cutover document is persisted is live although it precedes the
persist — it is delivered (it may already be visible over HTTP) and never suppressed.

**Why suppressing history is safe: the subscription gate.** Every mark was read strictly before
the document was persisted, so history ⊆ "committed before activation". For history to also be
safe to *withhold from a subscriber*, that subscriber's HTTP read must reflect it. So the gateway
**refuses `subscribe` (`REALTIME_TEMPORARILY_UNAVAILABLE`, retryable, no lookup, socket stays open)
until the cutover is persisted**: every subscriber therefore reads HTTP (the resync the
`subscribed` ack asks for) after all marks were taken. This only matters at boot.

**What happens to pre-cutover events.** They still go through the ordinary MAZAD-031 state
machine: claimed, `deliver()` resolves without publishing anything, PROCESSED (attempt 1).
No hub call, no visibility read, no room closed, no frame — and the mapper does not even run,
so an old malformed row cannot dead-letter. Nothing is deleted, rewritten or bulk-marked;
they are consumed *for realtime only* (`delivery.realtime`). Every other consumer still
receives them.

**What happens to post-cutover events during downtime.** Nothing committed after the marks is
ever history, however long realtime was down (an hour, a week, a `REALTIME_ENABLED=false`
window): the marks contain no time, so nothing can age. They accumulate owed and are delivered
in order per auction after recovery. There is deliberately no age limit — one would silently drop
genuinely live events after an outage. Consequence to accept: after a long outage subscribers may
receive old-but-post-activation events; the client rule (apply only what advances what you hold;
resync on a `streamVersion` gap) covers it.

**Restart / redeploy / concurrent first activation.**
- A restart finds the persisted document and adopts it: it does not scan the outbox and does not write.
- Two processes activating at once each read and then attempt the create-once write; exactly one
  document exists afterwards and both adopt it (the loser discards its own marks; a duplicate-key
  loser re-reads the winner's). Every mark in the winning document was read before it was persisted,
  so the safety argument holds for whichever wins.
- A crash or store outage before the write persists nothing; the next attempt reads afresh (events
  committed meanwhile become history too — they precede the cutover's existence).
- Classification is a pure function of `(aggregateType, aggregateId, aggregateVersion)` and the
  persisted marks: identical on every retry, redelivery, restart and instance.

**While the cutover is not known** (store unreachable, or an unusable record) the consumer reports
itself *not configured*: the dispatcher skips it — nothing is claimed, no attempt is burned, nothing
can be dead-lettered because a cutover could not be read. It retries with back-off (2 s … 60 s) and
logs the error *class* only. An unusable record (unreadable marks, count mismatch) is never repaired or
replaced automatically: replacing it *is* a new cutover. A cutover larger than
`REALTIME_CUTOVER_MAX_AGGREGATES` (200 000 auctions, ~6 MB in one document) is refused permanently and
loudly rather than truncated — a truncated cutover would broadcast history.

**How event ordering remains valid.** The dispatcher's per-consumer ordering gate is untouched:
version *N+1* of an auction is not started until *N* is PROCESSED or DEAD_LETTER for `realtime`. For
each auction the historical events are exactly the prefix `1..mark` and the live events the suffix, so
history is consumed first, in order, and the first live version follows. The first live frame's
`streamVersion` may be greater than 1 — the client learns current state from HTTP, not by replaying.

**Acknowledgement meaning.** For a historical event, PROCESSED means "consumed; intentionally not
published". For a live event it means what the next section says.

**Cost of the first enable (operator sizing).** Historical events are cheap (a claim and an
acknowledgement, no socket, no visibility read, and the classification is an in-memory lookup) but still
walk through the dispatcher at `OUTBOX_DISPATCHER_BATCH_SIZE` per `OUTBOX_DISPATCHER_INTERVAL_SECONDS`
(defaults 100 per 5 s — a ceiling, not a measurement). The dispatcher scans oldest-first, so **live events
wait until the history is drained**. Size the batch (max 500) and interval (min 1 s) for your history
*before* the first enable, or enable off-peak, and observe `outbox_dispatch_run`. Realtime is not live for
auctions that are currently open until the drain finishes; HTTP is unaffected. The one-time marks read is
an index walk over the auctions' outbox streams.

**Migration / config / operator action.** None required. No env variable, no migration, no clock or
host check: the `realtime_cutovers` collection and its one document are created by the first activation.
An operator who *deliberately* wants a fresh cutover (for example to skip a long intentional outage) can
only get one by removing that document by hand — a conscious decision: everything committed before the new
marks would then be consumed silently — and no code does it. It is never needed to recover from a clock
problem, because no clock is involved.

## Exactly what "outbox acknowledged" means

`RealtimeOutboxConsumer.deliver` resolving marks `delivery.realtime` PROCESSED. (For an event
from before the activation cutover it means "consumed, intentionally not published" — see above.)
For a live event it means: **the hub accepted the publish** — the frame was handed to the send queue of every
currently subscribed, open socket (or nobody was subscribed, or this process had
already fanned that event out).

It does **not** mean any client received it. Nothing waits for any client. A
disconnected or slow client recovers through HTTP resync; a peer whose unsent buffer
exceeds `REALTIME_MAX_BUFFERED_BYTES` is terminated instead of queued.

`deliver` **throws** (outbox retries with backoff; never acknowledged) when the hub
is shutting down, when the visibility check cannot be evaluated, or on any transport
exception. A crash between socket emit and acknowledgement redelivers after the lease
(a duplicate, absorbed as above).

## Reconnect / resync contract

1. `GET /api/v1/auctions/:id` (+ `/bid-state`, `/bids`) — authoritative state.
2. Connect → `ready` → `subscribe`.
3. **On `subscribed` (`resync.required: true`) read the HTTP state again.** Events before
   the acknowledgement are not replayed, so reading *after* it closes the window between
   the first read and the subscription. `resync.http` lists the endpoints.
4. Apply incoming events on top. Deduplicate by `eventId`.
5. On any disconnect/reconnect, `closed`, a `streamVersion` gap, an unrecognised state,
   or any doubt → go back to step 1. A `terminal` event ends the subscription; later
   reads follow HTTP visibility.

The subscription acknowledgement is deliberately not a snapshot.

## Limits (all configurable, env vars in `.env.example`)

| Control | Default | Behaviour |
|---|---|---|
| `REALTIME_MAX_SUBSCRIPTIONS_PER_SOCKET` | 50 | checked *before* the lookup |
| `REALTIME_MAX_MESSAGE_BYTES` | 2048 (≤ 8192 hard ceiling) | over → `MESSAGE_TOO_LARGE`; over the ceiling → socket closed `1009` |
| `REALTIME_MESSAGE_RATE_LIMIT` / `_WINDOW_SECONDS` | 30 / 10 | over → one `RATE_LIMITED` notice per window, message dropped; >2× → close `4429` |
| `REALTIME_MAX_CONNECTIONS` | 5000 | total; `1013` |
| `REALTIME_MAX_CONNECTIONS_PER_IP` | 100 | keyed by the address Express derives under `TRUST_PROXY` (same as HTTP throttling); `4429` |
| `REALTIME_HEARTBEAT_SECONDS` | 30 | ping; a peer that misses a beat is terminated |
| `REALTIME_MAX_BUFFERED_BYTES` | 1 MiB | slow peer terminated, never queued unboundedly |

Also: a bounded per-socket processing queue, no per-message-deflate, `CORS_ORIGINS`
enforced on a browser `Origin` (native clients send none; there are no cookies, so this is
hygiene), cleanup of every membership on close/error/heartbeat. HTTP throttling is untouched
(the WebSocket bypasses the HTTP guard chain by nature; the limits above are its equivalent).

## Privacy review

Never in a frame: bidder/winner/advertiser account ids, `privateRouting`, bid Mongo ids,
payment data or ids, e-mail/phone/names, audit or actor data, the cancellation reason, or
any raw outbox field (`aggregateType`, `audience`, `attempt`, …). Guarded by an explicit
whitelist mapper, a mapper test that injects extra sensitive fields, an end-to-end
lifecycle test over a real socket that greps the wire, and a source guard.
Payment and managed-marketing events are not subscribed to.

## Known limits and release-qualification items (not claimed solved)

Automated tests use an in-memory MODEL of Mongo and localhost sockets. Still required
against real infrastructure:

- `realtime` consumer + **real MongoDB** outbox claiming (incl. the per-consumer scan index).
- Reconnect **during bid bursts**; anti-sniping event ordering under load.
- **Process crash between socket emit and outbox acknowledgement** (duplicate) for real.
- Lifecycle/finalization event ordering with real workers.
- **Load** with many auction-room subscribers; **slow/broken clients** on real sockets
  (backpressure is unit-tested on the hub; a real-socket backlog is not).
- **Multi-instance fan-out topology** (see above) — shared pub/sub or election.
- **Activation cutover on real MongoDB.** The `$setOnInsert` upsert, a genuinely concurrent first
  activation (duplicate-key path), the collection's creation with the production database user's
  permissions, the majority read/write concern under failover, and the marks aggregate over a large
  outbox (index use, memory, time) are modelled/faked in tests, not proven. Also unproven: that every
  auction producer writes the Auction document before recording its event under real concurrency
  (established from the code and the MAZAD-031 tests, not from a real-Mongo run).
- **First-enable drain time.** History is consumed without broadcasting, but live events queue
  behind it at ~batch-size per tick; measure it against real history size and tune
  `OUTBOX_DISPATCHER_BATCH_SIZE`/interval (see "First enablement").
- The cutover records at most 200 000 auctions in one document; beyond that activation is refused (a
  chunked cutover would be needed).
- Realtime dead-letter alerting/redrive is the MAZAD-031 deferred item.
- Per-event visibility re-check costs one auction + property read per event *for rooms
  that have members* (a hot auction under a bid burst); measure before tuning a cache.
- `REALTIME_MAX_CONNECTIONS_PER_IP` (default 100) keys on the client address like HTTP throttling does; many real
  users can share one address behind carrier-grade NAT, so validate the default against real mobile traffic.
- Browser clients cannot authenticate (no header on `WebSocket`); irrelevant while frames are
  public, needed before any private channel.
