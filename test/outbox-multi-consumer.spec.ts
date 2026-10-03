import * as fs from 'node:fs';
import * as path from 'node:path';

import { OutboxConsumerRegistry, OutboxEventConsumer, OutboxPermanentDeliveryError } from '../src/outbox/outbox-consumer.port';
import { OutboxDispatcherService } from '../src/outbox/outbox-dispatcher.service';
import { OutboxDispatcherWorker } from '../src/outbox/outbox-dispatcher.worker';
import { OutboxEventDraft, OutboxEventType, propertyDecisionEvent } from '../src/outbox/outbox-events';
import { OutboxErrorClass, OutboxStatus, outboxConsumerScanIndexName, outboxDeliveryStatus } from '../src/outbox/outbox.constants';
import { FakeMongo } from './support/fake-payments-mongo';

/**
 * MAZAD-031 closure — ONE immutable domain event, INDEPENDENT delivery progress per
 * consumer. Events are written through the real `OutboxService` inside fake
 * transactions (the producer path); consumers are plain test doubles named
 * `secondary` and `notifications` — no secondary or notification behaviour exists.
 * In-memory MODEL of MongoDB: real-Mongo qualification is still required.
 */
const T0 = new Date('2026-05-08T10:00:00Z');
const sec = (n: number) => n * 1000;
const A = '64b0000000000000000aa001';
const B = '64b0000000000000000aa002';
const C = '64b0000000000000000aa003';
const RECIPIENT = '64b000000000000000000a11';
const ALL = Object.values(OutboxEventType);

const revisionEvent = (property: string, sequence: number): OutboxEventDraft => propertyDecisionEvent({ propertyId: property, revisionId: property, occurredAt: new Date(T0.getTime() + sequence), decision: 'approved', decisionVersion: sequence, advertiserAccountId: RECIPIENT });
const rejected = (property: string): OutboxEventDraft => propertyDecisionEvent({ propertyId: property, revisionId: property, occurredAt: new Date(T0.getTime() + 500), decision: 'rejected', decisionVersion: 4, advertiserAccountId: RECIPIENT });

type ConsumerSpec = { name: string; types?: OutboxEventType[]; deliver?: (event: any) => Promise<void> };

function build(specs: ConsumerSpec[] = [{ name: 'secondary' }, { name: 'notifications' }], values: Record<string, string> = {}) {
  const mongo = new FakeMongo();
  const store = mongo.outbox;
  const state = { now: new Date(T0.getTime() + sec(1)) };
  const clock = { now: jest.fn(() => new Date(state.now)) };
  const registry = new OutboxConsumerRegistry();
  const seen: Record<string, any[]> = {};
  const handlers: Record<string, (event: any) => Promise<void>> = {};
  const consumers: Record<string, OutboxEventConsumer & { deliver: jest.Mock }> = {};
  const add = (spec: ConsumerSpec) => {
    seen[spec.name] = [];
    handlers[spec.name] = spec.deliver ?? (async () => undefined);
    const consumer = {
      name: spec.name, subscribedTypes: spec.types ?? ALL, configured: true,
      deliver: jest.fn(async (event: any) => { seen[spec.name].push(event); await handlers[spec.name](event); }),
    } as any;
    consumers[spec.name] = consumer;
    registry.register(consumer);
  };
  specs.forEach(add);
  const config = { get: (key: string) => ({ OUTBOX_MAX_ATTEMPTS: '3', ...values })[key] } as any;
  const make = () => {
    const dispatcher = new OutboxDispatcherService(store.model, registry, clock as any, config);
    dispatcher.random = () => 1;
    (dispatcher as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return dispatcher;
  };
  const dispatcher = make();
  const advance = (ms: number) => { state.now = new Date(state.now.getTime() + ms); };
  /** The PRODUCER path: one business transaction records one event (commit), or is aborted. */
  const record = async (draft: OutboxEventDraft, commit = true) => {
    const session: any = await mongo.connection.startSession();
    session.startTransaction();
    try {
      const recorded = await store.service.recordRequired(draft, session);
      if (commit) await session.commitTransaction(); else await session.abortTransaction();
      return recorded;
    } finally { await session.endSession(); }
  };
  const event = (aggregateId: string, version: number) => store.rows.find((r) => r.aggregateId === aggregateId && r.aggregateVersion === version)!;
  const d = (aggregateId: string, version: number, name: string) => event(aggregateId, version).delivery?.[name] ?? {};
  const versionsSeen = (name: string, aggregateId = A) => seen[name].filter((e) => e.aggregateId === aggregateId).map((e) => e.aggregateVersion);
  return { mongo, store, state, clock, registry, seen, consumers, handlers, dispatcher, make, advance, record, event, d, versionsSeen, add, values };
}
const ticks = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
function deferred<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const IMMUTABLE = ['_id', 'type', 'schemaVersion', 'aggregateType', 'aggregateId', 'aggregateVersion', 'occurredAt', 'audience', 'payload', 'privateRouting', 'createdAt'];
const pickImmutable = (r: any) => JSON.stringify(IMMUTABLE.map((k) => r[k]));

describe('one event, independent delivery state per consumer (MAZAD-031 closure)', () => {
  it('secondary PROCESSED while notifications is PENDING is a valid state, and secondary never completes notifications', async () => {
    const ctx = build();
    await ctx.record(revisionEvent(A, 1));
    await ctx.dispatcher.dispatchConsumer('secondary');
    expect(outboxDeliveryStatus(ctx.event(A, 1), 'secondary')).toBe(OutboxStatus.PROCESSED);
    expect(outboxDeliveryStatus(ctx.event(A, 1), 'notifications')).toBe(OutboxStatus.PENDING);
    expect(ctx.event(A, 1).delivery).not.toHaveProperty('notifications'); // notifications has not even been touched
    expect(ctx.consumers.notifications.deliver).not.toHaveBeenCalled();
    // …and it is still owed: notifications now receives it and completes independently.
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.d(A, 1, 'notifications')).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 1 });
    expect(ctx.d(A, 1, 'secondary')).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 1 });
    expect(ctx.store.rows).toHaveLength(1); // still ONE event
  });

  it('a consumer only ever writes its own delivery sub-document', async () => {
    const ctx = build();
    await ctx.record(revisionEvent(A, 1));
    await ctx.dispatcher.dispatchConsumer('secondary');
    for (const { filter, update } of ctx.store.updates) {
      for (const key of [...Object.keys(update.$set ?? {}), ...Object.keys(update.$unset ?? {}), ...Object.keys(update.$inc ?? {})]) expect(key.startsWith('delivery.secondary.')).toBe(true);
      expect(JSON.stringify(filter)).not.toContain('notifications');
    }
  });

  it('one consumer failing never blocks another: both run in the same tick, one retrying, one done', async () => {
    const ctx = build([{ name: 'secondary', deliver: async () => { throw new Error('socket hub down'); } }, { name: 'notifications' }]);
    await ctx.record(revisionEvent(A, 1));
    const [rt, nt] = await Promise.all([ctx.dispatcher.dispatchConsumer('secondary'), ctx.dispatcher.dispatchConsumer('notifications')]);
    expect(rt).toMatchObject({ retried: 1, delivered: 0 });
    expect(nt).toMatchObject({ delivered: 1, retried: 0 });
    expect(ctx.d(A, 1, 'secondary')).toMatchObject({ status: OutboxStatus.PENDING, lastErrorClass: OutboxErrorClass.CONSUMER_ERROR });
    expect(ctx.d(A, 1, 'notifications')).toMatchObject({ status: OutboxStatus.PROCESSED });
    expect(ctx.d(A, 1, 'notifications')).not.toHaveProperty('lastErrorClass'); // secondary's failure left no trace on notifications
  });

  it('retry counters and backoff schedules are independent', async () => {
    let secondaryUp = false;
    const ctx = build([
      { name: 'secondary', deliver: async () => { if (!secondaryUp) throw new Error('down'); } },
      { name: 'notifications' },
    ]);
    await ctx.record(revisionEvent(A, 1));
    await ctx.dispatcher.dispatchConsumer('secondary'); // secondary attempt 1 fails → retry in 2s
    ctx.advance(sec(2));
    await ctx.dispatcher.dispatchConsumer('secondary'); // attempt 2 fails → retry in 4s
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.d(A, 1, 'secondary')).toMatchObject({ status: OutboxStatus.PENDING, attemptCount: 2, nextAttemptAt: new Date(ctx.state.now.getTime() + sec(4)) });
    expect(ctx.d(A, 1, 'notifications')).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 1 });
    secondaryUp = true; ctx.advance(sec(4));
    await ctx.dispatcher.dispatchConsumer('secondary');
    expect(ctx.d(A, 1, 'secondary')).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 3 });
    expect(ctx.d(A, 1, 'notifications').attemptCount).toBe(1); // unchanged
    expect(ctx.seen.secondary.map((e) => e.attempt)).toEqual([1, 2, 3]); // each consumer sees ITS OWN attempt number
    expect(ctx.seen.notifications.map((e) => e.attempt)).toEqual([1]);
  });

  it('leases are independent: each consumer holds its own lease token on the same event at the same time', async () => {
    const hang = deferred();
    const ctx = build([{ name: 'secondary', deliver: () => hang.promise }, { name: 'notifications' }]);
    await ctx.record(revisionEvent(A, 1));
    const pendingRealtime = ctx.dispatcher.dispatchConsumer('secondary'); // claims and hangs
    await ticks();
    const secondaryLease = { ...ctx.d(A, 1, 'secondary') };
    expect(secondaryLease).toMatchObject({ status: OutboxStatus.PROCESSING, claimedBy: ctx.dispatcher.instanceId });
    await ctx.dispatcher.dispatchConsumer('notifications'); // does not wait for, or steal, secondary's lease
    expect(ctx.d(A, 1, 'notifications')).toMatchObject({ status: OutboxStatus.PROCESSED });
    expect(ctx.d(A, 1, 'notifications').leaseToken).toBeUndefined();
    expect(ctx.d(A, 1, 'secondary')).toMatchObject({ status: OutboxStatus.PROCESSING, leaseToken: secondaryLease.leaseToken, nextAttemptAt: secondaryLease.nextAttemptAt });
    hang.resolve();
    await pendingRealtime;
    expect(ctx.d(A, 1, 'secondary')).toMatchObject({ status: OutboxStatus.PROCESSED });
  });

  it('lease expiry is independent: a crashed secondary worker is reclaimed without touching notifications\' PROCESSED state', async () => {
    const ctx = build();
    await ctx.record(revisionEvent(A, 1));
    await ctx.dispatcher.dispatchConsumer('notifications');
    const processedAt = ctx.d(A, 1, 'notifications').processedAt;
    // Simulate: secondary claimed the event and its worker died (lease live, then expired).
    ctx.event(A, 1).delivery.secondary = { status: OutboxStatus.PROCESSING, attemptCount: 1, leaseToken: 'dead-worker', claimedBy: 'gone', nextAttemptAt: new Date(ctx.state.now.getTime() + sec(60)) };
    ctx.advance(sec(30));
    expect((await ctx.dispatcher.dispatchConsumer('secondary')).scanned).toBe(0); // lease live: not stolen
    ctx.advance(sec(31));
    await ctx.dispatcher.dispatchConsumer('secondary');
    expect(ctx.d(A, 1, 'secondary')).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 2 });
    expect(ctx.d(A, 1, 'notifications')).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 1, processedAt });
    expect(ctx.consumers.notifications.deliver).toHaveBeenCalledTimes(1);
  });

  it('dead letter is per consumer: secondary PROCESSED, notifications DEAD_LETTER, the immutable event untouched', async () => {
    const ctx = build([{ name: 'secondary' }, { name: 'notifications', deliver: async () => { throw new OutboxPermanentDeliveryError('cannot render'); } }]);
    await ctx.record(revisionEvent(A, 1));
    const before = pickImmutable(ctx.event(A, 1));
    await ctx.dispatcher.dispatchConsumer('secondary');
    const summary = await ctx.dispatcher.dispatchConsumer('notifications');
    expect(summary).toMatchObject({ deadLettered: 1, delivered: 0 });
    expect(ctx.d(A, 1, 'secondary')).toMatchObject({ status: OutboxStatus.PROCESSED });
    expect(ctx.d(A, 1, 'notifications')).toMatchObject({ status: OutboxStatus.DEAD_LETTER, lastErrorClass: OutboxErrorClass.CONSUMER_PERMANENT, deadLetteredAt: expect.any(Date) });
    expect(pickImmutable(ctx.event(A, 1))).toBe(before);
    expect(ctx.store.rows).toHaveLength(1); // never deleted
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.consumers.notifications.deliver).toHaveBeenCalledTimes(1); // and never redelivered to the consumer that dead-lettered it
  });

  it('attempts are exhausted per consumer: secondary dead-letters after its own max attempts while notifications is at attempt 1', async () => {
    const ctx = build([{ name: 'secondary', deliver: async () => { throw new Error('always'); } }, { name: 'notifications' }]); // max attempts 3
    await ctx.record(revisionEvent(A, 1));
    for (let i = 0; i < 3; i++) { await ctx.dispatcher.dispatchConsumer('secondary'); ctx.advance(sec(3_600)); }
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.d(A, 1, 'secondary')).toMatchObject({ status: OutboxStatus.DEAD_LETTER, attemptCount: 3 });
    expect(ctx.d(A, 1, 'notifications')).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 1 });
  });

  it('a crash-looping delivery is dead-lettered for that consumer only, without another attempt', async () => {
    const ctx = build();
    await ctx.record(revisionEvent(A, 1));
    ctx.event(A, 1).delivery = { secondary: { status: OutboxStatus.PROCESSING, attemptCount: 3, leaseToken: 'dead', nextAttemptAt: new Date(ctx.state.now.getTime() - 1) } };
    await ctx.dispatcher.dispatchConsumer('secondary');
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.d(A, 1, 'secondary')).toMatchObject({ status: OutboxStatus.DEAD_LETTER, lastErrorClass: OutboxErrorClass.LEASE_EXPIRED_MAX_ATTEMPTS });
    expect(ctx.consumers.secondary.deliver).not.toHaveBeenCalled();
    expect(ctx.d(A, 1, 'notifications')).toMatchObject({ status: OutboxStatus.PROCESSED });
  });

  it('one immutable payload stays authoritative: every consumer gets the stored payload, and no consumer can alter it for another', async () => {
    const ctx = build([
      { name: 'secondary', deliver: async (e) => { e.payload.amountMinor = 1; e.payload.injected = 'x'; } }, // a misbehaving consumer scribbles on its copy
      { name: 'notifications' },
    ]);
    await ctx.record(revisionEvent(A, 1));
    const stored = JSON.stringify(ctx.event(A, 1).payload);
    await ctx.dispatcher.dispatchConsumer('secondary');
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(JSON.stringify(ctx.event(A, 1).payload)).toBe(stored);
    expect(ctx.seen.notifications[0].payload).toEqual(JSON.parse(stored));
    expect(ctx.seen.notifications[0].eventId).toBe(ctx.seen.secondary[0].eventId); // the same event id at both consumers
    expect(ctx.store.rows).toHaveLength(1); // the payload is not copied per consumer
  });

  it('a consumer is never shown another consumer\'s delivery state or lease token', async () => {
    const ctx = build();
    await ctx.record(revisionEvent(A, 1));
    await ctx.dispatcher.dispatchConsumer('secondary');
    await ctx.dispatcher.dispatchConsumer('notifications');
    for (const received of [...ctx.seen.secondary, ...ctx.seen.notifications]) {
      expect(Object.keys(received)).not.toEqual(expect.arrayContaining(['delivery']));
      expect(JSON.stringify(received)).not.toMatch(/leaseToken|claimedBy|PROCESSED|PROCESSING/);
    }
  });
});

describe('per-consumer ordering (MAZAD-031 closure)', () => {
  it('N+1 waits for N FOR THE SAME CONSUMER only: secondary races ahead while notifications retries version 1', async () => {
    let notificationsUp = false;
    const ctx = build([{ name: 'secondary' }, { name: 'notifications', deliver: async (e) => { if (e.aggregateVersion === 1 && !notificationsUp) throw new Error('flaky'); } }]);
    for (const n of [1, 2, 3]) await ctx.record(revisionEvent(A, n));
    await ctx.dispatcher.dispatchConsumer('secondary');
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.versionsSeen('secondary')).toEqual([1, 2, 3]); // secondary is fully ahead…
    expect(ctx.versionsSeen('notifications')).toEqual([1]); // …which changes nothing for notifications: v2/v3 are held behind ITS OWN unfinished v1
    expect(ctx.d(A, 2, 'notifications')).toEqual({});
    expect(ctx.d(A, 3, 'notifications')).toEqual({});
    notificationsUp = true; ctx.advance(sec(2));
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.versionsSeen('notifications')).toEqual([1, 1, 2, 3]);
  });

  it('the reverse: notifications finishing everything does not release secondary\'s held-back successors', async () => {
    const ctx = build([{ name: 'secondary', deliver: async (e) => { if (e.aggregateVersion === 1) throw new Error('flaky'); } }, { name: 'notifications' }]);
    for (const n of [1, 2, 3]) await ctx.record(revisionEvent(A, n));
    await ctx.dispatcher.dispatchConsumer('notifications');
    await ctx.dispatcher.dispatchConsumer('secondary');
    await ctx.dispatcher.dispatchConsumer('secondary'); // still in backoff and v2/v3 are due — they must NOT jump the queue
    expect(ctx.versionsSeen('notifications')).toEqual([1, 2, 3]);
    expect(ctx.versionsSeen('secondary')).toEqual([1]);
  });

  it('consumers progress at different speeds and different aggregate versions, each in order', async () => {
    const ctx = build();
    for (const n of [1, 2, 3, 4, 5]) await ctx.record(revisionEvent(A, n));
    await ctx.dispatcher.dispatchConsumer('notifications', 2); // notifications is slow: 2 per pass
    await ctx.dispatcher.dispatchConsumer('secondary'); // secondary drains everything
    expect(ctx.versionsSeen('secondary')).toEqual([1, 2, 3, 4, 5]);
    expect(ctx.versionsSeen('notifications')).toEqual([1, 2]);
    await ctx.dispatcher.dispatchConsumer('notifications', 2);
    expect(ctx.versionsSeen('notifications')).toEqual([1, 2, 3, 4]);
    await ctx.dispatcher.dispatchConsumer('notifications', 2);
    expect(ctx.versionsSeen('notifications')).toEqual([1, 2, 3, 4, 5]);
  });

  it('a dead-lettered head unblocks ITS consumer\'s successors (only), and the other consumer had no need of it', async () => {
    const ctx = build([{ name: 'secondary' }, { name: 'notifications', deliver: async (e) => { if (e.aggregateVersion === 1) throw new OutboxPermanentDeliveryError(); } }]);
    for (const n of [1, 2, 3]) await ctx.record(revisionEvent(A, n));
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.d(A, 1, 'notifications').status).toBe(OutboxStatus.DEAD_LETTER);
    expect(ctx.versionsSeen('notifications')).toEqual([1, 2, 3]);
    await ctx.dispatcher.dispatchConsumer('secondary');
    expect(ctx.versionsSeen('secondary')).toEqual([1, 2, 3]);
  });

  it('a stuck aggregate for one consumer does not starve that consumer\'s other aggregates, nor any of the other consumer\'s', async () => {
    const ctx = build([{ name: 'secondary', deliver: async (e) => { if (e.aggregateId === A) throw new Error('cannot handle A'); } }, { name: 'notifications' }]);
    for (let n = 1; n <= 12; n++) await ctx.record(revisionEvent(A, n)); // a large backlog on A
    await ctx.record(revisionEvent(B, 1));
    await ctx.record(revisionEvent(C, 1));
    await ctx.dispatcher.dispatchConsumer('secondary', 3); // scan window 12 rows, all A's
    expect(ctx.versionsSeen('secondary', B)).toEqual([1]);
    expect(ctx.versionsSeen('secondary', C)).toEqual([1]);
    expect(ctx.versionsSeen('secondary', A)).toEqual([1]); // only A's head was ever attempted
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.versionsSeen('notifications', A)).toHaveLength(12);
  });
});

describe('subscriptions (MAZAD-031 closure)', () => {
  const build2 = () => build([
    { name: 'secondary', types: [OutboxEventType.PROPERTY_APPROVED, OutboxEventType.PROPERTY_REJECTED] },
    { name: 'notifications', types: [OutboxEventType.PROPERTY_REJECTED] },
  ]);

  it('each consumer receives exactly the types it subscribes to, and never claims or marks the rest', async () => {
    const ctx = build2();
    await ctx.record(revisionEvent(A, 1)); await ctx.record(revisionEvent(A, 2)); await ctx.record(rejected(A));
    await ctx.dispatcher.dispatchConsumer('secondary');
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.seen.secondary.map((e) => e.type)).toEqual(['PROPERTY_APPROVED', 'PROPERTY_APPROVED', 'PROPERTY_REJECTED']);
    expect(ctx.seen.notifications.map((e) => e.type)).toEqual(['PROPERTY_REJECTED']);
    expect(ctx.d(A, 1, 'notifications')).toEqual({}); // an unsubscribed event carries no delivery state for that consumer at all
    expect(ctx.d(A, 2, 'notifications')).toEqual({});
  });

  it('an event type a consumer does not subscribe to never blocks it (nor anyone else)', async () => {
    const ctx = build2();
    // secondary's bids are failing, but notifications only cares about the finalization, so it is not held behind them.
    ctx.handlers.secondary = async (e) => { if (e.type === 'PROPERTY_APPROVED') throw new Error('bid fan-out down'); };
    await ctx.record(revisionEvent(A, 1)); await ctx.record(revisionEvent(A, 2)); await ctx.record(rejected(A));
    await ctx.dispatcher.dispatchConsumer('secondary');
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.seen.notifications.map((e) => e.aggregateVersion)).toEqual([3]); // delivered although versions 1-2 are unfinished for secondary
    expect(ctx.d(A, 3, 'notifications').status).toBe(OutboxStatus.PROCESSED);
    expect(ctx.versionsSeen('secondary')).toEqual([1]); // secondary's own ordering still holds v2/v3 behind ITS failing v1
  });

  it('the scan only asks for subscribed types, so unsubscribed events are never re-read', async () => {
    const ctx = build2();
    const find = jest.spyOn(ctx.store.model, 'find');
    await ctx.record(revisionEvent(A, 1));
    await ctx.dispatcher.dispatchConsumer('notifications');
    for (const [filter] of find.mock.calls as any[]) expect(filter.type).toEqual({ $in: [OutboxEventType.PROPERTY_REJECTED] });
    expect(find).toHaveBeenCalled();
    expect(ctx.consumers.notifications.deliver).not.toHaveBeenCalled();
  });
});

describe('late registration finds durable history (MAZAD-031 closure)', () => {
  it('a consumer registered AFTER events were committed and after another consumer processed them is owed every historical event, in aggregate order', async () => {
    const ctx = build([{ name: 'secondary' }]);
    for (const n of [1, 2, 3]) await ctx.record(revisionEvent(A, n));
    for (const n of [1, 2]) await ctx.record(revisionEvent(B, n));
    await ctx.record(revisionEvent(C, 1));
    await ctx.dispatcher.dispatchConsumer('secondary');
    expect(ctx.store.rows.every((r) => r.delivery.secondary.status === OutboxStatus.PROCESSED)).toBe(true);
    const secondaryState = JSON.stringify(ctx.store.rows.map((r) => r.delivery));

    // MAZAD-036 arrives: it registers itself; no business transaction, no event and no other consumer is touched.
    ctx.add({ name: 'notifications' });
    expect(outboxDeliveryStatus(ctx.event(A, 1), 'notifications')).toBe(OutboxStatus.PENDING);
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.versionsSeen('notifications', A)).toEqual([1, 2, 3]);
    expect(ctx.versionsSeen('notifications', B)).toEqual([1, 2]);
    expect(ctx.seen.notifications).toHaveLength(6); // ALL historical events, none silently missed
    expect(ctx.seen.notifications.map((e) => e.eventId).sort()).toEqual(ctx.store.rows.map((r) => r._id.toString()).sort());
    expect(JSON.stringify(ctx.store.rows.map((r) => ({ secondary: r.delivery.secondary })))).toBe(JSON.stringify(JSON.parse(secondaryState).map((d: any) => ({ secondary: d.secondary })))); // secondary untouched
    expect(ctx.consumers.secondary.deliver).toHaveBeenCalledTimes(6); // and not redelivered
  });

  it('events committed after the late consumer registered are delivered too, with no extra step', async () => {
    const ctx = build([{ name: 'secondary' }]);
    await ctx.record(revisionEvent(A, 1));
    ctx.add({ name: 'notifications' });
    await ctx.record(revisionEvent(A, 2));
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.versionsSeen('notifications')).toEqual([1, 2]);
  });

  it('a consumer registering is what creates its obligation: the producer wrote nothing per consumer, before or after', async () => {
    const ctx = build([{ name: 'secondary' }]);
    await ctx.record(revisionEvent(A, 1));
    expect(ctx.event(A, 1)).not.toHaveProperty('delivery');
    ctx.add({ name: 'notifications' });
    expect(ctx.event(A, 1)).not.toHaveProperty('delivery'); // registration itself writes nothing either
    await ctx.record(revisionEvent(A, 2));
    expect(ctx.event(A, 2)).not.toHaveProperty('delivery');
  });

  it('a delivery is only ever created by the consumer\'s own dispatcher, and each consumer gets its own scan index once', async () => {
    const ctx = build();
    await ctx.record(revisionEvent(A, 1));
    await ctx.dispatcher.dispatchConsumer('secondary');
    await ctx.dispatcher.dispatchConsumer('secondary');
    expect(ctx.store.createdIndexes.map((i) => i.options.name)).toEqual([outboxConsumerScanIndexName('secondary')]); // once, and not notifications' yet
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.store.createdIndexes.map((i) => i.options.name)).toEqual([outboxConsumerScanIndexName('secondary'), outboxConsumerScanIndexName('notifications')]);
    expect(ctx.store.createdIndexes[1].spec).toEqual({ type: 1, 'delivery.notifications.status': 1, 'delivery.notifications.nextAttemptAt': 1, _id: 1 });
  });

  it('a failing index build never stops delivery, and is retried on the next pass', async () => {
    const ctx = build();
    await ctx.record(revisionEvent(A, 1));
    let failures = 1;
    ctx.store.model.collection.createIndex = async (spec: any, options: any) => { if (failures-- > 0) throw new Error('index build refused'); ctx.store.createdIndexes.push({ spec, options }); return 'ok'; };
    await expect(ctx.dispatcher.dispatchConsumer('secondary')).resolves.toMatchObject({ delivered: 1 });
    expect(ctx.store.createdIndexes).toHaveLength(0);
    await ctx.record(revisionEvent(A, 2));
    await ctx.dispatcher.dispatchConsumer('secondary');
    expect(ctx.store.createdIndexes).toHaveLength(1);
  });
});

describe('concurrency across instances and consumers (MAZAD-031 closure)', () => {
  it('two instances of EACH consumer racing together deliver every event exactly once per consumer', async () => {
    const ctx = build();
    for (let n = 1; n <= 4; n++) { await ctx.record(revisionEvent(A, n)); await ctx.record(revisionEvent(B, n)); }
    const dispatchers = [ctx.make(), ctx.make()];
    for (let pass = 0; pass < 4; pass++) {
      await Promise.all(dispatchers.flatMap((dispatcher) => [dispatcher.dispatchConsumer('secondary'), dispatcher.dispatchConsumer('notifications')]));
    }
    for (const name of ['secondary', 'notifications']) {
      const ids = ctx.seen[name].map((e) => e.eventId);
      expect(new Set(ids).size).toBe(ids.length); // no duplicate delivery
      expect(ids).toHaveLength(8);
      expect(ctx.versionsSeen(name, A)).toEqual([1, 2, 3, 4]);
      expect(ctx.versionsSeen(name, B)).toEqual([1, 2, 3, 4]);
    }
    expect(ctx.store.rows.every((r) => r.delivery.secondary.attemptCount === 1 && r.delivery.notifications.attemptCount === 1)).toBe(true);
  });

  it('a consumer holding a lease on version N never conflicts with the business transaction that commits version N+1', async () => {
    const hang = deferred();
    const ctx = build([{ name: 'secondary', deliver: () => hang.promise }]);
    await ctx.record(revisionEvent(A, 1));
    const pending = ctx.dispatcher.dispatchConsumer('secondary'); // holds a lease on v1
    await ticks();
    const startsBefore = ctx.mongo.nextTxn;
    await ctx.record(revisionEvent(A, 2)); // a new business transaction: inserts v2, reads the aggregate's max version
    expect(ctx.mongo.nextTxn - startsBefore).toBe(1); // exactly one transaction attempt: no WriteConflict, no retry
    expect(ctx.event(A, 2).aggregateVersion).toBe(2);
    expect(ctx.event(A, 2)).not.toHaveProperty('delivery');
    hang.resolve();
    await pending;
    await ctx.dispatcher.dispatchConsumer('secondary');
    expect(ctx.versionsSeen('secondary')).toEqual([1, 2]);
  });

  it('an aborted business transaction leaves nothing for any consumer, registered or not', async () => {
    const ctx = build();
    await ctx.record(revisionEvent(A, 1), false);
    expect(ctx.store.rows).toHaveLength(0);
    await ctx.dispatcher.dispatchConsumer('secondary');
    await ctx.dispatcher.dispatchConsumer('notifications');
    expect(ctx.seen.secondary).toHaveLength(0);
    expect(ctx.seen.notifications).toHaveLength(0);
  });
});

describe('worker: consumers are scheduled independently (MAZAD-031 closure)', () => {
  const workerOf = (ctx: ReturnType<typeof build>) => {
    const worker = new OutboxDispatcherWorker(ctx.dispatcher, ctx.registry, { get: () => undefined } as any);
    (worker as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return worker;
  };

  it('runOnce serves every registered consumer, each with its own summary', async () => {
    const ctx = build();
    await ctx.record(revisionEvent(A, 1));
    const results = await workerOf(ctx).runOnce();
    expect(Object.keys(results).sort()).toEqual(['notifications', 'secondary']);
    expect(results.secondary).toMatchObject({ consumer: 'secondary', delivered: 1 });
    expect(results.notifications).toMatchObject({ consumer: 'notifications', delivered: 1 });
  });

  it('a slow consumer only delays itself: while its pass is in flight the other consumer keeps its own cadence', async () => {
    const hang = deferred();
    const ctx = build([{ name: 'secondary', deliver: () => hang.promise }, { name: 'notifications' }]);
    await ctx.record(revisionEvent(A, 1)); await ctx.record(revisionEvent(B, 1));
    const worker = workerOf(ctx);
    const slowPass = worker.runConsumerOnce('secondary'); // hangs inside secondary's consumer
    await ticks();
    const tick = await worker.runOnce(); // a later tick: secondary is still busy, notifications is not
    expect(Object.keys(tick)).toEqual(['notifications']);
    expect(tick.notifications).toMatchObject({ delivered: 2 });
    expect(await worker.runConsumerOnce('secondary')).toBeNull(); // secondary never overlaps itself
    hang.resolve();
    await expect(slowPass).resolves.toMatchObject({ consumer: 'secondary' });
  });

  it('a consumer whose pass throws does not affect the others, and its failure is logged without payload or message', async () => {
    const ctx = build();
    await ctx.record(revisionEvent(A, 1));
    jest.spyOn(ctx.dispatcher, 'dispatchConsumer').mockImplementation(async (name: string) => {
      if (name === 'secondary') throw new Error('mongo down: mongodb://user:pass@host');
      return { consumer: name, scanned: 0, delivered: 0, retried: 0, deadLettered: 0, blockedAggregates: 0, lostClaims: 0, unconfirmed: 0 };
    });
    const worker = workerOf(ctx);
    const results = await worker.runOnce();
    expect(results.secondary).toBeNull();
    expect(results.notifications).toMatchObject({ consumer: 'notifications' });
    const logged = String((worker as any).logger.error.mock.calls[0][0]);
    expect(logged).toContain('outbox_dispatch_run_failed');
    expect(logged).toContain('secondary');
    expect(logged).not.toContain('pass');
  });
});

describe('scope: which consumers exist (MAZAD-031 closure; updated deliberately by MAZAD-032/036)', () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = walk(path.join(__dirname, '..', 'src')).filter((f) => f.endsWith('.ts'));
  const text = (f: string) => fs.readFileSync(f, 'utf8');
  const inRealtime = (f: string) => f.includes(`${path.sep}src${path.sep}secondary${path.sep}`);

  it('the registered consumer is notifications; no SSE or external push provider exists', () => {
    for (const file of files) {
      const source = text(file);
      const consumerFile = file.endsWith(`${path.sep}secondary-outbox.consumer.ts`) || file.endsWith(`${path.sep}notifications-outbox.consumer.ts`);
      if (!file.endsWith(`${path.sep}outbox-consumer.port.ts`) && !consumerFile) expect(source).not.toMatch(/\.register\(\s*\{[^}]*name:|registry\.register\(/);
      // The WebSocket stack belongs to the secondary module (and only the adapter line in app.setup); nothing else may use it.
      if (!inRealtime(file)) expect(source).not.toMatch(/@WebSocketGateway|@nestjs\/websockets/);
      expect(source).not.toMatch(/socket\.io|@Sse\(|firebase-admin|web-push|nodemailer.*outbox/i);
      if (!inRealtime(file)) expect(source).not.toMatch(/class\s+\w*Realtime\w*Consumer|name\s*[:=]\s*['"]secondary['"]/);
    }
    const registrations = files.filter((f) => !f.endsWith(`${path.sep}outbox-consumer.port.ts`) && /registry\.register\(/.test(text(f)));
    expect(registrations.map((f) => path.basename(f)).sort()).toEqual(['notifications-outbox.consumer.ts']);
  });

  it('the immutable event stays written exactly once by the producer: OutboxService is the only writer and never mentions a consumer', () => {
    const service = text(path.join(__dirname, '..', 'src', 'outbox', 'outbox.service.ts'));
    // Comments may explain that no consumer is known here; the CODE must not mention one.
    const code = service.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*')).join('\n');
    expect(code).not.toMatch(/consumer|delivery|attemptCount|nextAttemptAt|OutboxStatus/i);
  });
});
