'use strict';

const { Types } = require('mongoose');
const {
  OutboxConsumerRegistry,
  OutboxPermanentDeliveryError,
} = require('../src/domain/outbox/outbox-consumer.port');
const { OutboxEventType } = require('../src/domain/outbox/outbox-events');
const {
  OutboxDispatcherService,
  outboxBackoffMs,
} = require('../src/services/outbox-dispatcher.service');
const { OutboxDispatcherWorker } = require('../src/services/outbox-dispatcher.worker');
const {
  OutboxErrorClass,
  OutboxStatus,
  outboxDeliveryStatus,
} = require('../src/domain/outbox/outbox.constants');
const { FakeOutboxStore } = require('./support/fake-outbox');
/**
 * MAZAD-031 — the dispatcher against the in-memory outbox MODEL. Every claim
 * and acknowledgement is one conditional single-document write, which is the
 * atomicity MongoDB provides; multi-instance claiming, lease-expiry races and
 * real crash behaviour still need a disposable-Mongo run at release
 * qualification.
 */
const T0 = new Date('2026-05-08T10:00:00Z');
const A = '64b0000000000000000aa001';
const B = '64b0000000000000000aa002';
const C = '64b0000000000000000aa003';
const sec = (n) => n * 1000;
const NAME = 'secondary';
/** A consumer named `secondary` that subscribes to every event type (single-consumer behaviour; multi-consumer is in outbox-multi-consumer.spec.js). */
function makeConsumer(deliver, seen, configured = true, name = NAME) {
  return {
    name,
    subscribedTypes: Object.values(OutboxEventType),
    configured,
    deliver: jest.fn(async (event) => {
      seen.push(event);
      await deliver(event);
    }),
  };
}
function build(overrides = {}) {
  const store = new FakeOutboxStore();
  const state = { now: new Date(T0.getTime() + sec(1)) };
  const clock = { now: jest.fn(() => new Date(state.now)) };
  const seen = [];
  const consumer = makeConsumer(
    overrides.deliver ?? (async () => undefined),
    seen,
    overrides.configured ?? true,
  );
  const registry = new OutboxConsumerRegistry();
  registry.register(consumer);
  const values = { OUTBOX_MAX_ATTEMPTS: '3', ...overrides.config };
  const config = { get: (key) => values[key] };
  const make = (reg = registry) => {
    const dispatcher = new OutboxDispatcherService(store.model, reg, clock, config);
    dispatcher.random = () => 1; // jitter ceiling ⇒ delays are exactly the exponential value
    dispatcher.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return dispatcher;
  };
  const dispatcher = make();
  const advance = (ms) => {
    state.now = new Date(state.now.getTime() + ms);
  };
  return { store, state, clock, consumer, seen, dispatcher, make, advance, values, registry };
}
/** This consumer's delivery state on an event (absent ⇒ never touched ⇒ PENDING). */
const dstate = (r, name = NAME) => r.delivery?.[name] ?? {};
/** Event + this consumer's delivery fields flattened, so assertions read `status`, `attemptCount`, `leaseToken`… directly. */
const flat = (r, name = NAME) => ({ ...r, ...dstate(r, name) });
const flatRows = (store, name = NAME) => store.rows.map((r) => flat(r, name));
const setDelivery = (event, fields, name = NAME) => {
  event.delivery = {
    ...(event.delivery ?? {}),
    [name]: { ...(event.delivery?.[name] ?? {}), ...fields },
  };
};
/** Seeds versions 1..n of one aggregate, each due a millisecond after the previous one. */
function seedAggregate(store, aggregateId, n, base = 0) {
  return Array.from({ length: n }, (_, i) =>
    store.seed({
      aggregateType: 'KYC',
      aggregateId,
      aggregateVersion: i + 1,
      type: 'KYC_APPROVED',
      occurredAt: new Date(T0.getTime() + base + i),
      payload: { propertyId: aggregateId, sequence: i + 1 },
      privateRouting: { subjectAccountId: '64b000000000000000000a11' },
    }),
  );
}
const row = (store, id, name = NAME) =>
  flat(
    store.rows.find((r) => r._id.equals(id)),
    name,
  );
const IMMUTABLE = [
  '_id',
  'type',
  'schemaVersion',
  'aggregateType',
  'aggregateId',
  'aggregateVersion',
  'occurredAt',
  'audience',
  'payload',
  'privateRouting',
  'createdAt',
];
const pickImmutable = (r) => JSON.stringify(IMMUTABLE.map((k) => r[k]));
/** A separate dispatcher instance (own instanceId) serving one consumer named `secondary` with its own handler over the SAME store. */
function dispatcherWith(ctx, deliver, name = NAME) {
  const registry = new OutboxConsumerRegistry();
  registry.register({
    name,
    subscribedTypes: Object.values(OutboxEventType),
    configured: true,
    deliver,
  });
  const dispatcher = new OutboxDispatcherService(ctx.store.model, registry, ctx.clock, {
    get: () => undefined,
  });
  dispatcher.random = () => 1;
  dispatcher.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return dispatcher;
}
const ticks = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe('no consumer yet: fail safe, never discard (MAZAD-031)', () => {
  it('a registered but switched-off consumer is skipped entirely: nothing claimed, nothing marked, events carry no delivery state', async () => {
    const { store, dispatcher, consumer } = build({ configured: false });
    const rows = seedAggregate(store, A, 3);
    const summary = await dispatcher.dispatchConsumer(NAME);
    expect(summary).toMatchObject({
      consumer: NAME,
      skipped: 'NOT_CONFIGURED',
      scanned: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
    });
    expect(store.updates).toHaveLength(0);
    for (const r of rows)
      expect(store.rows.find((x) => x._id.equals(r._id)).delivery).toBeUndefined();
    expect(consumer.deliver).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(3);
  });
  it('with NO consumer registered (the state until MAZAD-032/036) events stay durable, untouched and undelivered', async () => {
    const store = new FakeOutboxStore();
    const registry = new OutboxConsumerRegistry();
    expect(registry.list()).toEqual([]);
    const dispatcher = new OutboxDispatcherService(
      store.model,
      registry,
      { now: () => new Date(T0.getTime() + sec(1)) },
      { get: () => undefined },
    );
    dispatcher.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const rows = seedAggregate(store, A, 3);
    const findSpy = jest.spyOn(store.model, 'find');
    await expect(dispatcher.dispatchConsumer('secondary')).resolves.toMatchObject({
      skipped: 'UNKNOWN_CONSUMER',
      delivered: 0,
    });
    await expect(dispatcher.dispatchConsumer('notifications')).resolves.toMatchObject({
      skipped: 'UNKNOWN_CONSUMER',
      delivered: 0,
    });
    expect(findSpy).not.toHaveBeenCalled(); // not even a scan
    expect(store.updates).toHaveLength(0);
    for (const r of rows)
      expect(store.rows.find((x) => x._id.equals(r._id)).delivery).toBeUndefined();
    expect(store.rows).toHaveLength(3);
  });
  it('the module ships an EMPTY registry and no consumer binding: no fake secondary or notification consumer exists', () => {
    expect(new OutboxConsumerRegistry().list()).toEqual([]);
  });
  it('the worker with no consumers registered warns once, arms its timer (consumers may register later) and each tick touches nothing', async () => {
    const ctx = build({ config: { OUTBOX_DISPATCHER_ENABLED: 'true' } });
    const emptyRegistry = new OutboxConsumerRegistry();
    const dispatcher = ctx.make(emptyRegistry);
    seedAggregate(ctx.store, A, 2);
    const worker = new OutboxDispatcherWorker(dispatcher, emptyRegistry, {
      get: (k) => (k === 'OUTBOX_DISPATCHER_ENABLED' ? 'true' : undefined),
    });
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    worker.logger = logger;
    worker.onApplicationBootstrap();
    expect(worker.timer).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('outbox_no_consumers_registered'),
    );
    await expect(worker.runOnce()).resolves.toEqual({});
    expect(ctx.store.updates).toHaveLength(0);
    expect(ctx.store.rows.every((r) => r.delivery === undefined)).toBe(true);
    await worker.onModuleDestroy();
  });
});
describe('consumer registry (MAZAD-031)', () => {
  const consumer = (over = {}) => ({
    name: 'secondary',
    subscribedTypes: [OutboxEventType.KYC_APPROVED],
    configured: true,
    deliver: async () => undefined,
    ...over,
  });
  it('registers consumers under stable names and lists them in name order', () => {
    const registry = new OutboxConsumerRegistry();
    registry.register(consumer({ name: 'secondary' }));
    registry.register(consumer({ name: 'notifications' }));
    expect(registry.list().map((c) => c.name)).toEqual(['notifications', 'secondary']);
    expect(registry.get('secondary')).toBeDefined();
    expect(registry.get('nope')).toBeUndefined();
  });
  it.each([
    ['', 'empty'],
    ['Realtime', 'upper case'],
    ['real.time', 'dot'],
    ['real-time', 'hyphen'],
    ['$set', 'operator'],
    ['a', 'too short'],
    ['x'.repeat(41), 'too long'],
    ['1abc', 'leading digit'],
  ])(
    'rejects the unsafe consumer name %j (%s): it becomes a Mongo field name and an index name',
    (name) => {
      expect(() => new OutboxConsumerRegistry().register(consumer({ name }))).toThrow(
        /invalid outbox consumer/,
      );
    },
  );
  it('rejects a duplicate name (two consumers must never share one delivery state), no subscriptions, unknown or repeated types, and a missing deliver()', () => {
    const registry = new OutboxConsumerRegistry();
    registry.register(consumer());
    expect(() => registry.register(consumer())).toThrow(/already registered/);
    expect(() => new OutboxConsumerRegistry().register(consumer({ subscribedTypes: [] }))).toThrow(
      /at least one/,
    );
    expect(() =>
      new OutboxConsumerRegistry().register(consumer({ subscribedTypes: ['PROPERTY_EXPLODED'] })),
    ).toThrow(/unknown event type/);
    expect(() =>
      new OutboxConsumerRegistry().register(
        consumer({
          subscribedTypes: [OutboxEventType.KYC_APPROVED, OutboxEventType.KYC_APPROVED],
        }),
      ),
    ).toThrow(/twice/);
    expect(() => new OutboxConsumerRegistry().register(consumer({ deliver: undefined }))).toThrow(
      /no deliver/,
    );
  });
});
describe('batching and deterministic order (MAZAD-031)', () => {
  it('delivers at most one bounded batch per pass, oldest-due first with _id as the tie-break', async () => {
    const { store, dispatcher, seen } = build();
    // Ten independent aggregates (ordering is per aggregate), due 1ms apart; the last two share a due time (tie → _id order).
    const ids = Array.from({ length: 10 }, () => new Types.ObjectId().toString());
    ids.forEach((id, i) =>
      store.seed({
        aggregateType: 'KYC',
        aggregateId: id,
        aggregateVersion: 1,
        occurredAt: new Date(T0.getTime() + Math.min(i, 8)),
      }),
    );
    const first = await dispatcher.dispatchConsumer(NAME, 3);
    expect(first.delivered).toBe(3);
    expect(seen.map((e) => e.aggregateId)).toEqual(ids.slice(0, 3));
    await dispatcher.dispatchConsumer(NAME, 3);
    expect(seen.map((e) => e.aggregateId)).toEqual(ids.slice(0, 6));
    await dispatcher.dispatchConsumer(NAME, 100);
    expect(seen.map((e) => e.aggregateId)).toEqual(ids);
    expect(flatRows(store).every((r) => r.status === OutboxStatus.PROCESSED)).toBe(true);
  });
  it('is deterministic: the same seed order produces the same delivery order every time', async () => {
    const orders = [];
    for (let run = 0; run < 3; run++) {
      const { store, dispatcher, seen } = build();
      seedAggregate(store, A, 3, 5);
      seedAggregate(store, B, 3, 0);
      seedAggregate(store, C, 2, 2);
      for (let i = 0; i < 6; i++) await dispatcher.dispatchConsumer(NAME);
      orders.push(seen.map((e) => `${e.aggregateId.slice(-1)}${e.aggregateVersion}`));
    }
    expect(orders[1]).toEqual(orders[0]);
    expect(orders[2]).toEqual(orders[0]);
    expect(orders[0]).toHaveLength(8);
  });
  it('does not touch a delivery whose retry is not due yet, and clamps the batch size configuration', async () => {
    const { store, dispatcher, seen, values } = build();
    const waiting = store.seed({ aggregateType: 'KYC', aggregateId: A, aggregateVersion: 1 });
    setDelivery(waiting, {
      status: OutboxStatus.PENDING,
      attemptCount: 1,
      nextAttemptAt: new Date(T0.getTime() + sec(3600)),
    }); // retry scheduled an hour out
    expect((await dispatcher.dispatchConsumer(NAME)).scanned).toBe(0);
    expect(seen).toHaveLength(0);
    expect(dispatcher.batchSize).toBe(100);
    values.OUTBOX_DISPATCHER_BATCH_SIZE = '9999';
    expect(dispatcher.batchSize).toBe(500);
    values.OUTBOX_DISPATCHER_BATCH_SIZE = 'abc';
    expect(dispatcher.batchSize).toBe(100);
    values.OUTBOX_DISPATCHER_BATCH_SIZE = '7';
    expect(dispatcher.batchSize).toBe(7);
  });
});
describe('acknowledgement (MAZAD-031)', () => {
  it('marks PROCESSED only after the consumer resolves, drops the lease fields and keeps attempt history', async () => {
    let statusDuringDelivery;
    const ctx = build({
      deliver: async () => {
        statusDuringDelivery = dstate(ctx.store.rows[0]).status;
      },
    });
    const [event] = seedAggregate(ctx.store, A, 1);
    const summary = await ctx.dispatcher.dispatchConsumer(NAME);
    expect(statusDuringDelivery).toBe(OutboxStatus.PROCESSING); // not yet acknowledged while the consumer works
    expect(summary).toMatchObject({ delivered: 1, retried: 0, deadLettered: 0, unconfirmed: 0 });
    const done = row(ctx.store, event._id);
    expect(done).toMatchObject({
      status: OutboxStatus.PROCESSED,
      attemptCount: 1,
      processedAt: ctx.state.now,
    });
    expect(done.leaseToken).toBeUndefined();
    expect(done.claimedBy).toBeUndefined();
  });
  it('hands the consumer the full event contract (id, version, ordering key, private routing, attempt) and no delivery internals', async () => {
    const { store, dispatcher, seen } = build();
    const [event] = seedAggregate(store, A, 1);
    await dispatcher.dispatchConsumer(NAME);
    expect(seen[0]).toEqual({
      eventId: event._id.toString(),
      type: 'KYC_APPROVED',
      schemaVersion: 1,
      aggregateType: 'KYC',
      aggregateId: A,
      aggregateVersion: 1,
      occurredAt: event.occurredAt,
      audience: 'PUBLIC',
      payload: { propertyId: A, sequence: 1 },
      privateRouting: { subjectAccountId: '64b000000000000000000a11' },
      attempt: 1,
    });
    expect(Object.keys(seen[0])).not.toEqual(
      expect.arrayContaining(['leaseToken', 'claimedBy', 'status', 'nextAttemptAt']),
    );
  });
  it('a processed event is never delivered again', async () => {
    const { store, dispatcher, consumer, advance } = build();
    seedAggregate(store, A, 1);
    await dispatcher.dispatchConsumer(NAME);
    advance(sec(86_400));
    await dispatcher.dispatchConsumer(NAME);
    expect(consumer.deliver).toHaveBeenCalledTimes(1);
  });
});
describe('failure, backoff and dead-lettering (MAZAD-031)', () => {
  it('backoff is exponential, jittered downward only, and never exceeds the cap', () => {
    const opts = { baseMs: 2_000, capMs: 600_000 };
    expect([1, 2, 3, 4, 5].map((n) => outboxBackoffMs(n, { ...opts, random: () => 1 }))).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000,
    ]);
    expect(outboxBackoffMs(1, { ...opts, random: () => 0 })).toBe(1_600); // floor of the jitter band
    for (const attempt of [10, 11, 30, 60, 1_000, 1_000_000])
      expect(outboxBackoffMs(attempt, { ...opts, random: () => 1 })).toBe(600_000);
    for (let i = 0; i < 200; i++) {
      const v = outboxBackoffMs(3, opts);
      expect(v).toBeGreaterThanOrEqual(6_400);
      expect(v).toBeLessThanOrEqual(8_000);
    }
  });
  it('a transient failure leaves the event PENDING with a scheduled retry, a safe error classification and no message', async () => {
    const ctx = build({
      deliver: async () => {
        throw new TypeError('connection reset by peer SECRET-TOKEN-123');
      },
    });
    const [event] = seedAggregate(ctx.store, A, 1);
    const before = pickImmutable(event);
    const summary = await ctx.dispatcher.dispatchConsumer(NAME);
    expect(summary).toMatchObject({ delivered: 0, retried: 1, deadLettered: 0 });
    const parked = row(ctx.store, event._id);
    expect(parked).toMatchObject({
      status: OutboxStatus.PENDING,
      attemptCount: 1,
      lastErrorClass: OutboxErrorClass.CONSUMER_ERROR,
      lastErrorName: 'TypeError',
    });
    expect(parked.nextAttemptAt).toEqual(new Date(ctx.state.now.getTime() + sec(2)));
    expect(parked.leaseToken).toBeUndefined();
    expect(JSON.stringify(parked)).not.toContain('SECRET-TOKEN-123');
    expect(JSON.stringify(parked)).not.toContain('connection reset');
    expect(pickImmutable(parked)).toBe(before);
  });
  it('respects the backoff (no early retry), then retries with a longer delay each time and finally succeeds', async () => {
    let failures = 2;
    const ctx = build({
      deliver: async () => {
        if (failures-- > 0) throw new Error('down');
      },
    });
    const [event] = seedAggregate(ctx.store, A, 1);
    await ctx.dispatcher.dispatchConsumer(NAME); // attempt 1 fails, retry in 2s
    ctx.advance(sec(1));
    expect((await ctx.dispatcher.dispatchConsumer(NAME)).scanned).toBe(0); // 1s < 2s: not due
    ctx.advance(sec(1));
    await ctx.dispatcher.dispatchConsumer(NAME); // attempt 2 fails, retry in 4s
    expect(row(ctx.store, event._id).nextAttemptAt).toEqual(
      new Date(ctx.state.now.getTime() + sec(4)),
    );
    ctx.advance(sec(4));
    await ctx.dispatcher.dispatchConsumer(NAME); // attempt 3 succeeds
    expect(row(ctx.store, event._id)).toMatchObject({
      status: OutboxStatus.PROCESSED,
      attemptCount: 3,
    });
    expect(ctx.consumer.deliver).toHaveBeenCalledTimes(3);
  });
  it('a consumer that is simply unavailable keeps every event and retries them all later', async () => {
    let up = false;
    const ctx = build({
      deliver: async () => {
        if (!up) throw new Error('ECONNREFUSED');
      },
    });
    const rows = [...seedAggregate(ctx.store, A, 2), ...seedAggregate(ctx.store, B, 2)];
    await ctx.dispatcher.dispatchConsumer(NAME);
    // The two heads failed (explicit PENDING + retry time); their successors were never touched (implicitly PENDING) — all four are still owed.
    expect(
      ctx.store.rows.filter((r) => outboxDeliveryStatus(r, NAME) === OutboxStatus.PENDING),
    ).toHaveLength(4);
    up = true;
    ctx.advance(sec(10));
    for (let i = 0; i < 4; i++) await ctx.dispatcher.dispatchConsumer(NAME);
    for (const r of rows) expect(row(ctx.store, r._id).status).toBe(OutboxStatus.PROCESSED);
  });
  it('a timed-out consumer is a transient failure (CONSUMER_TIMEOUT); a late answer from the abandoned call changes nothing', async () => {
    const hang = deferred();
    const ctx = build({ deliver: () => hang.promise });
    Object.defineProperty(ctx.dispatcher, 'consumerTimeoutMs', { get: () => 20 });
    const [event] = seedAggregate(ctx.store, A, 1);
    const summary = await ctx.dispatcher.dispatchConsumer(NAME);
    expect(summary.retried).toBe(1);
    expect(row(ctx.store, event._id)).toMatchObject({
      status: OutboxStatus.PENDING,
      lastErrorClass: OutboxErrorClass.CONSUMER_TIMEOUT,
    });
    hang.resolve();
    await ticks();
    expect(row(ctx.store, event._id).status).toBe(OutboxStatus.PENDING);
  });
  it('the per-delivery timeout is always strictly below the lease', () => {
    const { dispatcher, values } = build();
    expect(dispatcher.leaseMs).toBe(60_000);
    expect(dispatcher.consumerTimeoutMs).toBe(15_000);
    values.OUTBOX_LEASE_SECONDS = '20';
    values.OUTBOX_CONSUMER_TIMEOUT_SECONDS = '300';
    expect(dispatcher.consumerTimeoutMs).toBe(10_000);
    expect(dispatcher.consumerTimeoutMs).toBeLessThan(dispatcher.leaseMs);
  });
  it('exhausting the attempts dead-letters the event: it is kept intact, inspectable and never delivered again', async () => {
    const ctx = build({
      deliver: async () => {
        throw new Error('always');
      },
    }); // OUTBOX_MAX_ATTEMPTS = 3
    const [event] = seedAggregate(ctx.store, A, 1);
    const before = pickImmutable(event);
    for (let i = 0; i < 3; i++) {
      await ctx.dispatcher.dispatchConsumer(NAME);
      ctx.advance(sec(3_600));
    }
    const dead = row(ctx.store, event._id);
    expect(dead).toMatchObject({
      status: OutboxStatus.DEAD_LETTER,
      attemptCount: 3,
      lastErrorClass: OutboxErrorClass.CONSUMER_ERROR,
      deadLetteredAt: expect.any(Date),
    });
    expect(pickImmutable(dead)).toBe(before);
    expect(dead.leaseToken).toBeUndefined();
    await ctx.dispatcher.dispatchConsumer(NAME);
    expect(ctx.consumer.deliver).toHaveBeenCalledTimes(3);
    expect(ctx.store.rows).toHaveLength(1); // never deleted
  });
  it('a permanent consumer error dead-letters immediately, without further attempts', async () => {
    const ctx = build({
      deliver: async () => {
        throw new OutboxPermanentDeliveryError('unknown schemaVersion');
      },
    });
    const [event] = seedAggregate(ctx.store, A, 1);
    const summary = await ctx.dispatcher.dispatchConsumer(NAME);
    expect(summary).toMatchObject({ deadLettered: 1, retried: 0 });
    expect(row(ctx.store, event._id)).toMatchObject({
      status: OutboxStatus.DEAD_LETTER,
      attemptCount: 1,
      lastErrorClass: OutboxErrorClass.CONSUMER_PERMANENT,
      lastErrorName: 'OutboxPermanentDeliveryError',
    });
    expect(JSON.stringify(row(ctx.store, event._id))).not.toContain('unknown schemaVersion');
  });
  it('logs a dead letter with identifiers and classification only — no payload, no message', async () => {
    const ctx = build({
      deliver: async () => {
        throw new OutboxPermanentDeliveryError('secret detail');
      },
    });
    seedAggregate(ctx.store, A, 1);
    await ctx.dispatcher.dispatchConsumer(NAME);
    const logged = String(ctx.dispatcher.logger.error.mock.calls[0][0]);
    expect(logged).toContain('outbox_event_dead_lettered');
    expect(logged).toContain('CONSUMER_PERMANENT');
    expect(logged).not.toContain('secret detail');
    expect(logged).not.toContain('subjectAccountId');
    expect(logged).not.toContain('sequence');
  });
});
describe('claims, leases and abandoned work (MAZAD-031)', () => {
  it('a claim takes a lease: PROCESSING, a fresh token, this instance, nextAttemptAt = now + lease, attempt + 1', async () => {
    let during;
    const ctx = build({
      deliver: async () => {
        during = flat(ctx.store.rows[0]);
      },
    });
    seedAggregate(ctx.store, A, 1);
    await ctx.dispatcher.dispatchConsumer(NAME);
    expect(during).toMatchObject({
      status: OutboxStatus.PROCESSING,
      claimedBy: ctx.dispatcher.instanceId,
      attemptCount: 1,
    });
    expect(during.leaseToken).toEqual(expect.any(String));
    expect(during.nextAttemptAt).toEqual(new Date(ctx.state.now.getTime() + sec(60)));
  });
  it('an abandoned claim (worker died after claiming) is recovered once the lease expires, and not before', async () => {
    const ctx = build();
    const [event] = seedAggregate(ctx.store, A, 1);
    setDelivery(event, {
      status: OutboxStatus.PROCESSING,
      attemptCount: 1,
      leaseToken: 'dead-worker',
      claimedBy: 'gone-1',
      nextAttemptAt: new Date(ctx.state.now.getTime() + sec(60)),
    });
    ctx.advance(sec(59));
    expect((await ctx.dispatcher.dispatchConsumer(NAME)).scanned).toBe(0); // lease still live: not stolen
    expect(ctx.consumer.deliver).not.toHaveBeenCalled();
    ctx.advance(sec(2));
    const summary = await ctx.dispatcher.dispatchConsumer(NAME);
    expect(summary.delivered).toBe(1);
    expect(row(ctx.store, event._id)).toMatchObject({
      status: OutboxStatus.PROCESSED,
      attemptCount: 2,
    });
    expect(ctx.seen[0].attempt).toBe(2);
  });
  it('a row that keeps crashing its worker (claimed more times than allowed) is dead-lettered WITHOUT another delivery', async () => {
    const ctx = build(); // max attempts 3
    const [event] = seedAggregate(ctx.store, A, 1);
    setDelivery(event, {
      status: OutboxStatus.PROCESSING,
      attemptCount: 3,
      leaseToken: 'dead-worker',
      nextAttemptAt: new Date(ctx.state.now.getTime() - 1),
    });
    const summary = await ctx.dispatcher.dispatchConsumer(NAME);
    expect(summary.deadLettered).toBe(1);
    expect(ctx.consumer.deliver).not.toHaveBeenCalled();
    expect(row(ctx.store, event._id)).toMatchObject({
      status: OutboxStatus.DEAD_LETTER,
      lastErrorClass: OutboxErrorClass.LEASE_EXPIRED_MAX_ATTEMPTS,
    });
  });
  it('two dispatcher instances racing over the same events deliver each exactly once', async () => {
    const seenBy = { one: [], two: [] };
    const ctx = build();
    const ids = Array.from({ length: 12 }, () => new Types.ObjectId().toString());
    ids.forEach((id, i) =>
      ctx.store.seed({
        aggregateType: 'KYC',
        aggregateId: id,
        aggregateVersion: 1,
        occurredAt: new Date(T0.getTime() + i),
      }),
    );
    const make = (name) =>
      dispatcherWith(ctx, async (e) => {
        await ticks(3);
        seenBy[name].push(e.eventId);
      });
    const [one, two] = [make('one'), make('two')];
    expect(one.instanceId).not.toBe(two.instanceId);
    const [r1, r2] = await Promise.all([one.dispatchConsumer(NAME), two.dispatchConsumer(NAME)]);
    const all = [...seenBy.one, ...seenBy.two];
    expect(new Set(all).size).toBe(all.length); // no event handled twice
    expect(all).toHaveLength(12);
    expect(r1.delivered + r2.delivered).toBe(12);
    expect(r1.lostClaims + r2.lostClaims).toBeGreaterThan(0); // they really did contend
    expect(
      flatRows(ctx.store).every((r) => r.status === OutboxStatus.PROCESSED && r.attemptCount === 1),
    ).toBe(true);
  });
  it('a claim is atomic: of many simultaneous claim attempts on one event exactly one wins', async () => {
    const ctx = build();
    seedAggregate(ctx.store, A, 1);
    const dispatchers = Array.from({ length: 5 }, () => ctx.make());
    const summaries = await Promise.all(dispatchers.map((d) => d.dispatchConsumer(NAME)));
    expect(summaries.reduce((n, s) => n + s.delivered, 0)).toBe(1);
    expect(ctx.consumer.deliver).toHaveBeenCalledTimes(1);
  });
  it('a stale worker cannot overwrite a newer claim: its late acknowledgement matches nothing and the event stays as the newer claim left it', async () => {
    const slow = deferred();
    const ctx = build();
    const [event] = seedAggregate(ctx.store, A, 1);
    const workerA = dispatcherWith(ctx, () => slow.promise);
    const pendingA = workerA.dispatchConsumer(NAME); // A claims and hangs inside its consumer
    await ticks();
    expect(row(ctx.store, event._id).status).toBe(OutboxStatus.PROCESSING);
    ctx.advance(sec(61)); // A's lease expires
    const summaryB = await ctx.dispatcher.dispatchConsumer(NAME); // B reclaims and completes
    expect(summaryB.delivered).toBe(1);
    const processedAt = row(ctx.store, event._id).processedAt;
    slow.resolve(); // A's consumer finally answers
    const summaryA = await pendingA;
    expect(summaryA).toMatchObject({ delivered: 0, unconfirmed: 1 });
    expect(row(ctx.store, event._id)).toMatchObject({
      status: OutboxStatus.PROCESSED,
      attemptCount: 2,
      processedAt,
    });
  });
});
describe('process-loss models: at-least-once redelivery (MAZAD-031)', () => {
  it('consumer succeeded but the acknowledgement was never stored: the event is redelivered after the lease, with the SAME event id', async () => {
    const ctx = build();
    const [event] = seedAggregate(ctx.store, A, 1);
    ctx.store.updateError = (_f, update) =>
      update.$set?.[`delivery.${NAME}.status`] === OutboxStatus.PROCESSED
        ? new Error('db unavailable')
        : undefined;
    const first = await ctx.dispatcher.dispatchConsumer(NAME);
    expect(first).toMatchObject({ delivered: 0, unconfirmed: 1 });
    expect(row(ctx.store, event._id).status).toBe(OutboxStatus.PROCESSING); // not falsely marked delivered
    ctx.store.updateError = undefined;
    ctx.advance(sec(61));
    await ctx.dispatcher.dispatchConsumer(NAME);
    expect(row(ctx.store, event._id).status).toBe(OutboxStatus.PROCESSED);
    expect(ctx.seen.map((e) => e.eventId)).toEqual([event._id.toString(), event._id.toString()]); // duplicate delivery: consumers dedupe on eventId
    expect(ctx.seen.map((e) => e.attempt)).toEqual([1, 2]);
  });
  it('the failure marker could not be stored either: the lease expiry is the retry schedule, nothing is lost', async () => {
    let fail = true;
    const ctx = build({
      deliver: async () => {
        if (fail) throw new Error('boom');
      },
    });
    const [event] = seedAggregate(ctx.store, A, 1);
    ctx.store.updateError = (_f, update) =>
      update.$set?.[`delivery.${NAME}.status`] === OutboxStatus.PENDING
        ? new Error('db unavailable')
        : undefined; // only the failure marker write fails, not the claim
    expect((await ctx.dispatcher.dispatchConsumer(NAME)).unconfirmed).toBe(1);
    expect(row(ctx.store, event._id).status).toBe(OutboxStatus.PROCESSING);
    ctx.store.updateError = undefined;
    fail = false;
    ctx.advance(sec(61));
    await ctx.dispatcher.dispatchConsumer(NAME);
    expect(row(ctx.store, event._id).status).toBe(OutboxStatus.PROCESSED);
  });
  it('a whole dispatcher restarting (new instance, no memory) picks up exactly where the durable state left off', async () => {
    const ctx = build();
    seedAggregate(ctx.store, A, 3);
    await ctx.dispatcher.dispatchConsumer(NAME, 1); // process dies after the first event
    const restarted = ctx.make();
    await restarted.dispatchConsumer(NAME);
    expect(ctx.seen.map((e) => e.aggregateVersion)).toEqual([1, 2, 3]);
  });
});
describe('ordering per aggregate; poison events never block the queue (MAZAD-031)', () => {
  it("delivers one aggregate's events strictly in version order however they were stored or scanned", async () => {
    const ctx = build();
    const rows = seedAggregate(ctx.store, A, 4);
    ctx.store.rows.reverse(); // storage order must not matter
    rows[0].occurredAt = new Date(T0.getTime() + 50); // even a later-occurring v1 must still go first
    for (let i = 0; i < 5; i++) await ctx.dispatcher.dispatchConsumer(NAME);
    expect(ctx.seen.map((e) => e.aggregateVersion)).toEqual([1, 2, 3, 4]);
  });
  it('never runs version N+1 while version N is being retried: a failing head holds back only its own aggregate', async () => {
    const ctx = build({
      deliver: async (e) => {
        if (e.aggregateId === A && e.aggregateVersion === 1) throw new Error('flaky');
      },
    });
    seedAggregate(ctx.store, A, 3);
    seedAggregate(ctx.store, B, 3);
    const summary = await ctx.dispatcher.dispatchConsumer(NAME);
    expect(ctx.seen.filter((e) => e.aggregateId === A).map((e) => e.aggregateVersion)).toEqual([1]); // A2/A3 not attempted
    expect(ctx.seen.filter((e) => e.aggregateId === B).map((e) => e.aggregateVersion)).toEqual([
      1, 2, 3,
    ]); // B unaffected
    expect(summary).toMatchObject({ delivered: 3, retried: 1 });
    // A's successors stay pending, untouched (zero attempts), until v1 succeeds.
    expect(
      flatRows(ctx.store)
        .filter((r) => r.aggregateId === A && r.aggregateVersion > 1)
        .every((r) => (r.attemptCount ?? 0) === 0),
    ).toBe(true);
  });
  it('keeps the successors back on LATER passes too, while their predecessor sits in backoff (not just within one pass)', async () => {
    let up = false;
    const ctx = build({
      deliver: async (e) => {
        if (e.aggregateId === A && e.aggregateVersion === 1 && !up) throw new Error('flaky');
      },
    });
    seedAggregate(ctx.store, A, 3);
    await ctx.dispatcher.dispatchConsumer(NAME); // v1 fails → PENDING, retry in 2s
    ctx.advance(sec(1)); // v1 not due yet; v2/v3 ARE due but must not jump the queue
    const during = await ctx.dispatcher.dispatchConsumer(NAME);
    expect(during.blockedAggregates).toBe(1);
    expect(ctx.seen.filter((e) => e.aggregateId === A).map((e) => e.aggregateVersion)).toEqual([1]);
    up = true;
    ctx.advance(sec(2)); // v1 due again and now succeeds; v2, v3 follow in order
    await ctx.dispatcher.dispatchConsumer(NAME);
    expect(ctx.seen.filter((e) => e.aggregateId === A).map((e) => e.aggregateVersion)).toEqual([
      1, 1, 2, 3,
    ]);
  });
  it("a stuck aggregate's large backlog cannot starve newer aggregates: blocked aggregates are excluded from follow-up scans", async () => {
    const ctx = build({
      deliver: async (e) => {
        if (e.aggregateId === A) throw new Error('consumer cannot handle A');
      },
    });
    seedAggregate(ctx.store, A, 12, 0); // 12 older due events, head failing → the other 11 stay due but blocked
    seedAggregate(ctx.store, B, 2, 100); // newer aggregates behind them (all due at the fake clock's T0+1s)
    seedAggregate(ctx.store, C, 1, 200);
    const summary = await ctx.dispatcher.dispatchConsumer(NAME, 3); // batch 3 ⇒ one scan looks at only 12 rows — all of them A's
    expect(ctx.seen.filter((e) => e.aggregateId === B).map((e) => e.aggregateVersion)).toEqual([
      1, 2,
    ]);
    expect(summary.retried).toBe(1); // A's head failed once…
    expect(ctx.seen.filter((e) => e.aggregateId === A)).toHaveLength(1); // …and its successors were never attempted
    // …and again on the next pass while A's head is still in backoff and its 11 successors are due.
    seedAggregate(ctx.store, '64b0000000000000000aa009', 1, 300);
    await ctx.dispatcher.dispatchConsumer(NAME, 3);
    expect(ctx.seen.filter((e) => e.aggregateId === C)).toHaveLength(1);
    expect(ctx.seen.filter((e) => e.aggregateId === '64b0000000000000000aa009')).toHaveLength(1);
    expect(ctx.seen.filter((e) => e.aggregateId === A)).toHaveLength(1); // A stays held back the whole time
  });
  it("does not start version N+1 while N is PROCESSING under another instance's live lease", async () => {
    const ctx = build();
    const rows = seedAggregate(ctx.store, A, 2);
    setDelivery(rows[0], {
      status: OutboxStatus.PROCESSING,
      attemptCount: 1,
      leaseToken: 'other',
      claimedBy: 'other-1',
      nextAttemptAt: new Date(ctx.state.now.getTime() + sec(30)),
    });
    const summary = await ctx.dispatcher.dispatchConsumer(NAME);
    expect(summary.blockedAggregates).toBe(1);
    expect(ctx.consumer.deliver).not.toHaveBeenCalled();
  });
  it('a poison event (permanent failure) is dead-lettered and its successors then proceed in the same pass', async () => {
    const ctx = build({
      deliver: async (e) => {
        if (e.aggregateId === A && e.aggregateVersion === 1)
          throw new OutboxPermanentDeliveryError();
      },
    });
    seedAggregate(ctx.store, A, 3);
    seedAggregate(ctx.store, B, 2);
    const summary = await ctx.dispatcher.dispatchConsumer(NAME);
    expect(summary).toMatchObject({ deadLettered: 1, delivered: 4 });
    expect(flatRows(ctx.store).filter((r) => r.status === OutboxStatus.DEAD_LETTER)).toHaveLength(
      1,
    );
    expect(flatRows(ctx.store).filter((r) => r.status === OutboxStatus.PROCESSED)).toHaveLength(4);
  });
  it('an unrelated aggregate is delivered in the same pass even when a earlier-due event is failing', async () => {
    const ctx = build({
      deliver: async (e) => {
        if (e.aggregateId === A) throw new Error('bad consumer state for A');
      },
    });
    seedAggregate(ctx.store, A, 1, 0);
    seedAggregate(ctx.store, B, 1, 10);
    await ctx.dispatcher.dispatchConsumer(NAME);
    expect(flatRows(ctx.store).find((r) => r.aggregateId === B).status).toBe(
      OutboxStatus.PROCESSED,
    );
    expect(flatRows(ctx.store).find((r) => r.aggregateId === A).status).toBe(OutboxStatus.PENDING);
  });
  it('two instances over one aggregate still deliver its events in version order, one at a time', async () => {
    const ctx = build();
    seedAggregate(ctx.store, A, 5);
    let active = 0;
    let maxActive = 0;
    const order = [];
    const handler = async (e) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await ticks(4);
      order.push(e.aggregateVersion);
      active--;
    };
    const [one, two] = [dispatcherWith(ctx, handler), dispatcherWith(ctx, handler)];
    for (let i = 0; i < 6; i++)
      await Promise.all([one.dispatchConsumer(NAME), two.dispatchConsumer(NAME)]);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(maxActive).toBe(1);
  });
});
describe('the dispatcher only ever touches delivery metadata, and never deletes (MAZAD-031)', () => {
  it('leaves every immutable event field byte-identical across success, retry, dead letter and reclaim; updates set only delivery fields', async () => {
    let n = 0;
    const ctx = build({
      deliver: async () => {
        n++;
        if (n === 1) throw new Error('x');
        if (n === 2) throw new OutboxPermanentDeliveryError();
      },
    });
    const rows = [
      ...seedAggregate(ctx.store, A, 1),
      ...seedAggregate(ctx.store, B, 1),
      ...seedAggregate(ctx.store, C, 1),
    ];
    const before = rows.map(pickImmutable);
    for (let i = 0; i < 4; i++) {
      await ctx.dispatcher.dispatchConsumer(NAME);
      ctx.advance(sec(3_600));
    }
    expect(rows.map((r) => pickImmutable(row(ctx.store, r._id)))).toEqual(before);
    const allowed = new Set([
      'status',
      'claimedBy',
      'leaseToken',
      'claimedAt',
      'lastAttemptAt',
      'nextAttemptAt',
      'processedAt',
      'deadLetteredAt',
      'lastErrorClass',
      'lastErrorName',
      'attemptCount',
    ]);
    for (const { update } of ctx.store.updates) {
      for (const key of [
        ...Object.keys(update.$set ?? {}),
        ...Object.keys(update.$unset ?? {}),
        ...Object.keys(update.$inc ?? {}),
      ]) {
        expect(key.startsWith(`delivery.${NAME}.`)).toBe(true); // ONLY this consumer's own delivery sub-document
        expect(allowed.has(key.slice(`delivery.${NAME}.`.length))).toBe(true);
      }
    }
    expect(ctx.store.rows).toHaveLength(3);
  });
});
describe('OutboxDispatcherWorker (MAZAD-031)', () => {
  const workerOf = (ctx, values = {}) => {
    const worker = new OutboxDispatcherWorker(ctx.dispatcher, ctx.registry, {
      get: (k) => values[k],
    });
    worker.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return worker;
  };
  it('is disabled under NODE_ENV=test unless explicitly enabled, and has a 1s minimum interval', () => {
    const ctx = build();
    expect(workerOf(ctx, { NODE_ENV: 'test' }).enabled).toBe(false);
    expect(workerOf(ctx, { NODE_ENV: 'production' }).enabled).toBe(true);
    expect(workerOf(ctx, { NODE_ENV: 'test', OUTBOX_DISPATCHER_ENABLED: 'true' }).enabled).toBe(
      true,
    );
    expect(
      workerOf(ctx, { OUTBOX_DISPATCHER_ENABLED: 'false', NODE_ENV: 'production' }).enabled,
    ).toBe(false);
    expect(workerOf(ctx).intervalMs).toBe(5_000);
    expect(workerOf(ctx, { OUTBOX_DISPATCHER_INTERVAL_SECONDS: '1' }).intervalMs).toBe(1_000);
  });
  it('arms its timer when enabled, not when disabled, and stops cleanly', async () => {
    const ctx = build();
    const worker = workerOf(ctx, { OUTBOX_DISPATCHER_ENABLED: 'true' });
    worker.onApplicationBootstrap();
    expect(worker.timer).toBeDefined();
    await worker.onModuleDestroy();
    const disabled = workerOf(ctx, { OUTBOX_DISPATCHER_ENABLED: 'false' });
    disabled.onApplicationBootstrap();
    expect(disabled.timer).toBeUndefined();
  });
  it('runOnce dispatches every registered consumer, records each summary, never overlaps a consumer with itself, and survives a failing pass', async () => {
    const ctx = build();
    seedAggregate(ctx.store, A, 1);
    const worker = workerOf(ctx);
    const first = worker.runOnce();
    await expect(worker.runOnce()).resolves.toEqual({}); // that consumer is already running a pass (a scheduling nicety; correctness is in the DB claim)
    await expect(first).resolves.toMatchObject({ [NAME]: { consumer: NAME, delivered: 1 } });
    expect(worker.lastSummaries.get(NAME)).toMatchObject({ delivered: 1 });
    const failing = workerOf(ctx);
    jest
      .spyOn(ctx.dispatcher, 'dispatchConsumer')
      .mockRejectedValueOnce(new Error('mongo down: mongodb://user:pass@host'));
    await expect(failing.runOnce()).resolves.toEqual({ [NAME]: null });
    const logged = String(failing.logger.error.mock.calls[0][0]);
    expect(logged).toContain('outbox_dispatch_run_failed');
    expect(logged).toContain(NAME);
    expect(logged).not.toContain('pass'); // error name only, never the message
  });
});
describe('Explicit service wiring (MAZAD-031)', () => {
  it('resolves the outbox providers with an EMPTY registry, follows worker lifecycle, and serves a consumer registered later by another module', async () => {
    const store = new FakeOutboxStore();
    const registry = new OutboxConsumerRegistry();
    const config = { get: (key) => (key === 'NODE_ENV' ? 'test' : undefined) };
    const dispatcher = new OutboxDispatcherService(
      store.model,
      registry,
      { now: () => new Date() },
      config,
    );
    const worker = new OutboxDispatcherWorker(dispatcher, registry, config);
    worker.onApplicationBootstrap();
    expect(registry.list()).toEqual([]);
    expect(worker.enabled).toBe(false); // NODE_ENV=test
    expect(worker.timer).toBeUndefined();
    store.seed({ aggregateType: 'KYC', aggregateId: A, aggregateVersion: 1 });
    await expect(worker.runOnce()).resolves.toEqual({});
    expect(store.rows[0].delivery).toBeUndefined();
    // A future module (e.g. MAZAD-032) registers itself — no change to OutboxModule, producers or any other consumer.
    const received = [];
    registry.register({
      name: 'secondary',
      subscribedTypes: [OutboxEventType.KYC_APPROVED],
      configured: true,
      deliver: async (e) => {
        received.push(e.eventId);
      },
    });
    await expect(worker.runOnce()).resolves.toMatchObject({ secondary: { delivered: 1 } });
    expect(received).toEqual([store.rows[0]._id.toString()]);
    await worker.onModuleDestroy();
  });
  it('is imported by every module that produces events, and by the app', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../src/config/services.js'),
      'utf8',
    );
    expect(source).toContain('services.OutboxService');
  });
});
describe('OutboxWakeup — after-commit dispatch hint (secondary hardening)', () => {
  const { OutboxWakeup } = require('../src/domain/outbox/outbox-wakeup');
  const quiet = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });
  const started = (
    ctx,
    wakeup,
    values = { OUTBOX_DISPATCHER_ENABLED: 'true', OUTBOX_DISPATCHER_INTERVAL_SECONDS: '3600' },
  ) => {
    const worker = new OutboxDispatcherWorker(
      ctx.dispatcher,
      ctx.registry,
      { get: (k) => values[k] },
      wakeup,
    );
    worker.logger = quiet();
    worker.onApplicationBootstrap(); // the periodic tick is armed but an hour away: only the wake-up can dispatch in these tests
    return worker;
  };
  afterEach(() => jest.useRealTimers());
  it('a notification dispatches committed events at once, without waiting for the periodic tick', async () => {
    const ctx = build();
    const wakeup = new OutboxWakeup();
    const worker = started(ctx, wakeup);
    seedAggregate(ctx.store, A, 1);
    wakeup.notify();
    await ticks(60);
    expect(ctx.seen.map((e) => e.aggregateVersion)).toEqual([1]);
    expect(row(ctx.store, ctx.store.rows[0]._id).status).toBe(OutboxStatus.PROCESSED);
    await worker.onModuleDestroy();
  });
  it('a notification during a running pass causes exactly one more pass, which delivers the event committed after the scan', async () => {
    const gate = deferred();
    let calls = 0;
    const ctx = build({
      deliver: async () => {
        if (calls++ === 0) await gate.promise;
      },
    });
    const wakeup = new OutboxWakeup();
    const worker = started(ctx, wakeup);
    const passes = jest.spyOn(ctx.dispatcher, 'dispatchConsumer');
    seedAggregate(ctx.store, A, 1);
    wakeup.notify();
    await ticks(40); // pass 1 has scanned and is blocked delivering A v1
    seedAggregate(ctx.store, B, 1); // committed AFTER pass 1's scan
    wakeup.notify();
    wakeup.notify();
    wakeup.notify(); // several hints while running collapse into ONE re-run
    expect(passes).toHaveBeenCalledTimes(1);
    gate.resolve();
    await ticks(120);
    expect(passes).toHaveBeenCalledTimes(2);
    expect(ctx.seen.map((e) => e.aggregateId)).toEqual([A, B]);
    expect(ctx.consumer.deliver).toHaveBeenCalledTimes(2); // nothing delivered twice
    await worker.onModuleDestroy();
  });
  it('without any notification (lost or never sent) the periodic tick still delivers', async () => {
    jest.useFakeTimers();
    const ctx = build();
    const wakeup = new OutboxWakeup();
    const worker = started(ctx, wakeup, {
      OUTBOX_DISPATCHER_ENABLED: 'true',
      OUTBOX_DISPATCHER_INTERVAL_SECONDS: '1',
    });
    seedAggregate(ctx.store, A, 2);
    expect(ctx.seen).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(ctx.seen.map((e) => e.aggregateVersion)).toEqual([1, 2]);
    expect(wakeup.notified).toBe(0);
    await worker.onModuleDestroy();
  });
  it('a burst of notifications keeps per-property order and never duplicates a delivery', async () => {
    const ctx = build();
    const wakeup = new OutboxWakeup();
    const worker = started(ctx, wakeup);
    for (let v = 1; v <= 5; v++) {
      ctx.store.seed({
        aggregateType: 'KYC',
        aggregateId: A,
        aggregateVersion: v,
        type: 'KYC_APPROVED',
        occurredAt: new Date(T0.getTime() + v),
        payload: { propertyId: A, sequence: v },
      });
      wakeup.notify();
      await ticks(3);
    }
    await ticks(300);
    expect(ctx.seen.map((e) => e.aggregateVersion)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(ctx.seen.map((e) => e.eventId)).size).toBe(5);
    await worker.onModuleDestroy();
  });
  it('is ignored before start, when the dispatcher is disabled, for an unconfigured consumer, and after shutdown', async () => {
    const ctx = build();
    const wakeup = new OutboxWakeup();
    const passes = jest.spyOn(ctx.dispatcher, 'dispatchConsumer');
    const notStarted = new OutboxDispatcherWorker(
      ctx.dispatcher,
      ctx.registry,
      { get: () => undefined },
      wakeup,
    );
    notStarted.onWakeup();
    const disabled = started(ctx, wakeup, { OUTBOX_DISPATCHER_ENABLED: 'false' });
    wakeup.notify();
    expect(passes).not.toHaveBeenCalled();
    const off = build({ configured: false });
    const offWorker = started(off, new OutboxWakeup());
    const offPasses = jest.spyOn(off.dispatcher, 'dispatchConsumer');
    offWorker.onWakeup();
    expect(offPasses).not.toHaveBeenCalled();
    const worker = started(ctx, wakeup);
    await worker.onModuleDestroy();
    wakeup.notify();
    expect(passes).not.toHaveBeenCalled();
    await disabled.onModuleDestroy();
    await offWorker.onModuleDestroy();
  });
  it('a failing listener never reaches the producer', () => {
    const wakeup = new OutboxWakeup();
    wakeup.logger = quiet();
    const after = jest.fn();
    wakeup.subscribe(() => {
      throw new Error('boom');
    });
    wakeup.subscribe(after);
    expect(() => wakeup.notify()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });
  it('is provided and exported by OutboxModule (one instance shared by producers and the worker)', () => {
    const wakeup = new OutboxWakeup();
    const ctx = build();
    const worker = new OutboxDispatcherWorker(
      ctx.dispatcher,
      ctx.registry,
      { get: () => 'test' },
      wakeup,
    );
    expect(worker.wakeup).toBe(wakeup);
  });
});
