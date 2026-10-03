import { Injectable } from '@nestjs/common';
import { OutboxAggregateType, OutboxAudience, OutboxEventType, OutboxPayload, OutboxPrivateRouting } from './outbox-events';
import { OUTBOX_CONSUMER_NAME_PATTERN } from './outbox.constants';

/**
 * What a consumer receives. `eventId` is the identity to deduplicate on:
 * delivery is AT-LEAST-ONCE per consumer, so the same event can reach the same
 * consumer more than once (a worker died after the consumer succeeded but
 * before the acknowledgement was stored; a consumer timed out but had actually
 * done the work; a lease expired on a slow consumer).
 */
export interface OutboxDeliveryEvent {
  eventId: string;
  type: OutboxEventType;
  schemaVersion: number;
  aggregateType: OutboxAggregateType;
  aggregateId: string;
  /** Dense, 1-based, per `(aggregateType, aggregateId)`. Use it to ignore stale duplicates and to detect a gap. */
  aggregateVersion: number;
  occurredAt: Date;
  audience: OutboxAudience;
  payload: OutboxPayload;
  /** Recipient ids for private routing. NEVER forward to a public channel. */
  privateRouting?: OutboxPrivateRouting;
  /** 1-based delivery attempt number FOR THIS CONSUMER (diagnostics only). */
  attempt: number;
}

/**
 * One independent consumer of the outbox, such as notifications. Each consumer has its OWN delivery progress
 * per event: status, attempts, lease, retry schedule and dead letter. Another
 * consumer being ahead, behind, failing or dead-lettered never changes it.
 *
 * Contract:
 *  - `name` is a permanent, stable identity (`OUTBOX_CONSUMER_NAME_PATTERN`):
 *    it keys the consumer's delivery state, so renaming it makes it a NEW
 *    consumer that re-receives all history;
 *  - `subscribedTypes` are the only event types it is owed. An event type it
 *    does not subscribe to is invisible to it and never blocks it, and it never
 *    blocks another consumer;
 *  - `deliver` resolves = the event was durably handled → this consumer's
 *    delivery becomes PROCESSED; throws = retried with backoff, or, for an
 *    `OutboxPermanentDeliveryError`, dead-lettered immediately (for THIS
 *    consumer only);
 *  - it must be idempotent by `eventId` and finish within the dispatcher's
 *    per-delivery timeout;
 *  - `configured: false` (e.g. a feature that is switched off) makes the
 *    dispatcher skip it entirely — nothing is claimed or marked.
 */
export interface OutboxEventConsumer {
  readonly name: string;
  readonly subscribedTypes: readonly OutboxEventType[];
  readonly configured: boolean;
  deliver(event: OutboxDeliveryEvent): Promise<void>;
}

/** Thrown by a consumer to say "this event can never be delivered to me" (malformed for that consumer, unknown version…). Retrying is pointless. */
export class OutboxPermanentDeliveryError extends Error {
  constructor(message = 'outbox event cannot be delivered') {
    super(message);
    this.name = 'OutboxPermanentDeliveryError';
  }
}

export class InvalidOutboxConsumerError extends Error {
  constructor(reason: string) {
    super(`invalid outbox consumer: ${reason}`);
    this.name = 'InvalidOutboxConsumerError';
  }
}

/**
 * The set of consumers the dispatcher serves. Empty by default: with no
 * consumer registered (the state until MAZAD-032/036) events simply stay
 * durable and nothing is ever marked delivered.
 *
 * A future module registers its consumer from its own `onModuleInit` —
 * `registry.register(consumer)` — so adding another consumer or notifications needs no
 * change to this module, to any business transaction, or to another consumer.
 * Registration is what creates the consumer's obligation: every committed event
 * of a subscribed type, including history from before the consumer existed, is
 * owed to it until its own delivery is PROCESSED or DEAD_LETTER.
 */
@Injectable()
export class OutboxConsumerRegistry {
  private readonly consumers = new Map<string, OutboxEventConsumer>();

  register(consumer: OutboxEventConsumer): void {
    const name = consumer?.name;
    if (typeof name !== 'string' || !OUTBOX_CONSUMER_NAME_PATTERN.test(name)) {
      throw new InvalidOutboxConsumerError(`name must match ${OUTBOX_CONSUMER_NAME_PATTERN}`);
    }
    if (typeof consumer.deliver !== 'function') throw new InvalidOutboxConsumerError(`${name} has no deliver()`);
    const types = consumer.subscribedTypes;
    if (!Array.isArray(types) || types.length === 0) throw new InvalidOutboxConsumerError(`${name} must subscribe to at least one event type`);
    const known = new Set<string>(Object.values(OutboxEventType));
    for (const type of types) if (!known.has(type)) throw new InvalidOutboxConsumerError(`${name} subscribes to unknown event type "${String(type)}"`);
    if (new Set(types).size !== types.length) throw new InvalidOutboxConsumerError(`${name} lists a subscribed type twice`);
    // Two consumers sharing one identity would share (and corrupt) one delivery state.
    if (this.consumers.has(name)) throw new InvalidOutboxConsumerError(`a consumer named "${name}" is already registered`);
    this.consumers.set(name, consumer);
  }

  get(name: string): OutboxEventConsumer | undefined {
    return this.consumers.get(name);
  }

  /** Registered consumers in name order (deterministic). */
  list(): OutboxEventConsumer[] {
    return [...this.consumers.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
}
