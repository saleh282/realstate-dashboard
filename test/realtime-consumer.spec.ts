import { InvalidOutboxConsumerError, OutboxConsumerRegistry } from '../src/outbox/outbox-consumer.port';
import { OutboxDispatcherService } from '../src/outbox/outbox-dispatcher.service';
import { OutboxDispatcherWorker } from '../src/outbox/outbox-dispatcher.worker';
import { OutboxEventDraft, OutboxEventType } from '../src/outbox/outbox-events';
import { OutboxErrorClass, OutboxStatus, outboxDeliveryStatus } from '../src/outbox/outbox.constants';
import { RealtimeOutboxConsumer } from '../src/realtime/realtime-outbox.consumer';
import { RealtimeHub, RealtimeUnavailableError } from '../src/realtime/realtime.hub';
import { REALTIME_CONSUMER_NAME } from '../src/realtime/realtime.constants';
import { FakeMongo } from './support/fake-payments-mongo';
import {
  AUCTION_A, AUCTION_B, BIDDER, FakeConnection, T0, WINNER, activated, bid, cancelled, entryPayment, extended, finalized, lifecycle, liveCutover, managedPayment, noBids, pendingClose, settingsFor,
} from './support/realtime-fixtures';

/**
 * MAZAD-032 — the `realtime` consumer running under the REAL MAZAD-031 dispatcher.
 * Events are written through the real `OutboxService` inside fake transactions
 * (the producer path); the consumer, hub and dispatcher are real; only Mongo
 * (an in-memory MODEL — real-Mongo qualification is still required) and the
 * visibility gate are faked.
 */
const sec = (n: number) => n * 1000;

function build(options: { visible?: (auctionId: string) => boolean | Promise<boolean>; settings?: Record<string, any>; cutover?: any } = {}) {
  const mongo = new FakeMongo();
  const store = mongo.outbox;
  const state = { now: new Date(T0.getTime() + sec(1)) };
  const clock = { now: jest.fn(() => new Date(state.now)) };
  const registry = new OutboxConsumerRegistry();
  const settings = settingsFor(options.settings);
  const hub = new RealtimeHub(settings);
  const visibility = { visible: options.visible ?? (() => true), fail: undefined as Error | undefined, inFlight: 0, maxInFlight: 0 };
  const access = {
    isPubliclyVisible: jest.fn(async (auctionId: string) => {
      visibility.inFlight += 1;
      visibility.maxInFlight = Math.max(visibility.maxInFlight, visibility.inFlight);
      try {
        if (visibility.fail) throw visibility.fail;
        return await visibility.visible(auctionId);
      } finally { visibility.inFlight -= 1; }
    }),
  };
  const consumer = new RealtimeOutboxConsumer(registry, hub, access as any, clock as any, settings, options.cutover ?? liveCutover());
  consumer.onModuleInit();
  const config = { get: (key: string) => ({ OUTBOX_MAX_ATTEMPTS: '3' } as Record<string, string>)[key] } as any;
  const dispatcher = new OutboxDispatcherService(store.model, registry, clock as any, config);
  dispatcher.random = () => 1;
  (dispatcher as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  (consumer as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const advance = (ms: number) => { state.now = new Date(state.now.getTime() + ms); };
  /** The PRODUCER path: one business transaction records one event and commits. */
  const record = async (draft: OutboxEventDraft) => {
    const session: any = await mongo.connection.startSession();
    session.startTransaction();
    try {
      const recorded = await store.service.recordRequired(draft, session);
      await session.commitTransaction();
      return recorded;
    } finally { await session.endSession(); }
  };
  const join = (auction = AUCTION_A) => {
    const conn = new FakeConnection();
    hub.admit(conn as any);
    hub.subscribe(conn as any, auction);
    return conn;
  };
  const rt = (aggregateId: string, version: number) => store.rows.find((r) => r.aggregateId === aggregateId && r.aggregateVersion === version)?.delivery?.realtime ?? {};
  const run = () => dispatcher.dispatchConsumer(REALTIME_CONSUMER_NAME);
  return { mongo, store, state, clock, registry, settings, hub, access, visibility, consumer, dispatcher, advance, record, join, rt, run };
}

const IMMUTABLE = ['_id', 'type', 'schemaVersion', 'aggregateType', 'aggregateId', 'aggregateVersion', 'occurredAt', 'audience', 'payload', 'privateRouting', 'createdAt'];
const pickImmutable = (r: any) => JSON.stringify(IMMUTABLE.map((k) => r[k]));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('registration and subscriptions', () => {
  it('registers exactly once, under the permanent name `realtime`, with exactly the seven auction event types', () => {
    const ctx = build();
    expect(ctx.registry.list().map((c) => c.name)).toEqual(['realtime']);
    expect(REALTIME_CONSUMER_NAME).toBe('realtime');
    expect(ctx.registry.get('realtime')).toBe(ctx.consumer);
    expect([...ctx.consumer.subscribedTypes].sort()).toEqual([
      OutboxEventType.AUCTION_ACTIVATED, OutboxEventType.AUCTION_CANCELLED, OutboxEventType.AUCTION_END_EXTENDED, OutboxEventType.AUCTION_ENDED_NO_BIDS,
      OutboxEventType.AUCTION_ENDED_PENDING_CLOSE, OutboxEventType.AUCTION_FINALIZED, OutboxEventType.BID_ACCEPTED,
    ].sort());
  });

  it('a second registration under the same identity is refused (two consumers can never share one delivery state)', () => {
    const ctx = build();
    expect(() => ctx.consumer.onModuleInit()).toThrow(InvalidOutboxConsumerError);
    expect(ctx.registry.list()).toHaveLength(1);
  });

  it('payment and managed-marketing events are never consumed: they are not scanned, claimed, delivered or marked', async () => {
    const ctx = build();
    const conn = ctx.join();
    await ctx.record(entryPayment());
    await ctx.record(managedPayment());
    const spy = jest.spyOn(ctx.consumer, 'deliver');
    const summary = await ctx.run();
    expect(summary.delivered).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(conn.frames).toEqual([]);
    for (const row of ctx.store.rows) expect(row.delivery?.realtime).toBeUndefined();
  });

  it('while realtime is disabled the consumer is not configured: the dispatcher skips it and touches nothing, so events stay owed', async () => {
    const ctx = build({ settings: { enabled: false } });
    await ctx.record(activated());
    await ctx.record(bid());
    expect(ctx.consumer.configured).toBe(false);
    expect(await ctx.run()).toMatchObject({ skipped: 'NOT_CONFIGURED', delivered: 0 });
    for (const row of ctx.store.rows) expect(row.delivery?.realtime).toBeUndefined();
    // Enabling it later finds what accumulated (per-consumer derivation from committed events). This suite runs under an
    // always-live cutover stub; what the ACTIVATION CUTOVER does to events from before the first activation is in realtime-cutover.spec.ts.
    const conn = ctx.join();
    ctx.settings.enabled = true;
    expect(ctx.consumer.configured).toBe(true);
    expect(await ctx.run()).toMatchObject({ delivered: 2 });
    expect(conn.events().map((f) => f.event)).toEqual(['AUCTION_ACTIVATED', 'BID_ACCEPTED']);
  });

  it('the worker starts a pass for it only while it is configured', async () => {
    const ctx = build({ settings: { enabled: false } });
    const worker = new OutboxDispatcherWorker(ctx.dispatcher, ctx.registry, { get: () => undefined } as any);
    const spy = jest.spyOn(ctx.dispatcher, 'dispatchConsumer');
    await worker.runOnce();
    expect(spy).not.toHaveBeenCalled();
    ctx.settings.enabled = true;
    await worker.runOnce();
    expect(spy).toHaveBeenCalledWith('realtime');
  });
});

describe('acknowledgement semantics', () => {
  it('a successful publish acknowledges: the delivery becomes PROCESSED and the subscriber received one frame', async () => {
    const ctx = build();
    const conn = ctx.join();
    await ctx.record(bid());
    expect(await ctx.run()).toMatchObject({ delivered: 1, retried: 0 });
    expect(ctx.rt(AUCTION_A, 1)).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 1 });
    expect(conn.events()).toHaveLength(1);
    expect(conn.events()[0]).toMatchObject({ event: 'BID_ACCEPTED', auctionId: AUCTION_A, streamVersion: 1 });
  });

  it('with nobody subscribed the event is still acknowledged: there was no one to tell, and clients resync over HTTP', async () => {
    const ctx = build();
    await ctx.record(bid());
    expect(await ctx.run()).toMatchObject({ delivered: 1 });
    expect(ctx.rt(AUCTION_A, 1).status).toBe(OutboxStatus.PROCESSED);
    expect(ctx.access.isPubliclyVisible).not.toHaveBeenCalled(); // no subscribers ⇒ no database work per event
  });

  it('a transport failure never acknowledges: the delivery stays PENDING with a retry time and an error CLASS, then succeeds without loss', async () => {
    const ctx = build();
    const conn = ctx.join();
    await ctx.record(bid());
    const publish = jest.spyOn(ctx.hub, 'publish').mockImplementationOnce(() => { throw new Error('hub exploded: secret detail'); });
    expect(await ctx.run()).toMatchObject({ delivered: 0, retried: 1 });
    expect(ctx.rt(AUCTION_A, 1)).toMatchObject({ status: OutboxStatus.PENDING, attemptCount: 1, lastErrorClass: OutboxErrorClass.CONSUMER_ERROR, lastErrorName: 'Error' });
    expect(JSON.stringify(ctx.rt(AUCTION_A, 1))).not.toContain('secret detail');
    expect(conn.frames).toEqual([]);
    publish.mockRestore();
    ctx.advance(sec(2));
    expect(await ctx.run()).toMatchObject({ delivered: 1 });
    expect(ctx.rt(AUCTION_A, 1)).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 2 });
    expect(conn.events()).toHaveLength(1);
  });

  it('a hub that is shutting down fails the delivery (retry), it does not acknowledge an event nobody could receive', async () => {
    const ctx = build();
    ctx.join();
    await ctx.record(bid());
    ctx.hub.shutdown();
    expect(await ctx.run()).toMatchObject({ delivered: 0, retried: 1 });
    expect(ctx.rt(AUCTION_A, 1)).toMatchObject({ status: OutboxStatus.PENDING, lastErrorName: RealtimeUnavailableError.name });
  });

  it('a visibility lookup that cannot be evaluated fails closed: nothing is published and the delivery is retried', async () => {
    const ctx = build();
    const conn = ctx.join();
    await ctx.record(bid());
    ctx.visibility.fail = new Error('mongo timeout');
    expect(await ctx.run()).toMatchObject({ delivered: 0, retried: 1 });
    expect(conn.frames).toEqual([]);
    expect(ctx.rt(AUCTION_A, 1).status).toBe(OutboxStatus.PENDING);
    ctx.visibility.fail = undefined;
    ctx.advance(sec(2));
    await ctx.run();
    expect(conn.events()).toHaveLength(1);
    expect(ctx.rt(AUCTION_A, 1).status).toBe(OutboxStatus.PROCESSED);
  });

  it('a permanently unmappable event is dead-lettered for realtime only and does not block later events of the auction', async () => {
    const ctx = build();
    const conn = ctx.join();
    await ctx.record(activated());
    await ctx.record(bid(AUCTION_A, 1));
    ctx.store.rows.find((r) => r.aggregateVersion === 1)!.payload.status = 'completed'; // a corrupt row: cannot be a safe frame
    await ctx.run();
    expect(ctx.rt(AUCTION_A, 1)).toMatchObject({ status: OutboxStatus.DEAD_LETTER, lastErrorClass: OutboxErrorClass.CONSUMER_PERMANENT, attemptCount: 1 });
    expect(ctx.rt(AUCTION_A, 2).status).toBe(OutboxStatus.PROCESSED);
    expect(conn.events().map((f) => f.streamVersion)).toEqual([2]); // the client sees version 2 first ⇒ it can detect the gap and resync
  });

  it('it never mutates or deletes outbox events: only its own delivery sub-document is written', async () => {
    const ctx = build();
    ctx.join();
    for (const draft of lifecycle()) await ctx.record(draft);
    const before = ctx.store.rows.map(pickImmutable);
    for (let i = 0; i < 4; i++) { await ctx.run(); ctx.advance(sec(5)); }
    expect(ctx.store.rows).toHaveLength(7);
    expect(ctx.store.rows.map(pickImmutable)).toEqual(before);
    for (const { update } of ctx.store.updates) {
      for (const key of [...Object.keys(update.$set ?? {}), ...Object.keys(update.$unset ?? {}), ...Object.keys(update.$inc ?? {})]) expect(key.startsWith('delivery.realtime.')).toBe(true);
    }
  });
});

describe('duplicate delivery is harmless', () => {
  it('a redelivery of an event this process already fanned out reaches subscribers only once', async () => {
    const ctx = build();
    const conn = ctx.join();
    await ctx.record(bid());
    await ctx.run();
    // Force the dispatcher to deliver it again (as after a lost acknowledgement).
    ctx.store.rows[0].delivery.realtime = { status: OutboxStatus.PENDING, attemptCount: 1, nextAttemptAt: new Date(ctx.state.now.getTime() - 1) };
    expect(await ctx.run()).toMatchObject({ delivered: 1 });
    expect(conn.events()).toHaveLength(1);
    expect(ctx.rt(AUCTION_A, 1).status).toBe(OutboxStatus.PROCESSED);
  });

  it('a crash between the socket emit and the outbox acknowledgement redelivers after the lease — and clients see the event once', async () => {
    const ctx = build();
    const conn = ctx.join();
    await ctx.record(bid());
    // The publish succeeds, but storing the acknowledgement fails (process/DB trouble).
    ctx.store.updateError = (_f, update) => (update.$set?.['delivery.realtime.status'] === OutboxStatus.PROCESSED ? new Error('db unavailable') : undefined);
    expect(await ctx.run()).toMatchObject({ delivered: 0, unconfirmed: 1 });
    expect(conn.events()).toHaveLength(1); // already emitted
    expect(ctx.rt(AUCTION_A, 1).status).toBe(OutboxStatus.PROCESSING); // …but still owed
    ctx.store.updateError = undefined;
    ctx.advance(sec(61)); // the lease expires
    expect(await ctx.run()).toMatchObject({ delivered: 1 });
    expect(ctx.rt(AUCTION_A, 1).status).toBe(OutboxStatus.PROCESSED);
    expect(conn.events()).toHaveLength(1); // the redelivery was recognised and not re-sent
  });

  it('a redelivery that DOES reach a client (room memory lost) carries the identical eventId, so client-side deduplication works', async () => {
    const ctx = build();
    const first = ctx.join();
    await ctx.record(bid());
    await ctx.run();
    ctx.hub.unsubscribe(first as any, AUCTION_A); // the room empties: its memory is gone
    const second = ctx.join();
    ctx.store.rows[0].delivery.realtime = { status: OutboxStatus.PENDING, attemptCount: 1, nextAttemptAt: new Date(ctx.state.now.getTime() - 1) };
    await ctx.run();
    expect(second.events()).toHaveLength(1);
    expect(second.events()[0].eventId).toBe(first.events()[0].eventId);
    expect(second.events()[0].eventId).toBe(String(ctx.store.rows[0]._id));
  });
});

describe('ordering', () => {
  it('events of one auction are emitted in outbox order even when each lookup finishes at a different, random time', async () => {
    const ctx = build({ visible: async () => { await delay(Math.floor(Math.random() * 12)); return true; } });
    const a = ctx.join(AUCTION_A);
    const b = ctx.join(AUCTION_B);
    for (const v of [1, 2, 3, 4, 5]) {
      await ctx.record(v === 1 ? activated(AUCTION_A) : bid(AUCTION_A, v - 1));
      await ctx.record(v === 1 ? activated(AUCTION_B) : bid(AUCTION_B, v - 1));
    }
    await ctx.run();
    expect(a.events().map((f) => f.streamVersion)).toEqual([1, 2, 3, 4, 5]);
    expect(b.events().map((f) => f.streamVersion)).toEqual([1, 2, 3, 4, 5]);
    expect(ctx.visibility.maxInFlight).toBe(1); // deliveries are awaited one at a time: nothing fire-and-forget
  });

  it('a slow first event delays the following ones instead of being overtaken by them', async () => {
    let first = true;
    const ctx = build({ visible: async () => { if (first) { first = false; await delay(30); } return true; } });
    const conn = ctx.join();
    await ctx.record(activated());
    await ctx.record(bid(AUCTION_A, 1));
    await ctx.record(bid(AUCTION_A, 2));
    await ctx.run();
    expect(conn.events().map((f) => f.event)).toEqual(['AUCTION_ACTIVATED', 'BID_ACCEPTED', 'BID_ACCEPTED']);
    expect(conn.events().map((f) => f.data.sequence ?? null)).toEqual([null, 1, 2]);
  });

  it('a failed event blocks its successors (per-consumer gate) and, once it succeeds, order is still preserved', async () => {
    const ctx = build();
    const conn = ctx.join();
    for (const draft of [activated(), bid(AUCTION_A, 1), bid(AUCTION_A, 2)]) await ctx.record(draft);
    const original = ctx.hub.publish.bind(ctx.hub);
    const publish = jest.spyOn(ctx.hub, 'publish');
    publish.mockImplementationOnce(original); // version 1 goes through
    publish.mockImplementationOnce(() => { throw new Error('transient'); }); // version 2 fails once
    await ctx.run();
    expect(conn.events().map((f) => f.streamVersion)).toEqual([1]); // version 3 was NOT sent ahead of version 2
    expect(ctx.rt(AUCTION_A, 3).status).toBeUndefined();
    publish.mockRestore();
    ctx.advance(sec(2));
    await ctx.run();
    expect(conn.events().map((f) => f.streamVersion)).toEqual([1, 2, 3]);
  });

  it('within one committed bid transaction the extension is announced before the bid, and both carry the authoritative end time', async () => {
    const ctx = build();
    const conn = ctx.join();
    await ctx.record(activated());
    await ctx.record(extended());
    await ctx.record(bid(AUCTION_A, 1, { extended: true }));
    await ctx.run();
    const [, ext, accepted] = conn.events();
    expect([ext.event, accepted.event]).toEqual(['AUCTION_END_EXTENDED', 'BID_ACCEPTED']);
    expect(ext.streamVersion).toBeLessThan(accepted.streamVersion);
    expect(ext.data.currentEndAt).toBe(accepted.data.currentEndAt);
    expect(accepted.data.previousEndAt).toBe(ext.data.previousEndAt);
  });

  it('there is no cross-auction ordering promise: auction A stuck in retry does not hold auction B back', async () => {
    const ctx = build();
    const a = ctx.join(AUCTION_A);
    const b = ctx.join(AUCTION_B);
    await ctx.record(activated(AUCTION_A));
    await ctx.record(activated(AUCTION_B));
    const original = ctx.hub.publish.bind(ctx.hub);
    jest.spyOn(ctx.hub, 'publish').mockImplementation((id, v, f) => { if (id === AUCTION_A) throw new Error('a is broken'); return original(id, v, f); });
    await ctx.run();
    expect(a.events()).toEqual([]);
    expect(b.events()).toHaveLength(1);
  });
});

describe('terminal and visibility behaviour', () => {
  it.each([
    ['no bids', noBids, 'AUCTION_ENDED_NO_BIDS'],
    ['cancelled', cancelled, 'AUCTION_CANCELLED'],
    ['finalized', finalized, 'AUCTION_FINALIZED'],
  ])('a terminal event (%s) is delivered to existing subscribers as terminal, then the room is closed and later events reach nobody', async (_label, make, name) => {
    const ctx = build({ visible: () => false }); // none of these end states is publicly visible any more
    const conn = ctx.join();
    const other = ctx.join(AUCTION_B);
    await ctx.record(make());
    await ctx.run();
    expect(conn.events()).toHaveLength(1);
    expect(conn.events()[0]).toMatchObject({ event: name, terminal: true });
    expect(ctx.access.isPubliclyVisible).not.toHaveBeenCalled(); // terminal events are the notice itself; they do not need the gate to say "still visible"
    expect(ctx.hub.hasSubscribers(AUCTION_A)).toBe(false);
    expect(conn.subscriptions.size).toBe(0);
    expect(conn.closed).toBeUndefined(); // the socket stays connected
    expect(other.subscriptions.size).toBe(1); // another auction's room is untouched
    await ctx.record(bid(AUCTION_A, 9)); // a late/stray event for the closed auction
    await ctx.run();
    expect(conn.events()).toHaveLength(1);
  });

  it('the finalized event a subscriber receives is the identity-free outcome even though COMPLETED auctions are not publicly readable', async () => {
    const ctx = build({ visible: () => false });
    const conn = ctx.join();
    await ctx.record(finalized());
    await ctx.run();
    const text = JSON.stringify(conn.frames);
    expect(text).toContain('115000');
    expect(text).not.toContain(WINNER);
    expect(text).not.toContain(BIDDER);
    expect(text).not.toContain('privateRouting');
  });

  it('pending-close is a normal, non-terminal update: the room stays and the finalized event follows on the same subscription', async () => {
    const ctx = build();
    const conn = ctx.join();
    await ctx.record(pendingClose());
    await ctx.record(finalized());
    await ctx.run();
    expect(conn.events().map((f) => [f.event, f.terminal])).toEqual([['AUCTION_ENDED_PENDING_CLOSE', false], ['AUCTION_FINALIZED', true]]);
  });

  it('if the auction stops being publicly visible mid-life (e.g. its property is unpublished) the room is closed, members are told, and the event is NOT sent', async () => {
    const hidden = new Set<string>();
    const ctx = build({ visible: (id) => !hidden.has(id) });
    const conn = ctx.join();
    await ctx.record(activated());
    await ctx.run();
    hidden.add(AUCTION_A);
    await ctx.record(bid(AUCTION_A, 1));
    await ctx.record(bid(AUCTION_A, 2));
    await ctx.run();
    expect(conn.events().map((f) => f.event)).toEqual(['AUCTION_ACTIVATED']); // the bids never reached the socket
    expect(conn.frames.map((f) => f.type)).toEqual(['event', 'closed']);
    expect(conn.frames[1]).toMatchObject({ type: 'closed', auctionId: AUCTION_A, reason: 'AUCTION_NOT_AVAILABLE', resync: { required: true, reason: 'SUBSCRIPTION_CLOSED' } });
    expect(ctx.hub.hasSubscribers(AUCTION_A)).toBe(false);
    // Both deliveries were dealt with (acknowledged), not retried forever.
    expect(ctx.rt(AUCTION_A, 2).status).toBe(OutboxStatus.PROCESSED);
    expect(ctx.rt(AUCTION_A, 3).status).toBe(OutboxStatus.PROCESSED);
  });

  it('the visibility gate is consulted once per event only while the room has members', async () => {
    const ctx = build();
    ctx.join();
    await ctx.record(activated());
    await ctx.record(bid(AUCTION_A, 1));
    await ctx.run();
    expect(ctx.access.isPubliclyVisible).toHaveBeenCalledTimes(2);
    expect(ctx.access.isPubliclyVisible).toHaveBeenCalledWith(AUCTION_A);
  });
});

describe('privacy through the whole pipeline', () => {
  it('a full lifecycle written through the real producer path and delivered by the real dispatcher never leaks an identity to a subscriber', async () => {
    const ctx = build();
    const conn = ctx.join();
    for (const draft of lifecycle()) await ctx.record(draft);
    await ctx.run();
    const wire = JSON.stringify(conn.frames);
    expect(conn.events()).toHaveLength(7);
    for (const secret of [BIDDER, WINNER, 'privateRouting', 'bidderAccountId', 'winnerAccountId']) expect(wire).not.toContain(secret);
    expect(conn.events().map((f) => f.streamVersion)).toEqual([1, 2, 3, 4, 5, 6, 7]); // dense: nothing was skipped
  });
});

describe('independence from other consumers', () => {
  it('a failing realtime consumer does not affect another consumer, and realtime finishing does not complete the other one', async () => {
    const ctx = build();
    const seen: any[] = [];
    ctx.registry.register({ name: 'notifications', subscribedTypes: [OutboxEventType.BID_ACCEPTED], configured: true, deliver: async (e) => { seen.push(e); } });
    ctx.join();
    await ctx.record(bid());
    jest.spyOn(ctx.hub, 'publish').mockImplementation(() => { throw new Error('down'); });
    const [rt, nt] = await Promise.all([ctx.run(), ctx.dispatcher.dispatchConsumer('notifications')]);
    expect(rt).toMatchObject({ retried: 1 });
    expect(nt).toMatchObject({ delivered: 1 });
    expect(seen).toHaveLength(1);
    expect(outboxDeliveryStatus(ctx.store.rows[0], 'realtime')).toBe(OutboxStatus.PENDING);
    expect(outboxDeliveryStatus(ctx.store.rows[0], 'notifications')).toBe(OutboxStatus.PROCESSED);
  });
});
