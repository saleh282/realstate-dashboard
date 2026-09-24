import { Types } from 'mongoose';
import { OutboxDeliveryEvent } from '../../src/outbox/outbox-consumer.port';
import { RealtimeCutoverRecord, RealtimeCutoverStore } from '../../src/realtime/realtime-cutover.store';
import {
  OutboxEventDraft, auctionActivatedEvent, auctionCancelledEvent, auctionEndExtendedEvent, auctionEndedNoBidsEvent, auctionEndedPendingCloseEvent,
  auctionEntryPaymentConfirmedEvent, auctionFinalizedEvent, bidAcceptedEvent, managedMarketingPaymentConfirmedEvent,
} from '../../src/outbox/outbox-events';

/** Shared, deterministic fixtures for the MAZAD-032 suites. Account ids are deliberately recognisable so a leak is greppable. */
export const T0 = new Date('2026-05-08T10:00:00.000Z');
export const END = new Date('2026-05-08T12:00:00.000Z');
export const EXTENDED_END = new Date('2026-05-08T12:05:00.000Z');
export const AUCTION_A = '64b0000000000000000aa001';
export const AUCTION_B = '64b0000000000000000aa002';
export const BIDDER = '64b000000000000000bbbb11';
export const WINNER = '64b000000000000000cccc22';
export const ADVERTISER = '64b000000000000000dddd33';
export const PAYMENT = '64b000000000000000eeee44';

const at = (ms: number) => new Date(T0.getTime() + ms);

export const activated = (auctionId = AUCTION_A): OutboxEventDraft => auctionActivatedEvent({ auctionId, occurredAt: at(0), currentEndAt: END });
export const bid = (auctionId = AUCTION_A, sequence = 1, extra: { extended?: boolean } = {}): OutboxEventDraft => bidAcceptedEvent({
  auctionId, occurredAt: at(1_000 + sequence), sequence, amountMinor: 100_000 + sequence * 5_000, currency: 'EGP', acceptedBidCount: sequence,
  currentEndAt: extra.extended ? EXTENDED_END : END, previousEndAt: END, extended: extra.extended ?? false, nextMinimumBidMinor: 105_000 + sequence * 5_000, bidderAccountId: BIDDER,
});
export const extended = (auctionId = AUCTION_A): OutboxEventDraft => auctionEndExtendedEvent({ auctionId, occurredAt: at(2_000), previousEndAt: END, currentEndAt: EXTENDED_END });
export const pendingClose = (auctionId = AUCTION_A, acceptedBidCount = 3): OutboxEventDraft => auctionEndedPendingCloseEvent({ auctionId, occurredAt: at(3_000), currentEndAt: EXTENDED_END, acceptedBidCount });
export const noBids = (auctionId = AUCTION_A): OutboxEventDraft => auctionEndedNoBidsEvent({ auctionId, occurredAt: at(3_000), currentEndAt: END });
export const cancelled = (auctionId = AUCTION_A): OutboxEventDraft => auctionCancelledEvent({ auctionId, occurredAt: at(3_000), previousStatus: 'active' });
export const finalized = (auctionId = AUCTION_A): OutboxEventDraft => auctionFinalizedEvent({
  auctionId, occurredAt: at(4_000), winningBidSequence: 3, winningBidAmountMinor: 115_000, currency: 'EGP', acceptedBidCount: 3, winnerAccountId: WINNER,
});
export const entryPayment = (): OutboxEventDraft => auctionEntryPaymentConfirmedEvent({
  paymentId: PAYMENT, auctionId: AUCTION_A, occurredAt: at(500), amountMinor: 5_000, currency: 'EGP', lateConfirmation: false, bidderAccountId: BIDDER,
});
export const managedPayment = (): OutboxEventDraft => managedMarketingPaymentConfirmedEvent({
  requestId: '64b000000000000000ffff55', paymentId: PAYMENT, occurredAt: at(500), amountMinor: 9_000, currency: 'EGP', advertiserAccountId: ADVERTISER,
});

/** The drafts a full public auction lifecycle produces, in commit order, for one auction. */
export const lifecycle = (auctionId = AUCTION_A): OutboxEventDraft[] => [
  activated(auctionId), bid(auctionId, 1), bid(auctionId, 2), extended(auctionId), bid(auctionId, 3, { extended: true }), pendingClose(auctionId), finalized(auctionId),
];

/** What the dispatcher hands to a consumer for a committed draft (the real service adds id, version, delivery metadata). */
export function delivery(draft: OutboxEventDraft, aggregateVersion = 1, attempt = 1): OutboxDeliveryEvent {
  return {
    eventId: new Types.ObjectId().toHexString(),
    type: draft.type,
    schemaVersion: draft.schemaVersion,
    aggregateType: draft.aggregateType,
    aggregateId: draft.aggregateId,
    aggregateVersion,
    occurredAt: draft.occurredAt,
    audience: draft.audience,
    payload: JSON.parse(JSON.stringify(draft.payload)),
    ...(draft.privateRouting ? { privateRouting: { ...draft.privateRouting } } : {}),
    attempt,
  };
}

/** A fake client connection for hub / consumer tests. */
export class FakeConnection {
  readonly subscriptions = new Set<string>();
  readonly frames: any[] = [];
  open = true;
  buffered = 0;
  closed?: { code: number; reason: string };
  terminated = false;
  failSend = false;
  constructor(readonly id: string = Math.random().toString(36).slice(2), readonly ip: string = '10.0.0.1') {}
  isOpen() { return this.open; }
  bufferedAmount() { return this.buffered; }
  send(payload: string) {
    if (this.failSend) throw new Error('socket write failed');
    this.frames.push(JSON.parse(payload));
  }
  close(code: number, reason: string) { this.closed = { code, reason }; this.open = false; }
  terminate() { this.terminated = true; this.open = false; }
  events() { return this.frames.filter((f) => f.type === 'event'); }
}

export const settingsFor = (overrides: Record<string, any> = {}): any => ({
  enabled: true, topology: 'single_instance', maxConnections: 100, maxConnectionsPerIp: 50, maxSubscriptionsPerSocket: 50, maxMessageBytes: 2_048,
  messageRateLimit: 1_000, messageRateWindowMs: 10_000, heartbeatMs: 30_000, maxBufferedBytes: 1_048_576, allowedOrigins: true, ...overrides,
});

/** An event id (ObjectId) stamped with the given instant — used to give events a HOSTILE id (a clock that is years off): classification must not care. */
export const idAt = (instant: Date, counter = 0): Types.ObjectId =>
  new Types.ObjectId(`${Math.floor(instant.getTime() / 1000).toString(16).padStart(8, '0')}${'0'.repeat(10)}${counter.toString(16).padStart(6, '0')}`);

/**
 * For suites that are NOT about the cutover: a ready cutover under which nothing is historical, so the consumer behaves
 * exactly as it did before the cutover existed.
 */
export const liveCutover = (): any => ({ ready: true, isHistorical: () => false });

/** `RealtimeCutoverStore` at the interface level: first-writer-wins like the Mongo one, with hooks for failure and inspection. */
export class MemoryCutoverStore implements RealtimeCutoverStore {
  record?: RealtimeCutoverRecord;
  finds = 0;
  scans = 0;
  establishes = 0;
  failFind?: Error;
  failScan?: Error;
  failEstablish?: Error;
  /** What "the committed high-water marks" are, for a test that is not driving a real outbox. */
  marksProvider: () => Record<string, number> = () => ({});
  constructor(seed?: RealtimeCutoverRecord) { this.record = seed; }
  async find(consumer: string) {
    this.finds += 1;
    if (this.failFind) throw this.failFind;
    return this.record && this.record.consumer === consumer ? { ...this.record } : null;
  }
  async readCommittedHighWaterMarks() {
    this.scans += 1;
    if (this.failScan) throw this.failScan;
    return { ...this.marksProvider() };
  }
  async establish(record: RealtimeCutoverRecord) {
    this.establishes += 1;
    if (this.failEstablish) throw this.failEstablish;
    this.record ??= { ...record, marks: { ...record.marks } };
    return { ...this.record };
  }
}

/**
 * A stand-in for the Mongoose model of the ONE `realtime_cutovers` document: enough of `findOne` / `findOneAndUpdate` for the REAL
 * `MongoRealtimeCutoverStore` to run over it, with MongoDB's upsert-with-`$setOnInsert` semantics (an existing document is returned
 * UNCHANGED) and hooks to inject failures and a concurrent winner. A MODEL, not MongoDB.
 */
export class FakeCutoverModel {
  doc?: any;
  calls: Array<{ op: 'findOne' | 'findOneAndUpdate'; filter: any; update?: any; options?: any; readConcern?: string }> = [];
  failFind?: Error;
  failWrite?: Error;
  /** Simulates another process winning the insert between our read and our write: it is inserted, then OUR insert fails with E11000. */
  concurrentWinner?: any;
  trace?: string[];
  private clone = (value: any) => (value ? JSON.parse(JSON.stringify(value)) : value);
  findOne(filter: any) {
    const call: any = { op: 'findOne', filter };
    this.calls.push(call);
    const chain: any = {
      readConcern: (level: string) => { call.readConcern = level; return chain; },
      lean: () => chain,
      exec: async () => {
        await Promise.resolve();
        if (this.failFind) throw this.failFind;
        return this.doc && this.doc._id === filter._id ? this.clone(this.doc) : null;
      },
    };
    return chain;
  }
  findOneAndUpdate(filter: any, update: any, options: any) {
    const call: any = { op: 'findOneAndUpdate', filter, update, options };
    this.calls.push(call);
    const chain: any = {
      lean: () => chain,
      exec: async () => {
        await Promise.resolve();
        if (this.failWrite) throw this.failWrite;
        if (this.concurrentWinner) {
          this.doc = this.clone(this.concurrentWinner);
          this.concurrentWinner = undefined;
          throw Object.assign(new Error('E11000 duplicate key error collection: realtime_cutovers'), { code: 11000 });
        }
        if (!this.doc || this.doc._id !== filter._id) {
          this.trace?.push('cutover.write');
          this.doc = { _id: filter._id, ...this.clone(update.$setOnInsert) };
        }
        return this.clone(this.doc); // an existing document is returned UNCHANGED: `$setOnInsert` does nothing on it
      },
    };
    return chain;
  }
}
