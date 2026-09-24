import { OutboxPermanentDeliveryError } from '../src/outbox/outbox-consumer.port';
import { OutboxAggregateType, OutboxAudience, OutboxEventType } from '../src/outbox/outbox-events';
import { REALTIME_SUBSCRIBED_EVENT_TYPES, REALTIME_TERMINAL_EVENT_TYPES, toRealtimeEvent } from '../src/realtime/realtime-events';
import {
  ADVERTISER, AUCTION_A, AUCTION_B, BIDDER, END, EXTENDED_END, PAYMENT, T0, WINNER,
  activated, bid, cancelled, delivery, entryPayment, extended, finalized, lifecycle, managedPayment, noBids, pendingClose,
} from './support/realtime-fixtures';

/**
 * MAZAD-032 — the client-facing event contract: exact shapes, the privacy
 * boundary (no identity of any kind), strict rejection of anything that is not
 * a public auction event, and the subscription/terminal catalogue.
 */
const SERVER_TIME = new Date('2026-05-08T10:00:07.500Z');
const map = (draft: any, version = 1) => toRealtimeEvent(delivery(draft, version), SERVER_TIME);
const permanent = (fn: () => unknown) => { try { fn(); } catch (error) { return error; } throw new Error('expected a permanent delivery error'); };

describe('realtime event contract (MAZAD-032)', () => {
  const envelope = (frame: any, draft: any, version: number) => ({
    type: 'event', event: draft.type, eventId: frame.eventId, schemaVersion: 1, auctionId: draft.aggregateId, streamVersion: version,
    occurredAt: draft.occurredAt.toISOString(), serverTime: SERVER_TIME.toISOString(),
  });

  it('BID_ACCEPTED carries the authoritative bid, count, end times, extension flag and next minimum — and the eventId', () => {
    const draft = bid(AUCTION_A, 2);
    const frame = map(draft, 5);
    expect(frame).toEqual({
      ...envelope(frame, draft, 5), terminal: false,
      data: {
        sequence: 2, amountMinor: 110_000, currency: 'EGP', acceptedAt: draft.occurredAt.toISOString(), acceptedBidCount: 2,
        currentEndAt: END.toISOString(), previousEndAt: END.toISOString(), extended: false, nextMinimumBidMinor: 115_000,
      },
    });
    expect(typeof frame.eventId).toBe('string');
    expect(frame.eventId).toMatch(/^[a-f0-9]{24}$/);
  });

  it('a bid that triggers anti-sniping carries the server-computed currentEndAt and previousEndAt — the client computes nothing', () => {
    const frame = map(bid(AUCTION_A, 3, { extended: true }));
    expect(frame.event).toBe(OutboxEventType.BID_ACCEPTED);
    expect((frame as any).data).toMatchObject({ extended: true, previousEndAt: END.toISOString(), currentEndAt: EXTENDED_END.toISOString() });
  });

  it('a null nextMinimumBidMinor (platform money ceiling) is preserved as null', () => {
    const draft = bid(AUCTION_A, 1);
    draft.payload.nextMinimumBidMinor = null;
    expect((map(draft) as any).data.nextMinimumBidMinor).toBeNull();
  });

  it('AUCTION_END_EXTENDED carries previousEndAt and currentEndAt', () => {
    const draft = extended();
    const frame = map(draft, 4);
    expect(frame).toEqual({ ...envelope(frame, draft, 4), terminal: false, data: { status: 'active', previousEndAt: END.toISOString(), currentEndAt: EXTENDED_END.toISOString() } });
  });

  it('AUCTION_ACTIVATED carries status and currentEndAt', () => {
    const draft = activated();
    const frame = map(draft, 1);
    expect(frame).toEqual({ ...envelope(frame, draft, 1), terminal: false, data: { status: 'active', currentEndAt: END.toISOString() } });
  });

  it('AUCTION_ENDED_PENDING_CLOSE says bidding closed and is NOT terminal (the auction stays publicly visible until finalized)', () => {
    const draft = pendingClose(AUCTION_A, 3);
    const frame = map(draft, 6);
    expect(frame).toEqual({ ...envelope(frame, draft, 6), terminal: false, data: { status: 'ended_pending_close', currentEndAt: EXTENDED_END.toISOString(), acceptedBidCount: 3 } });
  });

  it('AUCTION_ENDED_NO_BIDS is terminal', () => {
    const draft = noBids();
    const frame = map(draft, 2);
    expect(frame).toEqual({ ...envelope(frame, draft, 2), terminal: true, data: { status: 'ended_no_bids', currentEndAt: END.toISOString() } });
  });

  it('AUCTION_CANCELLED is terminal and carries no reason and no actor', () => {
    const draft = cancelled();
    const frame = map(draft, 3);
    expect(frame).toEqual({ ...envelope(frame, draft, 3), terminal: true, data: { status: 'cancelled', previousStatus: 'active', cancelledAt: draft.occurredAt.toISOString() } });
  });

  it('AUCTION_FINALIZED is terminal and carries ONLY the identity-free outcome (amount, sequence, currency, time)', () => {
    const draft = finalized();
    const frame = map(draft, 7);
    expect(frame).toEqual({
      ...envelope(frame, draft, 7), terminal: true,
      data: { status: 'completed', finalizedAt: draft.occurredAt.toISOString(), acceptedBidCount: 3, result: { winningBidSequence: 3, winningBidAmountMinor: 115_000, currency: 'EGP' } },
    });
  });

  it('exactly the three closing events are terminal; pending-close and everything else is not', () => {
    expect([...REALTIME_TERMINAL_EVENT_TYPES].sort()).toEqual([OutboxEventType.AUCTION_CANCELLED, OutboxEventType.AUCTION_ENDED_NO_BIDS, OutboxEventType.AUCTION_FINALIZED].sort());
    for (const draft of lifecycle()) expect(map(draft).terminal).toBe(REALTIME_TERMINAL_EVENT_TYPES.has(draft.type));
  });

  it('serverTime is the caller-supplied server clock, occurredAt the committed business instant, and streamVersion the outbox aggregateVersion', () => {
    const draft = bid(AUCTION_A, 1);
    const frame = map(draft, 9);
    expect(frame.serverTime).toBe('2026-05-08T10:00:07.500Z');
    expect(frame.occurredAt).toBe(draft.occurredAt.toISOString());
    expect(frame.streamVersion).toBe(9);
    expect(frame.occurredAt).not.toBe(frame.serverTime);
  });

  it('the same outbox event always maps to the same eventId (a redelivery is recognisable)', () => {
    const event = delivery(bid());
    const first = toRealtimeEvent(event, SERVER_TIME);
    const second = toRealtimeEvent({ ...event, attempt: 4 }, new Date(SERVER_TIME.getTime() + 60_000));
    expect(second.eventId).toBe(first.eventId);
    expect(second.streamVersion).toBe(first.streamVersion);
  });
});

describe('realtime privacy boundary (MAZAD-032)', () => {
  const FORBIDDEN_TEXT = [
    BIDDER, WINNER, ADVERTISER, PAYMENT, 'privateRouting', 'bidderAccountId', 'winnerAccountId', 'advertiserAccountId', 'accountId', 'userId',
    'email', 'phone', 'password', 'token', 'payment', 'provider', 'reason', 'audit', 'actor', 'cancelledBy', '@',
  ];

  it('no frame of a full lifecycle contains any account id, privateRouting, PII, payment data, audit data or a raw outbox document', () => {
    for (const draft of lifecycle()) {
      const event = delivery(draft, 3);
      const text = JSON.stringify(toRealtimeEvent(event, SERVER_TIME));
      for (const needle of FORBIDDEN_TEXT) expect(text.toLowerCase()).not.toContain(needle.toLowerCase());
      for (const rawKey of ['aggregateType', 'aggregateVersion', 'audience', 'attempt', 'payload', '_id', 'delivery', 'createdAt']) expect(text).not.toContain(`"${rawKey}"`);
    }
  });

  it('privateRouting is present on the events that have it and still never appears in the frame', () => {
    for (const draft of [bid(), finalized()]) {
      const event = delivery(draft);
      expect(event.privateRouting).toBeDefined();
      expect(Object.keys(toRealtimeEvent(event, SERVER_TIME))).not.toContain('privateRouting');
    }
  });

  it('the frame is an explicit whitelist: extra payload fields (even a bidder id, an e-mail, a payment id) are not copied', () => {
    const event = delivery(bid());
    Object.assign(event.payload as any, { bidderAccountId: BIDDER, email: 'x@example.com', paymentId: PAYMENT, note: 'secret', bidId: '64b000000000000000000b1d' });
    (event.payload as any).result = { winnerAccountId: WINNER };
    const text = JSON.stringify(toRealtimeEvent(event, SERVER_TIME));
    for (const leak of [BIDDER, 'x@example.com', PAYMENT, 'secret', '64b000000000000000000b1d', WINNER]) expect(text).not.toContain(leak);
  });

  it('a bid frame exposes exactly the documented data keys, nothing else', () => {
    const frame = toRealtimeEvent(delivery(bid()), SERVER_TIME) as any;
    expect(Object.keys(frame).sort()).toEqual(['auctionId', 'data', 'event', 'eventId', 'occurredAt', 'schemaVersion', 'serverTime', 'streamVersion', 'terminal', 'type']);
    expect(Object.keys(frame.data).sort()).toEqual(['acceptedAt', 'acceptedBidCount', 'amountMinor', 'currency', 'currentEndAt', 'extended', 'nextMinimumBidMinor', 'previousEndAt', 'sequence']);
  });

  it('the finalized frame has no winner object, id or bid id — only the anonymous result', () => {
    const frame = toRealtimeEvent(delivery(finalized()), SERVER_TIME) as any;
    expect(Object.keys(frame.data).sort()).toEqual(['acceptedBidCount', 'finalizedAt', 'result', 'status']);
    expect(Object.keys(frame.data.result).sort()).toEqual(['currency', 'winningBidAmountMinor', 'winningBidSequence']);
  });
});

describe('realtime strictness: only well-formed PUBLIC auction events become frames', () => {
  it('payment and managed-marketing events are not realtime events, and are not in the subscription list', () => {
    for (const draft of [entryPayment(), managedPayment()]) expect(permanent(() => map(draft))).toBeInstanceOf(OutboxPermanentDeliveryError);
    expect(REALTIME_SUBSCRIBED_EVENT_TYPES).not.toContain(OutboxEventType.AUCTION_ENTRY_PAYMENT_CONFIRMED);
    expect(REALTIME_SUBSCRIBED_EVENT_TYPES).not.toContain(OutboxEventType.MANAGED_MARKETING_PAYMENT_CONFIRMED);
  });

  it('subscribes to exactly the seven auction events realtime needs', () => {
    expect([...REALTIME_SUBSCRIBED_EVENT_TYPES].sort()).toEqual([
      OutboxEventType.AUCTION_ACTIVATED, OutboxEventType.AUCTION_CANCELLED, OutboxEventType.AUCTION_END_EXTENDED, OutboxEventType.AUCTION_ENDED_NO_BIDS,
      OutboxEventType.AUCTION_ENDED_PENDING_CLOSE, OutboxEventType.AUCTION_FINALIZED, OutboxEventType.BID_ACCEPTED,
    ].sort());
  });

  it.each([
    ['a PRIVATE audience', (e: any) => { e.audience = OutboxAudience.PRIVATE; }],
    ['a non-auction aggregate', (e: any) => { e.aggregateType = OutboxAggregateType.AUCTION_ENTRY_PAYMENT; }],
    ['an unsupported schema version', (e: any) => { e.schemaVersion = 2; }],
    ['a payload naming a different auction (cannot redirect a frame to another room)', (e: any) => { e.payload.auctionId = AUCTION_B; }],
    ['a missing payload field', (e: any) => { delete e.payload.amountMinor; }],
    ['a non-integer amount', (e: any) => { e.payload.amountMinor = 12.5; }],
    ['a string amount', (e: any) => { e.payload.amountMinor = '110000'; }],
    ['a negative amount', (e: any) => { e.payload.amountMinor = -1; }],
    ['an invalid currency', (e: any) => { e.payload.currency = 'egp'; }],
    ['an unparseable time', (e: any) => { e.payload.currentEndAt = 'not-a-date'; }],
    ['a non-boolean extended flag', (e: any) => { e.payload.extended = 'yes'; }],
    ['a zero bid sequence', (e: any) => { e.payload.sequence = 0; }],
    ['an invalid aggregateVersion', (e: any) => { e.aggregateVersion = 0; }],
    ['an invalid occurredAt', (e: any) => { e.occurredAt = new Date('nope'); }],
    ['a missing eventId', (e: any) => { e.eventId = ''; }],
  ])('%s is a permanent failure (dead-letter for realtime), never a frame', (_label, corrupt) => {
    const event: any = delivery(bid());
    corrupt(event);
    expect(permanent(() => toRealtimeEvent(event, SERVER_TIME))).toBeInstanceOf(OutboxPermanentDeliveryError);
  });

  it('a status that contradicts the event type is rejected (an ACTIVATED event cannot announce "completed")', () => {
    const event: any = delivery(activated());
    event.payload.status = 'completed';
    expect(permanent(() => toRealtimeEvent(event, SERVER_TIME))).toBeInstanceOf(OutboxPermanentDeliveryError);
  });

  it('the failure message names no value from the event', () => {
    const event: any = delivery(bid());
    event.payload.amountMinor = 'SECRET-AMOUNT';
    event.payload.currency = BIDDER;
    const error = permanent(() => toRealtimeEvent(event, SERVER_TIME)) as Error;
    expect(error.message).not.toContain('SECRET-AMOUNT');
    expect(error.message).not.toContain(BIDDER);
  });

  it('T0 sanity: fixtures use a fixed clock', () => {
    expect(T0.toISOString()).toBe('2026-05-08T10:00:00.000Z');
  });
});
