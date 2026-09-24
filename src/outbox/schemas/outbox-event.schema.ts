import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { OutboxAggregateType, OutboxAudience, OutboxEventType } from '../outbox-events';
import { OUTBOX_AGGREGATE_VERSION_INDEX, OutboxErrorClass, OutboxStatus } from '../outbox.constants';

export type OutboxEventDocument = HydratedDocument<OutboxEvent>;

/** One consumer's progress on one event. Every field is optional: "no state yet" means PENDING and due now. */
export interface OutboxConsumerDelivery {
  status?: OutboxStatus;
  /** Delivery attempts STARTED for this consumer (incremented on every claim, including claims a crash never finished). */
  attemptCount?: number;
  /** PENDING: earliest (re)delivery time. PROCESSING: the LEASE EXPIRY — an abandoned claim simply becomes due again. */
  nextAttemptAt?: Date;
  /** Worker instance that holds the lease (opaque id, no host/PII). */
  claimedBy?: string;
  /** Random per-claim token: acknowledgement/failure writes must present it, so a stale worker cannot overwrite a newer claim. */
  leaseToken?: string;
  claimedAt?: Date;
  lastAttemptAt?: Date;
  processedAt?: Date;
  deadLetteredAt?: Date;
  lastErrorClass?: OutboxErrorClass;
  /** Constructor name of the last failure (e.g. "TypeError"): never the message or stack. */
  lastErrorName?: string;
}

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
 *    "realtime PROCESSED, notifications PENDING" is an ordinary state and one
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
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'outbox_events', versionKey: false })
export class OutboxEvent {
  @Prop({ type: String, required: true, immutable: true, enum: Object.values(OutboxEventType) }) type: OutboxEventType;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) schemaVersion: number;
  @Prop({ type: String, required: true, immutable: true, enum: Object.values(OutboxAggregateType) }) aggregateType: OutboxAggregateType;
  @Prop({ type: String, required: true, immutable: true, match: /^[a-f0-9]{24}$/ }) aggregateId: string;
  /** 1-based, dense per `(aggregateType, aggregateId)`; assigned inside the producing transaction (see `OutboxService`). */
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) aggregateVersion: number;
  @Prop({ type: Date, required: true, immutable: true }) occurredAt: Date;
  @Prop({ type: String, required: true, immutable: true, enum: Object.values(OutboxAudience) }) audience: OutboxAudience;
  /** Plain-JSON facts; never account ids, PII, secrets or provider payloads (enforced by `assertValidOutboxDraft`). */
  @Prop({ type: Object, required: true, immutable: true }) payload: Record<string, unknown>;
  /** Recipient account ids for PRIVATE routing only — never part of a public projection. */
  @Prop({ type: Object, immutable: true }) privateRouting?: Record<string, string>;

  /** Per-consumer delivery progress (see class docs). Mutable; absent until a consumer first claims the event. */
  @Prop({ type: Object }) delivery?: Record<string, OutboxConsumerDelivery>;
}

export const OutboxEventSchema = SchemaFactory.createForClass(OutboxEvent);

// Deterministic per-aggregate ordering + aggregate/event lookup. UNIQUE: two
// events can never share a version, so a lost race surfaces as a duplicate-key
// error the transaction runners treat as retryable (never a silent reorder).
// It also serves every consumer's ordering gate. The per-consumer SCAN index is
// created when a consumer first dispatches (`outboxConsumerScanIndexSpec`),
// because the set of consumers is not known to this schema.
OutboxEventSchema.index({ aggregateType: 1, aggregateId: 1, aggregateVersion: 1 }, { unique: true, name: OUTBOX_AGGREGATE_VERSION_INDEX });
