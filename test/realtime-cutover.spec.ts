import * as fs from 'node:fs';
import * as path from 'node:path';
import * as mongoose from 'mongoose';
import { OutboxConsumerRegistry, OutboxDeliveryEvent, OutboxEventConsumer } from '../src/outbox/outbox-consumer.port';
import { OutboxDispatcherService } from '../src/outbox/outbox-dispatcher.service';
import { OutboxAggregateType, OutboxEventDraft, OutboxEventType } from '../src/outbox/outbox-events';
import { OutboxErrorClass, OutboxStatus } from '../src/outbox/outbox.constants';
import { RealtimeCutoverInvalidError, RealtimeCutoverNotReadyError, RealtimeCutoverService } from '../src/realtime/realtime-cutover.service';
import { MongoRealtimeCutoverStore } from '../src/realtime/realtime-cutover.store';
import { RealtimeOutboxConsumer } from '../src/realtime/realtime-outbox.consumer';
import { REALTIME_CONSUMER_NAME, REALTIME_CUTOVER_MAX_AGGREGATES } from '../src/realtime/realtime.constants';
import { RealtimeHub } from '../src/realtime/realtime.hub';
import { RealtimeCutover, RealtimeCutoverSchema } from '../src/realtime/schemas/realtime-cutover.schema';
import { FakeMongo } from './support/fake-payments-mongo';
import {
  AUCTION_A, AUCTION_B, FakeConnection, FakeCutoverModel, MemoryCutoverStore, activated, bid, cancelled, entryPayment, extended, idAt, lifecycle, pendingClose, settingsFor,
} from './support/realtime-fixtures';

/**
 * MAZAD-032 closure — FIRST-ENABLE HISTORICAL REALTIME DELIVERY, with a cutover derived from durable database state.
 *
 * The MAZAD-031 outbox owes a late consumer all history; realtime is ephemeral, so events that were already committed when
 * realtime was first activated must be consumed without being broadcast, while every event committed afterwards — including
 * those that pile up while realtime is down, and one whose transaction was in flight during activation — must be delivered.
 * The cutover is the highest COMMITTED `aggregateVersion` of every auction, read from the outbox and persisted once
 * (first writer wins). No clock and no event-id timestamp takes part in classification.
 *
 * Everything below drives the REAL dispatcher, consumer, hub, cutover service and Mongo-backed store over in-memory MODELS of
 * MongoDB (`FakeMongo`/`FakeOutboxStore` with snapshot-style transactions, `FakeCutoverModel`). Real-Mongo behaviour (the
 * `$setOnInsert` upsert, majority read/write concern, a genuinely concurrent first activation, the aggregate over a large
 * outbox) is a release-qualification item, not something these tests prove.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = new Date('2026-06-01T12:00:00.000Z');
const AUCTION_C = '64b0000000000000000aa003';
const NEW_AUCTIONS = ['64b0000000000000000aa004', '64b0000000000000000aa005', '64b0000000000000000aa006'];
const silent = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });
const ref = (aggregateId: string, aggregateVersion: number, aggregateType: string = OutboxAggregateType.AUCTION) => ({ aggregateType, aggregateId, aggregateVersion });

/** The state that outlives any process: the outbox collection, the cutover collection and the wall clock. */
function world() {
  const mongo = new FakeMongo();
  const outbox = mongo.outbox;
  const cutoverModel = new FakeCutoverModel();
  const trace: string[] = [];
  outbox.trace = trace;
  cutoverModel.trace = trace;
  const store = new MongoRealtimeCutoverStore(cutoverModel as any, outbox.model);
  const clockState = { now: START };
  let counter = 1;
  /** A business transaction that has inserted its event and NOT yet committed: in flight. `id` gives the row a chosen (e.g. hostile) ObjectId. */
  const openTransaction = async (draft: OutboxEventDraft, id?: Date) => {
    outbox.idFactory = id ? () => idAt(id, counter++) : undefined;
    const session: any = await mongo.connection.startSession();
    session.startTransaction();
    try {
      const recorded = await outbox.service.recordRequired(draft, session);
      return { recorded, commit: async () => { await session.commitTransaction(); await session.endSession(); }, abort: async () => { await session.abortTransaction(); await session.endSession(); } };
    } finally { outbox.idFactory = undefined; }
  };
  /** The PRODUCER path: one business transaction records one event and commits. */
  const record = async (draft: OutboxEventDraft, id?: Date) => {
    const open = await openTransaction(draft, id);
    await open.commit();
    return open.recorded;
  };
  const row = (aggregateId: string, version: number) => outbox.rows.find((r) => r.aggregateId === aggregateId && r.aggregateVersion === version);
  return { mongo, outbox, cutoverModel, store, trace, clockState, record, openTransaction, row, set: (now: Date) => { clockState.now = now; } };
}
type World = ReturnType<typeof world>;

const booted: Array<{ cutover: RealtimeCutoverService }> = [];
afterEach(() => { for (const p of booted.splice(0)) p.cutover.onModuleDestroy(); }); // no retry timer outlives its test

/** One PROCESS of the application over the shared world. Booting again is a restart / redeploy. */
async function boot(w: World, options: { enabled?: boolean; activate?: boolean; bootstrap?: boolean } = {}) {
  const clock = { now: jest.fn(() => new Date(w.clockState.now)) };
  const settings = settingsFor({ enabled: options.enabled ?? true });
  const registry = new OutboxConsumerRegistry();
  const hub = new RealtimeHub(settings);
  const access = { isPubliclyVisible: jest.fn(async () => true), fail: undefined as Error | undefined };
  access.isPubliclyVisible.mockImplementation(async () => { if (access.fail) throw access.fail; return true; });
  const cutover = new RealtimeCutoverService(settings as any, w.store);
  (cutover as any).logger = silent();
  const consumer = new RealtimeOutboxConsumer(registry, hub, access as any, clock as any, settings, cutover);
  (consumer as any).logger = silent();
  consumer.onModuleInit();
  const config = { get: (key: string) => ({ OUTBOX_MAX_ATTEMPTS: '3' } as Record<string, string>)[key] } as any;
  const dispatcher = new OutboxDispatcherService(w.outbox.model, registry, clock as any, config);
  dispatcher.random = () => 1;
  (dispatcher as any).logger = silent();
  if (options.bootstrap ?? true) cutover.onApplicationBootstrap(); // what Nest does at start-up: a no-op unless realtime is enabled
  if (options.activate ?? true) await cutover.activate();
  const join = (auction: string) => {
    const conn = new FakeConnection();
    hub.admit(conn as any);
    hub.subscribe(conn as any, auction);
    return conn;
  };
  const run = () => dispatcher.dispatchConsumer(REALTIME_CONSUMER_NAME);
  /** Dispatch until nothing is owed and due. */
  const drain = async (passes = 30) => {
    let delivered = 0;
    for (let i = 0; i < passes; i++) {
      const summary = await run();
      delivered += summary.delivered;
      if (summary.scanned === 0 || summary.skipped) break;
    }
    return delivered;
  };
  const handle = { clock, settings, registry, hub, access, cutover, consumer, dispatcher, join, run, drain, config };
  booted.push(handle);
  return handle;
}

const realtimeState = (w: World, aggregateId: string, version: number) => w.row(aggregateId, version)?.delivery?.realtime ?? {};
const versionsOf = (conn: FakeConnection) => conn.events().map((f) => f.streamVersion);
const IMMUTABLE = ['_id', 'type', 'schemaVersion', 'aggregateType', 'aggregateId', 'aggregateVersion', 'occurredAt', 'audience', 'payload', 'privateRouting', 'createdAt'];
const immutableOf = (rows: any[]) => JSON.stringify(rows.map((r) => IMMUTABLE.map((k) => r[k])));

/** History committed before realtime is ever enabled: two auctions in full/partial life and a cancelled one (12 events). */
async function seedHistory(w: World) {
  const drafts: OutboxEventDraft[] = [
    ...lifecycle(AUCTION_A), activated(AUCTION_B), bid(AUCTION_B, 1), bid(AUCTION_B, 2), activated(AUCTION_C), cancelled(AUCTION_C),
  ];
  for (const draft of drafts) await w.record(draft);
  return drafts.length;
}

describe('classification — a pure function of (auction, version) and the persisted marks', () => {
  const serviceWith = async (marks: Record<string, number>) => {
    const store = new MemoryCutoverStore();
    store.marksProvider = () => marks;
    const service = new RealtimeCutoverService(settingsFor() as any, store);
    (service as any).logger = silent();
    await service.activate();
    return service;
  };

  it('history iff version ≤ the auction\'s mark; the next version, an unmarked auction and any other aggregate type are live', async () => {
    const service = await serviceWith({ [AUCTION_A]: 5, [AUCTION_B]: 1 });
    expect(service.isHistorical(ref(AUCTION_A, 1))).toBe(true);
    expect(service.isHistorical(ref(AUCTION_A, 5))).toBe(true);
    expect(service.isHistorical(ref(AUCTION_A, 6))).toBe(false);
    expect(service.isHistorical(ref(AUCTION_A, 600))).toBe(false);
    expect(service.isHistorical(ref(AUCTION_B, 1))).toBe(true);
    expect(service.isHistorical(ref(AUCTION_B, 2))).toBe(false);
    expect(service.isHistorical(ref(AUCTION_C, 1))).toBe(false); // an auction created after the cutover has no mark
    expect(service.isHistorical(ref(AUCTION_A, 1, OutboxAggregateType.AUCTION_ENTRY_PAYMENT))).toBe(false); // same id, other aggregate type
    expect(service.aggregateCount).toBe(2);
  });

  it('nothing but (aggregateType, aggregateId, aggregateVersion) is consulted: an event id or timestamp cannot change the answer', async () => {
    const service = await serviceWith({ [AUCTION_A]: 2 });
    for (const at of [new Date(0), new Date('2100-01-01'), new Date()]) {
      const event = { ...ref(AUCTION_A, 3), eventId: idAt(at).toHexString(), occurredAt: at, createdAt: at } as any;
      expect(service.isHistorical(event)).toBe(false);
      expect(service.isHistorical({ ...event, aggregateVersion: 2 })).toBe(true);
    }
  });

  it('an empty database at activation yields an empty cutover: everything committed afterwards is live', async () => {
    const service = await serviceWith({});
    expect(service.ready).toBe(true);
    expect(service.isHistorical(ref(AUCTION_A, 1))).toBe(false);
  });

  it('refuses to answer before the cutover is known — it never guesses', () => {
    const service = new RealtimeCutoverService(settingsFor() as any, new MemoryCutoverStore());
    expect(service.ready).toBe(false);
    expect(() => service.isHistorical(ref(AUCTION_A, 1))).toThrow(RealtimeCutoverNotReadyError);
  });
});

describe('reading the committed high-water marks — the cutover\'s ONLY access to the outbox', () => {
  it('returns the highest committed version of every auction across ALL its event types, and ignores other aggregate types', async () => {
    const w = world();
    for (const draft of lifecycle(AUCTION_A)) await w.record(draft); // 7 events
    await w.record(activated(AUCTION_B));
    await w.record(bid(AUCTION_B, 1));
    await w.record(entryPayment()); // a payment aggregate: not an auction stream
    expect(await w.store.readCommittedHighWaterMarks()).toEqual({ [AUCTION_A]: 7, [AUCTION_B]: 2 });
  });

  it('is a read: one aggregate with a fixed, write-free pipeline, majority read concern, no update, no rewrite of any row', async () => {
    const w = world();
    await seedHistory(w);
    const before = JSON.stringify(w.outbox.rows);
    const updatesBefore = w.outbox.updates.length;
    await w.store.readCommittedHighWaterMarks();
    expect(w.outbox.aggregates).toHaveLength(1);
    const { pipeline, options } = w.outbox.aggregates[0];
    expect(pipeline.map((stage) => Object.keys(stage)[0])).toEqual(['$match', '$sort', '$group', '$limit']); // no $out / $merge
    expect(pipeline[0]).toEqual({ $match: { aggregateType: 'AUCTION' } });
    expect(pipeline[3]).toEqual({ $limit: REALTIME_CUTOVER_MAX_AGGREGATES + 1 });
    expect(options).toMatchObject({ readConcern: { level: 'majority' } });
    expect(w.outbox.updates).toHaveLength(updatesBefore);
    expect(JSON.stringify(w.outbox.rows)).toBe(before);
  });

  it('a transaction still in flight is INVISIBLE to it: its event is not counted', async () => {
    const w = world();
    await w.record(activated(AUCTION_A));
    const open = await w.openTransaction(bid(AUCTION_A, 1));
    expect(open.recorded.aggregateVersion).toBe(2); // it has taken version 2 inside its own snapshot...
    expect(await w.store.readCommittedHighWaterMarks()).toEqual({ [AUCTION_A]: 1 }); // ...but nobody else can see it
    await open.commit();
    expect(await w.store.readCommittedHighWaterMarks()).toEqual({ [AUCTION_A]: 2 });
  });

  it('an aborted transaction never existed: no mark, no gap', async () => {
    const w = world();
    await w.record(activated(AUCTION_A));
    const open = await w.openTransaction(bid(AUCTION_A, 1));
    await open.abort();
    expect(await w.store.readCommittedHighWaterMarks()).toEqual({ [AUCTION_A]: 1 });
    expect((await w.record(bid(AUCTION_A, 1))).aggregateVersion).toBe(2); // the next event reuses version 2: versions stay dense
  });

  it('a malformed row is left out (its events are then simply live: the safe direction)', async () => {
    const w = world();
    await w.record(activated(AUCTION_A));
    w.outbox.seed({ aggregateType: 'AUCTION', aggregateId: 'not-an-object-id', aggregateVersion: 4 });
    expect(await w.store.readCommittedHighWaterMarks()).toEqual({ [AUCTION_A]: 1 });
  });
});

describe('establishing the cutover — read committed state FIRST, persist ONCE afterwards', () => {
  it('first activation reads the marks, THEN persists them in one document; only then is the consumer configured', async () => {
    const w = world();
    await seedHistory(w);
    const p = await boot(w, { activate: false, bootstrap: false });
    expect(p.consumer.configured).toBe(false);
    expect(await p.cutover.activate()).toBe(true);
    expect(p.consumer.configured).toBe(true);
    expect(w.trace).toEqual(['outbox.aggregate', 'cutover.write']); // every mark precedes the moment the cutover exists
    expect(w.cutoverModel.doc).toEqual({ _id: 'realtime', marks: { [AUCTION_A]: 7, [AUCTION_B]: 3, [AUCTION_C]: 2 }, aggregateCount: 3, establishedBy: p.cutover.instanceId });
    expect(p.cutover.aggregateCount).toBe(3);
  });

  it('the persisted record carries no time of any kind', async () => {
    const w = world();
    await seedHistory(w);
    await boot(w);
    expect(Object.keys(w.cutoverModel.doc).sort()).toEqual(['_id', 'aggregateCount', 'establishedBy', 'marks']);
    expect(JSON.stringify(w.cutoverModel.doc)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('is written with `$setOnInsert` only, on the majority write concern, and read back on the majority read concern', async () => {
    const w = world();
    await boot(w);
    const write = w.cutoverModel.calls.find((c) => c.op === 'findOneAndUpdate')!;
    expect(write.filter).toEqual({ _id: 'realtime' });
    expect(Object.keys(write.update)).toEqual(['$setOnInsert']);
    expect(Object.keys(write.update.$setOnInsert).sort()).toEqual(['aggregateCount', 'establishedBy', 'marks']);
    expect(write.options).toEqual({ upsert: true, new: true, writeConcern: { w: 'majority' } });
    expect(w.cutoverModel.calls.filter((c) => c.op === 'findOne').every((c) => c.readConcern === 'majority')).toBe(true);
  });

  it('a process with realtime DISABLED never reads or writes the cutover: it cannot establish one', async () => {
    const w = world();
    const p = await boot(w, { enabled: false, activate: false });
    expect(w.cutoverModel.calls).toEqual([]);
    expect(w.outbox.aggregates).toEqual([]);
    expect(p.cutover.ready).toBe(false);
    expect(p.consumer.configured).toBe(false);
  });

  it('a failed attempt persists nothing; the retry READS AGAIN, so events committed in between are simply history too', async () => {
    const w = world();
    await w.record(activated(AUCTION_A));
    w.cutoverModel.failWrite = new Error('mongo unreachable: mongodb://user:secret@host');
    const p = await boot(w, { activate: false, bootstrap: false });
    expect(await p.cutover.activate()).toBe(false); // read {A:1}, write failed
    expect(p.consumer.configured).toBe(false);
    expect(w.cutoverModel.doc).toBeUndefined();
    await w.record(bid(AUCTION_A, 1)); // committed while realtime was not yet active: still before the cutover exists
    w.cutoverModel.failWrite = undefined;
    expect(await p.cutover.activate()).toBe(true);
    expect(w.cutoverModel.doc.marks).toEqual({ [AUCTION_A]: 2 }); // the fresh read, not the failed attempt's
    const errors = ((p.cutover as any).logger.error as jest.Mock).mock.calls.map((c) => c[0]).join('');
    expect(errors).toContain('realtime_cutover_unavailable');
    expect(errors).not.toContain('secret'); // class only, never the message
  });

  it('a store outage at any step (find, scan, establish) leaves the consumer unconfigured and is retried', async () => {
    for (const failing of ['failFind', 'failScan', 'failEstablish'] as const) {
      const store = new MemoryCutoverStore();
      (store as any)[failing] = new Error('down');
      const service = new RealtimeCutoverService(settingsFor() as any, store);
      (service as any).logger = silent();
      expect(await service.activate()).toBe(false);
      expect(service.ready).toBe(false);
      (store as any)[failing] = undefined;
      expect(await service.activate()).toBe(true);
    }
  });

  it('more auctions than one cutover document can hold is refused, permanently, with nothing persisted (a truncated cutover would broadcast history)', async () => {
    const store = new MemoryCutoverStore();
    store.marksProvider = () => Object.fromEntries(Array.from({ length: REALTIME_CUTOVER_MAX_AGGREGATES + 1 }, (_, i) => [i.toString(16).padStart(24, '0'), 1]));
    const service = new RealtimeCutoverService(settingsFor() as any, store);
    (service as any).logger = silent();
    expect(await service.activate()).toBe(false);
    expect(store.establishes).toBe(0);
    expect(service.ready).toBe(false);
    expect(((service as any).logger.error as jest.Mock).mock.calls[0][0]).toContain('"permanent":true');
    jest.useFakeTimers();
    try {
      service.onApplicationBootstrap(); // enabled: would normally retry
      await jest.advanceTimersByTimeAsync(0);
      const scans = store.scans;
      await jest.advanceTimersByTimeAsync(300_000);
      expect(store.scans).toBe(scans); // no retry storm re-reading a huge outbox
    } finally { service.onModuleDestroy(); jest.useRealTimers(); }
  });

  it('a persisted record that cannot be trusted is never repaired or replaced: the consumer stays unconfigured', async () => {
    const good = { consumer: 'realtime', marks: { [AUCTION_A]: 2 }, aggregateCount: 1, establishedBy: 'x' };
    for (const bad of [
      { ...good, marks: { 'not-hex': 2 }, aggregateCount: 1 },
      { ...good, marks: { [AUCTION_A]: 0 } },
      { ...good, marks: { [AUCTION_A]: 1.5 } },
      { ...good, marks: { [AUCTION_A]: '2' } },
      { ...good, aggregateCount: 2 }, // truncated / hand-edited
      { ...good, marks: [1, 2] },
      { ...good, marks: undefined },
      { ...good, consumer: 'notifications' }, // someone else's record
      {},
    ]) {
      const store = { find: jest.fn(async () => bad as any), readCommittedHighWaterMarks: jest.fn(), establish: jest.fn() };
      const service = new RealtimeCutoverService(settingsFor() as any, store);
      (service as any).logger = silent();
      expect(await service.activate()).toBe(false);
      expect(service.ready).toBe(false);
      expect(store.readCommittedHighWaterMarks).not.toHaveBeenCalled();
      expect(store.establish).not.toHaveBeenCalled(); // replacing it would BE a new cutover
      expect(((service as any).logger.error as jest.Mock).mock.calls[0][0]).toContain('realtime_cutover_unavailable');
    }
    expect(new RealtimeCutoverInvalidError('x').name).toBe('RealtimeCutoverInvalidError');
  });

  describe('bootstrap retry', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    it('keeps retrying with backoff while the store is down, becomes ready when it returns, and stops on shutdown', async () => {
      const store = new MemoryCutoverStore();
      store.failFind = new Error('down');
      const service = new RealtimeCutoverService(settingsFor() as any, store);
      (service as any).logger = silent();
      service.onApplicationBootstrap(); // attempt #1 (fails)
      await jest.advanceTimersByTimeAsync(0);
      expect(service.ready).toBe(false);
      await jest.advanceTimersByTimeAsync(2_000); // attempt #2, still down
      expect(service.ready).toBe(false);
      store.failFind = undefined;
      await jest.advanceTimersByTimeAsync(4_000); // attempt #3
      expect(service.ready).toBe(true);

      const down = new MemoryCutoverStore();
      down.failFind = new Error('down');
      const other = new RealtimeCutoverService(settingsFor() as any, down);
      (other as any).logger = silent();
      other.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      other.onModuleDestroy();
      const finds = down.finds;
      down.failFind = undefined;
      await jest.advanceTimersByTimeAsync(120_000);
      expect(down.finds).toBe(finds); // no timer survives shutdown
    });
  });
});

describe('restart and concurrent first activation converge on ONE durable cutover', () => {
  it('a restart adopts the persisted record: it reads nothing from the outbox and writes nothing, whatever has happened since', async () => {
    const w = world();
    const total = await seedHistory(w);
    const first = await boot(w);
    const persisted = JSON.stringify(w.cutoverModel.doc);
    const writes = () => w.cutoverModel.calls.filter((c) => c.op === 'findOneAndUpdate').length;
    expect(writes()).toBe(1);

    await w.record(bid(AUCTION_B, 3)); // committed after activation, before the process managed to deliver it
    w.set(new Date(START.getTime() + 2 * HOUR));
    const second = await boot(w);

    expect(w.outbox.aggregates).toHaveLength(1); // the outbox was NOT scanned again
    expect(writes()).toBe(1); // no second establishment, not even attempted
    expect(JSON.stringify(w.cutoverModel.doc)).toBe(persisted);
    expect(second.cutover.aggregateCount).toBe(first.cutover.aggregateCount);
    const conn = second.join(AUCTION_B);
    await second.drain();
    expect(conn.events().map((f) => [f.event, f.streamVersion])).toEqual([['BID_ACCEPTED', 4]]); // live, not swallowed
    expect(second.consumer.historicalConsumed).toBe(total); // the pre-cutover history the first process never drained
  });

  it('the history a first process had not finished draining stays history after a restart', async () => {
    const w = world();
    const total = await seedHistory(w);
    const first = await boot(w);
    await first.dispatcher.dispatchConsumer(REALTIME_CONSUMER_NAME, 5); // a bounded pass: part of the history is still owed
    expect(w.outbox.rows.filter((r) => r.delivery?.realtime?.status !== OutboxStatus.PROCESSED).length).toBeGreaterThan(0);
    const second = await boot(w);
    const conn = second.join(AUCTION_A);
    await second.drain();
    expect(conn.frames).toEqual([]);
    expect(w.outbox.rows).toHaveLength(total);
    expect(w.outbox.rows.every((r) => r.delivery?.realtime?.status === OutboxStatus.PROCESSED)).toBe(true);
  });

  it('two processes activating for the first time — reads that DIFFER — converge on the winner\'s document; both classify identically', async () => {
    const w = world();
    await w.record(activated(AUCTION_A));
    await w.record(bid(AUCTION_A, 1)); // versions 1-2
    const first = await boot(w, { activate: false, bootstrap: false });
    const second = await boot(w, { activate: false, bootstrap: false });

    // The first process has READ {A:2}; before it writes, a third event commits and the SECOND process activates completely.
    w.outbox.afterAggregate = async () => {
      w.outbox.afterAggregate = undefined;
      await w.record(bid(AUCTION_A, 2)); // version 3
      expect(await second.cutover.activate()).toBe(true); // reads {A:3} and persists it
    };
    expect(await first.cutover.activate()).toBe(true); // its own read said {A:2}, but the document already exists

    expect(w.cutoverModel.doc.marks).toEqual({ [AUCTION_A]: 3 }); // the winner's, unchanged by the loser's write attempt
    expect(w.cutoverModel.doc.establishedBy).toBe(second.cutover.instanceId);
    for (const service of [first.cutover, second.cutover]) {
      expect(service.isHistorical(ref(AUCTION_A, 3))).toBe(true);
      expect(service.isHistorical(ref(AUCTION_A, 4))).toBe(false);
    }
    expect(w.cutoverModel.calls.filter((c) => c.op === 'findOneAndUpdate')).toHaveLength(2); // both tried; one document
  });

  it('a lost insert race (duplicate key) adopts the winner\'s record, not its own', async () => {
    const w = world();
    await w.record(activated(AUCTION_A));
    w.cutoverModel.concurrentWinner = { _id: 'realtime', marks: { [AUCTION_A]: 9 }, aggregateCount: 1, establishedBy: 'someone-else' };
    const p = await boot(w);
    expect(p.cutover.isHistorical(ref(AUCTION_A, 9))).toBe(true);
    expect(p.cutover.isHistorical(ref(AUCTION_A, 10))).toBe(false);
    expect(w.cutoverModel.doc.marks).toEqual({ [AUCTION_A]: 9 });
  });

  it('activating in an empty deployment and activating twice concurrently give one empty cutover', async () => {
    const w = world();
    const a = await boot(w, { activate: false, bootstrap: false });
    const b = await boot(w, { activate: false, bootstrap: false });
    await Promise.all([a.cutover.activate(), b.cutover.activate()]);
    expect(w.cutoverModel.doc).toMatchObject({ marks: {}, aggregateCount: 0 });
    await w.record(activated(AUCTION_A));
    for (const p of [a, b]) expect(p.cutover.isHistorical(ref(AUCTION_A, 1))).toBe(false);
  });
});

describe('THE RACE — a business transaction in flight while realtime is being activated', () => {
  const hostileIds = [new Date('2000-01-01T00:00:00Z'), new Date('2100-01-01T00:00:00Z')];

  it.each(hostileIds.map((at) => [at.getUTCFullYear(), at]))('committed AFTER activation ⇒ LIVE and delivered, whatever its id says (id stamped in %s)', async (_year, stamp) => {
    const w = world();
    await w.record(activated(AUCTION_A));
    await w.record(bid(AUCTION_A, 1)); // committed before: versions 1-2
    const inFlight = await w.openTransaction(bid(AUCTION_A, 2), stamp as Date); // in flight: version 3, id stamped by a wrong clock
    const p = await boot(w); // ACTIVATION happens now: the scan sees only committed rows
    expect(w.cutoverModel.doc.marks).toEqual({ [AUCTION_A]: 2 });
    await inFlight.commit(); // commits AFTER the cutover exists
    const conn = p.join(AUCTION_A);
    await p.drain();
    expect(versionsOf(conn)).toEqual([3]); // v1-2 are history, v3 is delivered
    expect(p.consumer.historicalConsumed).toBe(2);
    expect(p.cutover.isHistorical(ref(AUCTION_A, 3))).toBe(false);
  });

  it.each(hostileIds.map((at) => [at.getUTCFullYear(), at]))('committed BEFORE activation ⇒ HISTORY, whatever its id says (id stamped in %s)', async (_year, stamp) => {
    const w = world();
    await w.record(activated(AUCTION_A), stamp as Date);
    await w.record(bid(AUCTION_A, 1), stamp as Date);
    const p = await boot(w);
    const conn = p.join(AUCTION_A);
    await p.drain();
    expect(conn.frames).toEqual([]);
    expect(p.consumer.historicalConsumed).toBe(2);
  });

  it('committed after the read but BEFORE the cutover is persisted ⇒ live (delivered, never suppressed) — and the same on every evaluation and after a restart', async () => {
    const w = world();
    await w.record(activated(AUCTION_A));
    w.outbox.afterAggregate = async () => { w.outbox.afterAggregate = undefined; await w.record(bid(AUCTION_A, 1)); }; // lands between read and persist
    const first = await boot(w);
    expect(w.cutoverModel.doc.marks).toEqual({ [AUCTION_A]: 1 });
    const conn = first.join(AUCTION_A);
    await first.drain();
    expect(versionsOf(conn)).toEqual([2]);
    const restarted = await boot(w);
    for (const service of [first.cutover, first.cutover, restarted.cutover]) expect(service.isHistorical(ref(AUCTION_A, 2))).toBe(false);
  });

  it('the versions of one auction split cleanly into a history prefix and a live suffix, however the transactions interleave', async () => {
    const w = world();
    await w.record(activated(AUCTION_A));
    await w.record(bid(AUCTION_A, 1));
    const p = await boot(w);
    await w.record(bid(AUCTION_A, 2));
    await w.record(extended(AUCTION_A));
    await w.record(pendingClose(AUCTION_A, 2));
    const verdicts = [1, 2, 3, 4, 5].map((v) => p.cutover.isHistorical(ref(AUCTION_A, v)));
    expect(verdicts).toEqual([true, true, false, false, false]);
  });

  it('a producer transaction that aborts and retries cannot leave a hole: the retried event takes the next dense version and is classified by it', async () => {
    const w = world();
    await w.record(activated(AUCTION_A));
    const doomed = await w.openTransaction(bid(AUCTION_A, 1));
    const p = await boot(w);
    await doomed.abort();
    const retried = await w.record(bid(AUCTION_A, 1));
    expect(retried.aggregateVersion).toBe(2);
    const conn = p.join(AUCTION_A);
    await p.drain();
    expect(versionsOf(conn)).toEqual([2]);
  });
});

describe('first enable: history is consumed, not broadcast', () => {
  it('does NOT broadcast any historical event to currently connected clients, and never touches the hub for them', async () => {
    const w = world();
    const total = await seedHistory(w);
    const p = await boot(w);
    const a = p.join(AUCTION_A); const b = p.join(AUCTION_B); const c = p.join(AUCTION_C);
    const publish = jest.spyOn(p.hub, 'publish');
    const closeRoom = jest.spyOn(p.hub, 'closeRoom');
    expect(await p.drain()).toBe(total);
    for (const conn of [a, b, c]) { expect(conn.frames).toEqual([]); expect(conn.closed).toBeUndefined(); }
    expect(publish).not.toHaveBeenCalled();
    expect(closeRoom).not.toHaveBeenCalled(); // historical terminal events do not close live rooms
    expect(p.access.isPubliclyVisible).not.toHaveBeenCalled();
    expect(p.hub.stats().subscriptions).toBe(3);
    expect(p.consumer.historicalConsumed).toBe(total);
  });

  it('those historical deliveries reach a TERMINAL delivery state through the ordinary state machine: PROCESSED, first attempt, no dead letter, event untouched', async () => {
    const w = world();
    const total = await seedHistory(w);
    const before = immutableOf(w.outbox.rows);
    const p = await boot(w);
    p.join(AUCTION_A);
    await p.drain();
    expect(w.outbox.rows).toHaveLength(total);
    for (const row of w.outbox.rows) {
      expect(row.delivery.realtime).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 1 });
      expect(row.delivery.realtime.processedAt).toBeInstanceOf(Date);
      expect(row.delivery.realtime.lastErrorClass).toBeUndefined();
      expect(row.delivery.realtime.leaseToken).toBeUndefined();
      expect(Object.keys(row.delivery)).toEqual(['realtime']); // no other consumer's state was invented
    }
    expect(immutableOf(w.outbox.rows)).toBe(before); // not deleted, not rewritten
    // The only writes to the outbox were the dispatcher's own claim/ack on delivery.realtime.*
    for (const { update } of w.outbox.updates) {
      for (const key of [...Object.keys(update.$set ?? {}), ...Object.keys(update.$unset ?? {}), ...Object.keys(update.$inc ?? {})]) expect(key).toMatch(/^delivery\.realtime\./);
    }
    expect(await p.run()).toMatchObject({ scanned: 0, delivered: 0 }); // nothing is owed any more
  });

  it('history is never dead-lettered, even when a historical row could not be mapped; the same corruption AFTER activation still is (unchanged behaviour)', async () => {
    const w = world();
    await w.record(activated(AUCTION_A));
    await w.record(bid(AUCTION_A, 1));
    w.row(AUCTION_A, 2).schemaVersion = 9; // unmappable
    const p = await boot(w);
    await w.record(activated(AUCTION_B));
    w.row(AUCTION_B, 1).schemaVersion = 9;
    await p.drain();
    expect(realtimeState(w, AUCTION_A, 2).status).toBe(OutboxStatus.PROCESSED);
    expect(realtimeState(w, AUCTION_B, 1)).toMatchObject({ status: OutboxStatus.DEAD_LETTER, lastErrorClass: OutboxErrorClass.CONSUMER_PERMANENT });
  });
});

describe('after activation: new events are broadcast, in order', () => {
  it('a live event after the history drained reaches subscribers with the authoritative fields', async () => {
    const w = world();
    const total = await seedHistory(w);
    const p = await boot(w);
    const conn = p.join(AUCTION_B);
    await p.drain();
    expect(conn.frames).toEqual([]);

    w.set(new Date(START.getTime() + 5 * MIN));
    await w.record(bid(AUCTION_B, 3));
    await w.record(extended(AUCTION_B));
    expect(await p.drain()).toBe(2);
    expect(conn.events().map((f) => [f.event, f.streamVersion])).toEqual([['BID_ACCEPTED', 4], ['AUCTION_END_EXTENDED', 5]]);
    expect(conn.events()[1].data.currentEndAt).toBeDefined(); // anti-sniping: the server's end time travels
    expect(w.outbox.rows).toHaveLength(total + 2);
    expect(p.consumer.historicalConsumed).toBe(total);
  });

  it('ONE auction with history and live events: only the live ones are sent, and delivery still goes in aggregateVersion order', async () => {
    const w = world();
    await w.record(activated(AUCTION_B));
    await w.record(bid(AUCTION_B, 1));
    await w.record(bid(AUCTION_B, 2));
    const p = await boot(w);
    const conn = p.join(AUCTION_B);
    await w.record(bid(AUCTION_B, 3));
    await w.record(pendingClose(AUCTION_B, 3));
    const order: number[] = [];
    const deliver = jest.spyOn(p.consumer, 'deliver');
    await p.drain();
    for (const [event] of deliver.mock.calls) order.push((event as OutboxDeliveryEvent).aggregateVersion);
    expect(order).toEqual([1, 2, 3, 4, 5]); // the outbox ordering gate is untouched
    expect(versionsOf(conn)).toEqual([4, 5]);
    expect(conn.events().map((f) => f.event)).toEqual(['BID_ACCEPTED', 'AUCTION_ENDED_PENDING_CLOSE']);
    for (let v = 1; v <= 5; v++) expect(realtimeState(w, AUCTION_B, v).status).toBe(OutboxStatus.PROCESSED);
  });
});

describe('events that accumulate while realtime is down AFTER activation are still delivered — nothing ages into history', () => {
  it.each([['an hour', HOUR], ['three days', 3 * DAY], ['ninety days', 90 * DAY]])('down for %s: every event is delivered, in order per auction, none treated as history', async (_label, downtime) => {
    const w = world();
    await seedHistory(w);
    const first = await boot(w);
    await first.drain(); // activated, history consumed; the process now goes away

    for (let i = 0; i < 3; i++) {
      w.set(new Date(START.getTime() + (i + 1) * (downtime / 4)));
      await w.record(bid(AUCTION_B, 3 + i));
      await w.record(activated(NEW_AUCTIONS[i])); // another auction going live
    }
    w.set(new Date(START.getTime() + downtime));

    const second = await boot(w);
    const conn = second.join(AUCTION_B);
    const newcomer = second.join(NEW_AUCTIONS[0]);
    expect(await second.drain()).toBe(6);
    expect(second.consumer.historicalConsumed).toBe(0);
    expect(versionsOf(conn)).toEqual([4, 5, 6]);
    expect(newcomer.events().map((f) => f.event)).toEqual(['AUCTION_ACTIVATED']);
    expect(w.cutoverModel.calls.filter((c) => c.op === 'findOneAndUpdate')).toHaveLength(1);
  });

  it('turning realtime OFF and on again after activation is the same thing: the pile-up is delivered; while off, nothing is claimed', async () => {
    const w = world();
    const first = await boot(w);
    await w.record(activated(AUCTION_A));
    await first.drain();
    w.set(new Date(START.getTime() + 2 * DAY));
    const off = await boot(w, { enabled: false, activate: false });
    await w.record(bid(AUCTION_A, 1));
    expect(off.consumer.configured).toBe(false);
    expect(await off.run()).toMatchObject({ skipped: 'NOT_CONFIGURED' });
    expect(realtimeState(w, AUCTION_A, 2)).toEqual({}); // nothing claimed or marked while off
    w.set(new Date(START.getTime() + 2 * DAY + HOUR));
    const on = await boot(w);
    const conn = on.join(AUCTION_A);
    await on.drain();
    expect(versionsOf(conn)).toEqual([2]);
    expect(w.cutoverModel.calls.filter((c) => c.op === 'findOneAndUpdate')).toHaveLength(1);
  });
});

describe('no clock participates in classification', () => {
  /** Only `Date` is faked: promises, timers and I/O run normally. */
  const withHostClock = async <T>(now: Date, work: () => Promise<T>): Promise<T> => {
    jest.useFakeTimers({
      now,
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    try { return await work(); } finally { jest.useRealTimers(); }
  };
  const scenario = async () => {
    const w = world();
    await seedHistory(w);
    const p = await boot(w);
    const conn = p.join(AUCTION_B);
    await w.record(bid(AUCTION_B, 3));
    await w.record(extended(AUCTION_B));
    await p.drain();
    return { versions: versionsOf(conn), consumed: p.consumer.historicalConsumed, marks: w.cutoverModel.doc.marks };
  };

  it('the host clock (activation AND delivery) at 1970, now, or 2100 gives byte-identical classification', async () => {
    const baseline = await scenario();
    expect(baseline).toEqual({ versions: [4, 5], consumed: 12, marks: { [AUCTION_A]: 7, [AUCTION_B]: 3, [AUCTION_C]: 2 } });
    for (const at of [new Date('1970-01-01T00:00:00Z'), new Date('2100-01-01T00:00:00Z')]) {
      expect(await withHostClock(at, scenario)).toEqual(baseline);
    }
  });

  it('the application clock jumping years, forwards or backwards, between activation and delivery changes nothing', async () => {
    for (const jump of [-5 * 365 * DAY, 5 * 365 * DAY]) {
      const w = world();
      await seedHistory(w);
      const first = await boot(w);
      w.set(new Date(START.getTime() + jump));
      await w.record(bid(AUCTION_B, 3));
      const second = await boot(w); // a restart on a wildly different clock
      const conn = second.join(AUCTION_B);
      await second.drain();
      expect(versionsOf(conn)).toEqual([4]);
      expect(second.consumer.historicalConsumed).toBe(12);
      expect(second.cutover.isHistorical(ref(AUCTION_B, 3))).toBe(true);
      expect(second.cutover.isHistorical(ref(AUCTION_B, 4))).toBe(false);
      expect(first.cutover.aggregateCount).toBe(second.cutover.aggregateCount);
    }
  });

  it('events whose ids are stamped by clocks years apart, interleaved in one auction, are classified by commit order alone', async () => {
    const w = world();
    const stamps = [new Date('2100-01-01'), new Date('1990-01-01'), new Date('2050-06-06'), new Date('2001-01-01')];
    for (const [i, draft] of [activated(AUCTION_A), bid(AUCTION_A, 1), bid(AUCTION_A, 2), extended(AUCTION_A)].entries()) await w.record(draft, stamps[i]);
    const p = await boot(w); // versions 1-4 committed: all history
    await w.record(bid(AUCTION_A, 3), new Date('1980-01-01')); // v5, "older" id than everything, committed last
    const conn = p.join(AUCTION_A);
    await p.drain();
    expect(versionsOf(conn)).toEqual([5]);
  });
});

describe('duplicate and retry semantics stay correct', () => {
  it('a live event whose delivery fails is retried and delivered exactly once, still as live; its successors wait behind it', async () => {
    const w = world();
    const p = await boot(w);
    const conn = p.join(AUCTION_A);
    await w.record(bid(AUCTION_A, 1));
    await w.record(bid(AUCTION_A, 2));
    p.access.fail = new Error('mongo timeout');
    expect(await p.run()).toMatchObject({ delivered: 0, retried: 1 });
    expect(realtimeState(w, AUCTION_A, 1)).toMatchObject({ status: OutboxStatus.PENDING, attemptCount: 1 });
    expect(realtimeState(w, AUCTION_A, 2)).toEqual({}); // blocked behind version 1
    p.access.fail = undefined;
    w.set(new Date(w.clockState.now.getTime() + 10_000));
    await p.drain();
    expect(versionsOf(conn)).toEqual([1, 2]);
    expect(realtimeState(w, AUCTION_A, 1)).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 2 });
    expect(p.consumer.historicalConsumed).toBe(0);
  });

  it('a lost acknowledgement redelivers a LIVE event: the room absorbs it, and if it did reach twice it carries the same eventId', async () => {
    const w = world();
    const p = await boot(w);
    const conn = p.join(AUCTION_A);
    await w.record(bid(AUCTION_A, 1));
    w.outbox.updateError = (_filter, update) => (update.$set?.['delivery.realtime.status'] === OutboxStatus.PROCESSED ? new Error('ack write lost') : undefined);
    expect(await p.run()).toMatchObject({ delivered: 0, unconfirmed: 1 });
    w.outbox.updateError = undefined;
    w.set(new Date(w.clockState.now.getTime() + 2 * MIN)); // the lease expires: the delivery is due again
    expect(await p.drain()).toBe(1);
    expect(conn.events()).toHaveLength(1); // duplicate absorbed by the room
    expect(realtimeState(w, AUCTION_A, 1)).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 2 });
  });

  it('a lost acknowledgement redelivers a HISTORICAL event: it is consumed silently again and still ends PROCESSED', async () => {
    const w = world();
    await w.record(activated(AUCTION_A));
    const p = await boot(w);
    const conn = p.join(AUCTION_A);
    w.outbox.updateError = (_filter, update) => (update.$set?.['delivery.realtime.status'] === OutboxStatus.PROCESSED ? new Error('ack write lost') : undefined);
    expect(await p.run()).toMatchObject({ delivered: 0, unconfirmed: 1 });
    w.outbox.updateError = undefined;
    w.set(new Date(START.getTime() + 2 * MIN));
    await p.drain();
    expect(conn.frames).toEqual([]);
    expect(realtimeState(w, AUCTION_A, 1)).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 2 });
    expect(p.consumer.historicalConsumed).toBe(2);
  });

  it('classification is identical on every attempt, in every process: same event, same answer', async () => {
    const w = world();
    await seedHistory(w);
    const first = await boot(w);
    w.set(new Date(START.getTime() + DAY));
    const second = await boot(w);
    for (const [id, v] of [[AUCTION_A, 1], [AUCTION_A, 7], [AUCTION_A, 8], [AUCTION_B, 3], [AUCTION_B, 4], [AUCTION_C, 2], [AUCTION_C, 3], [NEW_AUCTIONS[0], 1]] as const) {
      const answers = [first.cutover.isHistorical(ref(id, v)), first.cutover.isHistorical(ref(id, v)), second.cutover.isHistorical(ref(id, v))];
      expect(new Set(answers).size).toBe(1);
    }
  });
});

describe('until the cutover is known nothing is claimed, marked or burned', () => {
  it('the dispatcher skips the unconfigured consumer; a store outage cannot burn delivery attempts or dead-letter live events', async () => {
    const w = world();
    w.cutoverModel.failFind = new Error('down');
    const p = await boot(w, { activate: false, bootstrap: false });
    await w.record(activated(AUCTION_A));
    for (let i = 0; i < 6; i++) {
      await p.cutover.activate(); // keeps failing
      expect(await p.run()).toMatchObject({ skipped: 'NOT_CONFIGURED', scanned: 0, delivered: 0 });
      w.set(new Date(w.clockState.now.getTime() + 10 * MIN));
    }
    expect(realtimeState(w, AUCTION_A, 1)).toEqual({}); // 6 passes × maxAttempts 3 would have dead-lettered it had attempts been burned
    w.cutoverModel.failFind = undefined;
    await p.cutover.activate(); // the event was committed BEFORE the cutover existed: it is history
    expect(await p.drain()).toBe(1);
    expect(p.consumer.historicalConsumed).toBe(1);
  });

  it('deliver() called before the cutover is known throws (retryable) instead of acknowledging', async () => {
    const w = world();
    const p = await boot(w, { activate: false, bootstrap: false });
    await expect(p.consumer.deliver({ ...ref(AUCTION_A, 1), eventId: idAt(START).toHexString() } as any)).rejects.toBeInstanceOf(RealtimeCutoverNotReadyError);
  });
});

describe('the generic MAZAD-031 late-consumer guarantee is unchanged', () => {
  const ALL = [
    OutboxEventType.AUCTION_ACTIVATED, OutboxEventType.BID_ACCEPTED, OutboxEventType.AUCTION_END_EXTENDED, OutboxEventType.AUCTION_ENDED_PENDING_CLOSE,
    OutboxEventType.AUCTION_ENDED_NO_BIDS, OutboxEventType.AUCTION_CANCELLED, OutboxEventType.AUCTION_FINALIZED,
  ];
  const probe = (received: OutboxDeliveryEvent[]): OutboxEventConsumer => ({
    name: 'probe', subscribedTypes: ALL, configured: true, deliver: async (event) => { received.push(event); },
  });

  it('a plain consumer registered late is still owed ALL history, including everything realtime consumed as historical, with its own independent state', async () => {
    const w = world();
    const total = await seedHistory(w);
    const p = await boot(w);
    p.join(AUCTION_A);
    await p.drain(); // realtime has consumed the whole history (broadcasting none of it)
    await w.record(bid(AUCTION_B, 3));
    await p.drain();

    const received: OutboxDeliveryEvent[] = [];
    p.registry.register(probe(received)); // registered long after the events existed
    const cutoverCalls = w.cutoverModel.calls.length;
    const scans = w.outbox.aggregates.length;
    for (let i = 0; i < 10; i++) if ((await p.dispatcher.dispatchConsumer('probe')).scanned === 0) break;
    expect(received).toHaveLength(total + 1); // every event ever committed — history AND the live one
    for (const row of w.outbox.rows) {
      expect(row.delivery.probe).toMatchObject({ status: OutboxStatus.PROCESSED, attemptCount: 1 });
      expect(row.delivery.realtime.status).toBe(OutboxStatus.PROCESSED); // untouched by probe
    }
    expect(w.cutoverModel.calls).toHaveLength(cutoverCalls); // another consumer never consults the realtime cutover
    expect(w.outbox.aggregates).toHaveLength(scans);
    const versions = received.filter((e) => e.aggregateId === AUCTION_A).map((e) => e.aggregateVersion);
    expect(versions).toEqual([...versions].sort((x, y) => x - y)); // per-aggregate order still holds for the late consumer
  });

  it('a consumer registered from the beginning (no cutover concept at all) also still receives history it never saw', async () => {
    const w = world();
    await seedHistory(w);
    const registry = new OutboxConsumerRegistry();
    const received: OutboxDeliveryEvent[] = [];
    registry.register(probe(received));
    const dispatcher = new OutboxDispatcherService(w.outbox.model, registry, { now: () => new Date(w.clockState.now) } as any, { get: () => undefined } as any);
    (dispatcher as any).logger = silent();
    await dispatcher.dispatchConsumer('probe', 100);
    expect(received).toHaveLength(w.outbox.rows.length);
    expect(w.cutoverModel.calls).toEqual([]);
    expect(w.outbox.aggregates).toEqual([]);
  });
});

describe('the Mongo store: shapes and create-once semantics (against fake models; real Mongo is a qualification item)', () => {
  const record = { consumer: 'realtime', marks: { [AUCTION_A]: 3 }, aggregateCount: 1, establishedBy: 'p-1' };
  const chain = (result: any, fail?: Error) => { const c: any = { readConcern: () => c, lean: () => c, exec: async () => { if (fail) throw fail; return result; } }; return c; };
  const storeWith = (model: any) => new MongoRealtimeCutoverStore(model, {} as any);

  it('find reads by _id on the majority read concern and maps the document; absent is null', async () => {
    const model = new FakeCutoverModel();
    model.doc = { _id: 'realtime', marks: record.marks, aggregateCount: 1, establishedBy: 'p-1' };
    expect(await storeWith(model).find('realtime')).toEqual(record);
    expect(model.calls[0]).toMatchObject({ op: 'findOne', filter: { _id: 'realtime' }, readConcern: 'majority' });
    expect(await storeWith(new FakeCutoverModel()).find('realtime')).toBeNull();
  });

  it('establish on an existing document changes NOTHING and returns the existing one', async () => {
    const model = new FakeCutoverModel();
    model.doc = { _id: 'realtime', marks: { [AUCTION_A]: 9 }, aggregateCount: 1, establishedBy: 'first' };
    const persisted = await storeWith(model).establish(record);
    expect(persisted).toMatchObject({ establishedBy: 'first', marks: { [AUCTION_A]: 9 } });
    expect(model.doc.marks).toEqual({ [AUCTION_A]: 9 });
  });

  it('a duplicate-key race adopts the WINNER; any other failure propagates; a missing document after the upsert is an error, never a guess', async () => {
    const raced = new FakeCutoverModel();
    raced.concurrentWinner = { _id: 'realtime', marks: { [AUCTION_A]: 8 }, aggregateCount: 1, establishedBy: 'other' };
    expect(await storeWith(raced).establish(record)).toMatchObject({ establishedBy: 'other', marks: { [AUCTION_A]: 8 } });
    const boom = { findOneAndUpdate: () => chain(null, new Error('network')) };
    await expect(storeWith(boom).establish(record)).rejects.toThrow('network');
    const missing = { findOneAndUpdate: () => chain(null) };
    await expect(storeWith(missing).establish(record)).rejects.toThrow('not persisted');
  });

  it('the schema keeps exactly the persisted fields with the right types (so an upsert cannot silently lose one, even an EMPTY marks map)', () => {
    const connection = mongoose.createConnection();
    const compiled = connection.model(RealtimeCutover.name, RealtimeCutoverSchema);
    const paths = compiled.schema.paths;
    expect(Object.keys(paths).sort()).toEqual(['_id', 'aggregateCount', 'establishedBy', 'marks']);
    expect(paths._id.instance).toBe('String');
    expect(paths.marks.instance).toBe('Mixed');
    expect(paths.aggregateCount.instance).toBe('Number');
    expect(paths.establishedBy.instance).toBe('String');
    expect(compiled.schema.options.minimize).toBe(false); // an empty marks object must be stored, not dropped
    expect(compiled.schema.options.timestamps).toBeFalsy(); // a timestamped upsert would add a $set
    expect(compiled.schema.options.versionKey).toBe(false); // ...and a __v $inc
    expect(compiled.collection.name).toBe('realtime_cutovers');
  });
});

describe('scope guards', () => {
  const root = path.join(__dirname, '..');
  const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
  const code = (relative: string) => read(relative).split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const [SERVICE, STORE, SCHEMA] = ['src/realtime/realtime-cutover.service.ts', 'src/realtime/realtime-cutover.store.ts', 'src/realtime/schemas/realtime-cutover.schema.ts'];

  it('the generic outbox knows nothing about the cutover: no source under src/outbox mentions it', () => {
    for (const file of walk(path.join(root, 'src', 'outbox')).filter((f) => f.endsWith('.ts'))) {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/cutover/i);
    }
  });

  it('NO CLOCK: the cutover code never reads a time, an event-id timestamp, occurredAt or createdAt', () => {
    for (const file of [SERVICE, STORE, SCHEMA]) {
      expect(code(file)).not.toMatch(/\bDate\b|Date\.now|\.now\(\)|ClockService|\bclock\b|getTimestamp|createFromTime|occurredAt|createdAt|\bTimestamp\b/);
    }
    // The one timer in the service is the retry back-off; classification (`isHistorical`) is a pure lookup.
    expect(code(SERVICE).match(/setTimeout/g)).toHaveLength(1);
    const classifier = code(SERVICE).slice(code(SERVICE).indexOf('isHistorical(event'), code(SERVICE).indexOf('private async keepTrying'));
    expect(classifier).not.toMatch(/setTimeout|await|Date|now\(/);
  });

  it('the only outbox access is ONE read (`.aggregate`) in the store: no outbox write, delete, bulk or model use anywhere else in the cutover code', () => {
    const store = code(STORE);
    expect(store.match(/this\.outbox\b/g)).toHaveLength(1);
    expect(store).toMatch(/this\.outbox\s*\n?\s*\.aggregate</);
    for (const file of [SERVICE, STORE, SCHEMA]) {
      expect(code(file)).not.toMatch(/\.(updateOne|updateMany|deleteOne|deleteMany|bulkWrite|remove|replaceOne|insertMany|create)\(|\$set\b|\$unset\b|\$inc\b|\$out\b|\$merge\b/);
    }
    for (const file of [SERVICE, SCHEMA]) expect(code(file)).not.toMatch(/OutboxEvent\b|OutboxDispatcher|InjectModel/);
  });

  it('the consumer still never writes to the outbox and only asks the cutover about the event\'s place in its stream', () => {
    const source = code('src/realtime/realtime-outbox.consumer.ts');
    expect(source).not.toMatch(/\.(updateOne|updateMany|deleteOne|deleteMany|bulkWrite|findOneAndUpdate)\(/);
    expect(source).toContain('this.cutover.isHistorical(event)');
  });

  it('no Flutter, Admin, notification, broker or cache dependency was introduced by the cutover', () => {
    for (const file of [SERVICE, STORE, SCHEMA]) {
      expect(code(file)).not.toMatch(/flutter|admin|notification|redis|kafka|rabbit|bull|firebase|web-push|socket\.io/i);
    }
    const pkg = JSON.parse(read('package.json'));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(names.filter((n) => /redis|kafka|rabbit|amqp|bull|ioredis|firebase|web-push|socket\.io/i.test(n))).toEqual([]);
  });
});
