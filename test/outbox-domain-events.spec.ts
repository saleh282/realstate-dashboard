import { Types } from 'mongoose';
import { AuctionLifecycleService } from '../src/auctions/auction-lifecycle.service';
import { AuctionStatus } from '../src/auctions/auction.types';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';
import { OutboxEventType } from '../src/outbox/outbox-events';
import { outboxDuplicateVersion } from './support/fake-outbox';
import { FakeMongo, transient } from './support/fake-payments-mongo';

/**
 * MAZAD-031 — auction lifecycle transitions and the anti-sniping extension
 * write their domain event in the SAME transaction as the state change. Run
 * against the transactional in-memory model (`FakeMongo` + `FakeOutboxStore`):
 * snapshot reads, single-writer-per-document WriteConflict, abort discarding
 * every buffered write. A model, not MongoDB — real-Mongo qualification is
 * still required.
 */
const oid = (hex: string) => new Types.ObjectId(hex);
const AUCTION = '64b000000000000000000f01';
const AUCTION_2 = '64b000000000000000000f02';
const ADVERTISER = '64b000000000000000000a10';
const PROPERTY = '64b000000000000000000b01';
const START = new Date('2026-05-08T10:00:00Z');
const END = new Date('2026-05-15T10:00:00Z');
const MIN = 60_000;

function build(opts: { hasBids?: boolean | ((id: string) => Promise<boolean>) } = {}) {
  const mongo = new FakeMongo();
  mongo.clockNow = START;
  mongo.seedUser(ADVERTISER);
  const audit = { logRequired: mongo.auditSvc.logRequired, logSystemAction: jest.fn().mockResolvedValue(undefined) };
  const clock = { now: jest.fn(() => mongo.clockNow) };
  const hasValidBids = jest.fn(async (id: string) => (typeof opts.hasBids === 'function' ? opts.hasBids(id) : Boolean(opts.hasBids)));
  const lifecycle = Object.assign(Object.create(AuctionLifecycleService.prototype), {
    auctions: mongo.model('auctions'), users: mongo.model('users'), audit, clock, bidExistence: { hasValidBids }, connection: mongo.connection, outbox: mongo.outbox.service,
    // MAZAD-035 collaborators (covered in mazad035 specs): the activation gate passes; no paid/entitled bidders.
    activationGate: { evaluate: async () => null },
    participants: { forCancellation: async () => [], financialActivity: async () => ({ livePayments: 0, flaggedPayments: 0, entitlements: 0 }) },
  }) as AuctionLifecycleService;
  const seed = (overrides: Record<string, unknown> = {}) => mongo.seedAuction({
    propertyId: oid(PROPERTY), scheduledStartAt: START, scheduledEndAt: END, currentEndAt: END, acceptedBidCount: 0,
    ruleSnapshot: { antiSnipingWindowSeconds: 300, antiSnipingExtensionSeconds: 300 }, ...overrides,
  });
  return { mongo, lifecycle, audit, clock, hasValidBids, seed };
}
const auctionDoc = (mongo: FakeMongo, id = AUCTION) => mongo.auction(id);
const events = (mongo: FakeMongo, type?: OutboxEventType) => mongo.outbox.events(type);

describe('SCHEDULED → ACTIVE emits AUCTION_ACTIVATED (MAZAD-031)', () => {
  it('commits the activation and exactly one event together, with the authoritative facts', async () => {
    const { mongo, lifecycle, seed, audit } = build();
    seed();
    await expect(lifecycle.activateDueAuctions()).resolves.toEqual({ activated: 1, held: 0 });
    expect(auctionDoc(mongo).status).toBe(AuctionStatus.ACTIVE);
    expect(events(mongo)).toHaveLength(1);
    expect(events(mongo)[0]).toMatchObject({
      type: OutboxEventType.AUCTION_ACTIVATED, schemaVersion: 1, aggregateType: 'AUCTION', aggregateId: AUCTION, aggregateVersion: 1, occurredAt: START,
      audience: 'PUBLIC', payload: { auctionId: AUCTION, status: AuctionStatus.ACTIVE, currentEndAt: END.toISOString() },
    });
    expect(events(mongo)[0]).not.toHaveProperty('delivery'); // the producer wrote the immutable event only
    expect(audit.logSystemAction).toHaveBeenCalledWith(AuditAction.AUCTION_ACTIVATED, AUCTION, expect.any(String), expect.anything()); // audit preserved
  });

  it('repeated worker ticks never duplicate the event', async () => {
    const { mongo, lifecycle, seed } = build();
    seed();
    await lifecycle.activateDueAuctions();
    await lifecycle.activateDueAuctions();
    await lifecycle.activateDueAuctions();
    expect(events(mongo, OutboxEventType.AUCTION_ACTIVATED)).toHaveLength(1);
  });

  it('emits nothing for an auction that is not yet due, or not SCHEDULED', async () => {
    const { mongo, lifecycle, seed } = build();
    seed({ scheduledStartAt: new Date(START.getTime() + MIN) });
    seed({ _id: oid(AUCTION_2), status: AuctionStatus.CANCELLED });
    await lifecycle.activateDueAuctions();
    expect(events(mongo)).toHaveLength(0);
  });

  it('emits one event per activated auction, each on its own aggregate stream', async () => {
    const { mongo, lifecycle, seed } = build();
    seed();
    seed({ _id: oid(AUCTION_2) });
    await expect(lifecycle.activateDueAuctions()).resolves.toEqual({ activated: 2, held: 0 });
    expect(events(mongo).map((e) => [e.aggregateId, e.aggregateVersion]).sort()).toEqual([[AUCTION, 1], [AUCTION_2, 1]]);
  });

  it('a failed event insert aborts the activation: the auction stays SCHEDULED and nothing is half-written', async () => {
    const { mongo, lifecycle, seed, audit } = build();
    seed();
    mongo.outbox.insertError = () => new Error('outbox unavailable');
    await expect(lifecycle.activateDueAuctions()).rejects.toThrow('outbox unavailable');
    expect(auctionDoc(mongo).status).toBe(AuctionStatus.SCHEDULED);
    expect(events(mongo)).toHaveLength(0);
    expect(audit.logSystemAction).not.toHaveBeenCalled(); // best-effort audit only runs after a committed transition
    mongo.outbox.insertError = undefined; // recovers on the next tick, still exactly one event
    await lifecycle.activateDueAuctions();
    expect(auctionDoc(mongo).status).toBe(AuctionStatus.ACTIVE);
    expect(events(mongo)).toHaveLength(1);
  });

  it('a lost commit is retried whole: still exactly one committed event and one activation', async () => {
    const { mongo, lifecycle, seed } = build();
    seed();
    let lost = 1;
    const start = mongo.connection.startSession;
    mongo.connection.startSession = async () => {
      const session: any = await start();
      const commit = session.commitTransaction;
      session.commitTransaction = async () => { if (lost-- > 0) throw transient('commit lost'); return commit.call(session); };
      return session;
    };
    await expect(lifecycle.activateDueAuctions()).resolves.toEqual({ activated: 1, held: 0 });
    expect(events(mongo)).toHaveLength(1);
    expect(events(mongo)[0].aggregateVersion).toBe(1);
  });

  it('two overlapping worker instances activate an auction once and emit once', async () => {
    const { mongo, lifecycle, seed } = build();
    seed();
    const results = await Promise.all([lifecycle.activateDueAuctions(), lifecycle.activateDueAuctions()]);
    expect(results.reduce((n, r) => n + r.activated, 0)).toBe(1);
    expect(events(mongo)).toHaveLength(1);
  });
});

describe('ACTIVE → ENDED_* emits AUCTION_ENDED_NO_BIDS / AUCTION_ENDED_PENDING_CLOSE (MAZAD-031)', () => {
  const due = () => ({ status: AuctionStatus.ACTIVE, currentEndAt: START });

  it('ends with no bids: one AUCTION_ENDED_NO_BIDS event, audit preserved', async () => {
    const { mongo, lifecycle, seed, audit } = build({ hasBids: false });
    seed(due());
    await expect(lifecycle.expireDueAuctions()).resolves.toEqual({ endedNoBids: 1, endedPendingClose: 0 });
    expect(auctionDoc(mongo).status).toBe(AuctionStatus.ENDED_NO_BIDS);
    expect(events(mongo)).toHaveLength(1);
    expect(events(mongo)[0]).toMatchObject({ type: OutboxEventType.AUCTION_ENDED_NO_BIDS, aggregateId: AUCTION, occurredAt: START, payload: { auctionId: AUCTION, status: AuctionStatus.ENDED_NO_BIDS, currentEndAt: START.toISOString() } });
    expect(audit.logSystemAction).toHaveBeenCalledWith(AuditAction.AUCTION_ENDED_NO_BIDS, AUCTION, expect.any(String), expect.anything());
  });

  it('ends with bids: one AUCTION_ENDED_PENDING_CLOSE event that carries the accepted bid count', async () => {
    const { mongo, lifecycle, seed } = build({ hasBids: true });
    seed({ ...due(), acceptedBidCount: 4 });
    await expect(lifecycle.expireDueAuctions()).resolves.toEqual({ endedNoBids: 0, endedPendingClose: 1 });
    expect(events(mongo)).toHaveLength(1);
    expect(events(mongo)[0]).toMatchObject({ type: OutboxEventType.AUCTION_ENDED_PENDING_CLOSE, payload: { status: AuctionStatus.ENDED_PENDING_CLOSE, acceptedBidCount: 4 } });
    expect(events(mongo, OutboxEventType.AUCTION_FINALIZED)).toHaveLength(0); // winner determination is finalization's event, not expiry's
  });

  it('repeated worker ticks do not duplicate the event', async () => {
    const { mongo, lifecycle, seed } = build({ hasBids: false });
    seed(due());
    for (let i = 0; i < 4; i++) await lifecycle.expireDueAuctions();
    expect(events(mongo)).toHaveLength(1);
  });

  it('emits nothing for an auction whose end has not arrived', async () => {
    const { mongo, lifecycle, seed } = build();
    seed({ status: AuctionStatus.ACTIVE, currentEndAt: new Date(START.getTime() + 1) });
    await lifecycle.expireDueAuctions();
    expect(events(mongo)).toHaveLength(0);
    expect(auctionDoc(mongo).status).toBe(AuctionStatus.ACTIVE);
  });

  it('a cancellation that commits between the worker\'s read and its write wins: no ENDED event, no state change by the worker', async () => {
    let cancelled = false;
    const { mongo, lifecycle, seed } = build({
      hasBids: async () => {
        if (!cancelled) {
          cancelled = true;
          // Simulate the advertiser's cancellation committing on another connection (non-transactional here) mid-decision.
          await mongo.model('auctions').findOneAndUpdate({ _id: oid(AUCTION) }, { $set: { status: AuctionStatus.CANCELLED } }).exec();
        }
        return false;
      },
    });
    seed(due());
    await expect(lifecycle.expireDueAuctions()).resolves.toEqual({ endedNoBids: 0, endedPendingClose: 0 });
    expect(auctionDoc(mongo).status).toBe(AuctionStatus.CANCELLED);
    expect(events(mongo)).toHaveLength(0);
  });

  it('a failed event insert aborts the expiry: the auction stays ACTIVE', async () => {
    const { mongo, lifecycle, seed } = build({ hasBids: true });
    seed(due());
    mongo.outbox.insertError = () => new Error('outbox unavailable');
    await expect(lifecycle.expireDueAuctions()).rejects.toThrow('outbox unavailable');
    expect(auctionDoc(mongo).status).toBe(AuctionStatus.ACTIVE);
    expect(events(mongo)).toHaveLength(0);
  });

  it('a duplicate on the outbox version index (a lost race) is retried, not surfaced', async () => {
    const { mongo, lifecycle, seed } = build({ hasBids: false });
    seed(due());
    let once = 1;
    mongo.outbox.insertError = () => (once-- > 0 ? outboxDuplicateVersion() : undefined);
    await expect(lifecycle.expireDueAuctions()).resolves.toEqual({ endedNoBids: 1, endedPendingClose: 0 });
    expect(events(mongo)).toHaveLength(1);
  });
});

describe('cancellation emits AUCTION_CANCELLED atomically with the state change and the audit row (MAZAD-031)', () => {
  it('SCHEDULED cancel: state + audit + event commit together; the free-text reason is NOT in the event', async () => {
    const { mongo, lifecycle, seed } = build();
    seed();
    await lifecycle.cancel(ADVERTISER, AUCTION, 'call me on 01001234567 or a@b.co');
    expect(auctionDoc(mongo).status).toBe(AuctionStatus.CANCELLED);
    expect(mongo.audits.map((a) => a.action)).toEqual([AuditAction.AUCTION_CANCELLED]); // audit preserved
    expect(events(mongo)).toHaveLength(1);
    expect(events(mongo)[0]).toMatchObject({ type: OutboxEventType.AUCTION_CANCELLED, aggregateId: AUCTION, audience: 'PUBLIC', payload: { auctionId: AUCTION, status: AuctionStatus.CANCELLED, previousStatus: AuctionStatus.SCHEDULED } });
    expect(JSON.stringify(events(mongo)[0])).not.toMatch(/01001234567|a@b\.co|call me/);
  });

  it('ACTIVE cancel records the previous status and the server time', async () => {
    const { mongo, lifecycle, seed } = build();
    seed({ status: AuctionStatus.ACTIVE });
    mongo.clockNow = new Date(START.getTime() + 5 * MIN);
    await lifecycle.cancel(ADVERTISER, AUCTION, 'owner changed their mind');
    expect(events(mongo)[0]).toMatchObject({ occurredAt: mongo.clockNow, payload: { previousStatus: AuctionStatus.ACTIVE, cancelledAt: mongo.clockNow.toISOString() } });
  });

  it('an audit failure aborts the whole transaction: no cancellation, no audit row, no event', async () => {
    const { mongo, lifecycle, seed } = build();
    seed();
    mongo.auditSvc.logRequired.mockRejectedValueOnce(new Error('audit down'));
    await expect(lifecycle.cancel(ADVERTISER, AUCTION, undefined)).rejects.toThrow('audit down');
    expect(auctionDoc(mongo).status).toBe(AuctionStatus.SCHEDULED);
    expect(mongo.audits).toHaveLength(0);
    expect(events(mongo)).toHaveLength(0);
  });

  it('an outbox failure aborts the whole transaction: the auction is NOT cancelled and no audit row survives', async () => {
    const { mongo, lifecycle, seed } = build();
    seed();
    mongo.outbox.insertError = () => new Error('outbox unavailable');
    await expect(lifecycle.cancel(ADVERTISER, AUCTION, undefined)).rejects.toThrow('outbox unavailable');
    expect(auctionDoc(mongo).status).toBe(AuctionStatus.SCHEDULED);
    expect(mongo.audits).toHaveLength(0);
    expect(events(mongo)).toHaveLength(0);
  });

  it('a rejected cancellation (terminal auction, wrong owner) emits nothing', async () => {
    const { mongo, lifecycle, seed } = build();
    seed({ status: AuctionStatus.COMPLETED });
    await expect(lifecycle.cancel(ADVERTISER, AUCTION, 'x')).rejects.toBeDefined();
    expect(events(mongo)).toHaveLength(0);
  });

  it('cancelling twice emits one event (the second attempt is a rejected transition)', async () => {
    const { mongo, lifecycle, seed } = build();
    seed();
    await lifecycle.cancel(ADVERTISER, AUCTION, undefined);
    await expect(lifecycle.cancel(ADVERTISER, AUCTION, undefined)).rejects.toBeDefined();
    expect(events(mongo, OutboxEventType.AUCTION_CANCELLED)).toHaveLength(1);
  });
});

describe('anti-sniping extension emits AUCTION_END_EXTENDED (MAZAD-031)', () => {
  const bidAt = new Date(END.getTime() - 60_000); // inside the 300s window
  const active = () => ({ status: AuctionStatus.ACTIVE });

  it('standalone: the end-time write and its event are one transaction; the payload is the authoritative before/after', async () => {
    const { mongo, lifecycle, seed, audit } = build();
    seed(active());
    const result = await lifecycle.extendIfWithinAntiSnipingWindow(AUCTION, bidAt);
    const extended = new Date(END.getTime() + 300_000);
    expect(result).toEqual({ extended: true, currentEndAt: extended });
    expect(auctionDoc(mongo).currentEndAt).toEqual(extended);
    expect(events(mongo)).toHaveLength(1);
    expect(events(mongo)[0]).toMatchObject({
      type: OutboxEventType.AUCTION_END_EXTENDED, aggregateId: AUCTION, occurredAt: bidAt,
      payload: { auctionId: AUCTION, status: AuctionStatus.ACTIVE, previousEndAt: END.toISOString(), currentEndAt: extended.toISOString() },
    });
    expect(audit.logSystemAction).toHaveBeenCalledTimes(1); // standalone best-effort audit preserved
  });

  it('inside a caller\'s transaction the event commits or vanishes with THAT transaction', async () => {
    const { mongo, lifecycle, seed, audit } = build();
    seed(active());
    const session: any = await mongo.connection.startSession();
    session.startTransaction();
    await lifecycle.extendIfWithinAntiSnipingWindow(AUCTION, bidAt, { session });
    expect(mongo.outbox.pendingInserts(session)).toHaveLength(1);
    expect(events(mongo)).toHaveLength(0); // not visible before the caller commits
    await session.abortTransaction();
    expect(events(mongo)).toHaveLength(0);
    expect(auctionDoc(mongo).currentEndAt).toEqual(END);
    expect(audit.logSystemAction).not.toHaveBeenCalled(); // the caller audits transactionally, once

    const committed: any = await mongo.connection.startSession();
    committed.startTransaction();
    await lifecycle.extendIfWithinAntiSnipingWindow(AUCTION, bidAt, { session: committed });
    await committed.commitTransaction();
    expect(events(mongo)).toHaveLength(1);
  });

  it('emits nothing when the bid is outside the window, the auction is not ACTIVE, or the compare-and-swap is lost', async () => {
    const outside = build(); outside.seed(active());
    await outside.lifecycle.extendIfWithinAntiSnipingWindow(AUCTION, new Date(END.getTime() - 400_000));
    expect(events(outside.mongo)).toHaveLength(0);

    const ended = build(); ended.seed({ status: AuctionStatus.ENDED_PENDING_CLOSE });
    await ended.lifecycle.extendIfWithinAntiSnipingWindow(AUCTION, bidAt);
    expect(events(ended.mongo)).toHaveLength(0);

    const raced = build(); raced.seed(active());
    (raced.lifecycle as any).auctions = { ...raced.mongo.model('auctions'), findOneAndUpdate: () => ({ exec: async () => null }) }; // the conditional write matches nothing (another writer moved the end)
    const result = await raced.lifecycle.extendIfWithinAntiSnipingWindow(AUCTION, bidAt);
    expect(result.extended).toBe(false);
    expect(events(raced.mongo)).toHaveLength(0);
  });

  it('a failed event insert aborts the extension: currentEndAt does not move', async () => {
    const { mongo, lifecycle, seed } = build();
    seed(active());
    mongo.outbox.insertError = () => new Error('outbox unavailable');
    await expect(lifecycle.extendIfWithinAntiSnipingWindow(AUCTION, bidAt)).rejects.toThrow('outbox unavailable');
    expect(auctionDoc(mongo).currentEndAt).toEqual(END);
  });

  it('repeated extensions each emit their own event with dense, increasing aggregate versions', async () => {
    const { mongo, lifecycle, seed } = build();
    seed(active());
    await lifecycle.extendIfWithinAntiSnipingWindow(AUCTION, bidAt);
    await lifecycle.extendIfWithinAntiSnipingWindow(AUCTION, new Date(END.getTime() + 300_000 - 10_000));
    expect(events(mongo).map((e) => e.aggregateVersion)).toEqual([1, 2]);
    expect(events(mongo)[1].payload.previousEndAt).toBe(new Date(END.getTime() + 300_000).toISOString());
  });
});

describe('one auction, one ordered stream across its whole lifecycle (MAZAD-031)', () => {
  it('activation → extension → expiry produce versions 1, 2, 3 in that order', async () => {
    const { mongo, lifecycle, seed } = build({ hasBids: true });
    seed({ scheduledStartAt: START, currentEndAt: new Date(START.getTime() + 10 * MIN) });
    await lifecycle.activateDueAuctions();
    await lifecycle.extendIfWithinAntiSnipingWindow(AUCTION, new Date(START.getTime() + 8 * MIN));
    mongo.clockNow = new Date(START.getTime() + 20 * MIN);
    await lifecycle.expireDueAuctions();
    expect(events(mongo).map((e) => [e.aggregateVersion, e.type])).toEqual([
      [1, OutboxEventType.AUCTION_ACTIVATED], [2, OutboxEventType.AUCTION_END_EXTENDED], [3, OutboxEventType.AUCTION_ENDED_PENDING_CLOSE],
    ]);
  });
});
