'use strict';

const { OutboxEventType } = require('./outbox-events');
const { OUTBOX_CONSUMER_NAME_PATTERN } = require('./outbox.constants');
/** Thrown by a consumer to say "this event can never be delivered to me" (malformed for that consumer, unknown version…). Retrying is pointless. */
class OutboxPermanentDeliveryError extends Error {
  constructor(message = 'outbox event cannot be delivered') {
    super(message);
    this.name = 'OutboxPermanentDeliveryError';
  }
}
class InvalidOutboxConsumerError extends Error {
  constructor(reason) {
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
class OutboxConsumerRegistry {
  constructor() {
    this.consumers = new Map();
  }
  register(consumer) {
    const name = consumer?.name;
    if (typeof name !== 'string' || !OUTBOX_CONSUMER_NAME_PATTERN.test(name)) {
      throw new InvalidOutboxConsumerError(`name must match ${OUTBOX_CONSUMER_NAME_PATTERN}`);
    }
    if (typeof consumer.deliver !== 'function')
      throw new InvalidOutboxConsumerError(`${name} has no deliver()`);
    const types = consumer.subscribedTypes;
    if (!Array.isArray(types) || types.length === 0)
      throw new InvalidOutboxConsumerError(`${name} must subscribe to at least one event type`);
    const known = new Set(Object.values(OutboxEventType));
    for (const type of types)
      if (!known.has(type))
        throw new InvalidOutboxConsumerError(
          `${name} subscribes to unknown event type "${String(type)}"`,
        );
    if (new Set(types).size !== types.length)
      throw new InvalidOutboxConsumerError(`${name} lists a subscribed type twice`);
    // Two consumers sharing one identity would share (and corrupt) one delivery state.
    if (this.consumers.has(name))
      throw new InvalidOutboxConsumerError(`a consumer named "${name}" is already registered`);
    this.consumers.set(name, consumer);
  }
  get(name) {
    return this.consumers.get(name);
  }
  /** Registered consumers in name order (deterministic). */
  list() {
    return [...this.consumers.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }
}

Object.assign(exports, {
  OutboxPermanentDeliveryError,
  InvalidOutboxConsumerError,
  OutboxConsumerRegistry,
});
