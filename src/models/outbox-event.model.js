'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const {
  OutboxAggregateType,
  OutboxAudience,
  OutboxEventType,
} = require('../domain/outbox/outbox-events');
const { OUTBOX_AGGREGATE_VERSION_INDEX } = require('../domain/outbox/outbox.constants');
/**
 * One durable domain event (MAZAD-031 transactional outbox). Inserted ONLY by
 * `OutboxService.recordRequired`, inside the same Mongo transaction as the
 * authoritative state change it describes: commit ⇒ the event exists, abort
 * ⇒ it never did. The business transaction writes the event exactly once and
 * knows nothing about who will consume it.
 *
 * `_id` is the event id (`eventId`): immutable, unique, and the key every
 * consumer must deduplicate on (delivery is at-least-once).
 *
 * Two field groups:
 *  - the EVENT (type … privateRouting, createdAt): immutable, written once;
 *  - `delivery`: a map `consumerName → OutboxConsumerDelivery`. Each consumer
 *    owns its own entry (status, attempts, lease, retry time, dead letter), so
 *    "another consumer PROCESSED, notifications PENDING" is an ordinary state and one
 *    consumer can never complete, block or dead-letter another. The dispatcher
 *    only ever writes `delivery.<its own name>.*`, always through a conditional
 *    (status + lease token) write. The map is ABSENT at insert: a consumer
 *    registered later finds every historical event still owed to it.
 *
 * RETENTION. No TTL index, on purpose: an automatic expiry could delete an
 * event before every consumer delivered it or an operator investigated it.
 * PROCESSED events are kept until an explicit, operator-approved archival job
 * exists (deferred — the product has not chosen a retention window). An event
 * with any unfinished or DEAD_LETTER delivery must never be deleted
 * automatically.
 */
class OutboxEvent {}
const OutboxEventSchema = new mongooseSchema(
  {
    type: { type: String, required: true, immutable: true, enum: Object.values(OutboxEventType) },
    schemaVersion: { type: Number, required: true, immutable: true, min: 1 },
    aggregateType: {
      type: String,
      required: true,
      immutable: true,
      enum: Object.values(OutboxAggregateType),
    },
    aggregateId: { type: String, required: true, immutable: true, match: /^[a-f0-9]{24}$/ },
    aggregateVersion: { type: Number, required: true, immutable: true, min: 1 },
    occurredAt: { type: Date, required: true, immutable: true },
    audience: {
      type: String,
      required: true,
      immutable: true,
      enum: Object.values(OutboxAudience),
    },
    payload: { type: Object, required: true, immutable: true },
    privateRouting: { type: Object, immutable: true },
    delivery: { type: Object },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'outbox_events',
    versionKey: false,
  },
);
// Deterministic per-aggregate ordering + aggregate/event lookup. UNIQUE: two
// events can never share a version, so a lost race surfaces as a duplicate-key
// error the transaction runners treat as retryable (never a silent reorder).
// It also serves every consumer's ordering gate. The per-consumer SCAN index is
// created when a consumer first dispatches (`outboxConsumerScanIndexSpec`),
// because the set of consumers is not known to this schema.
OutboxEventSchema.index(
  { aggregateType: 1, aggregateId: 1, aggregateVersion: 1 },
  { unique: true, name: OUTBOX_AGGREGATE_VERSION_INDEX },
);

Object.assign(exports, { OutboxEvent, OutboxEventSchema });
