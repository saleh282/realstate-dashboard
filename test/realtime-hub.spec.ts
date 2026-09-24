import { RealtimeCloseCode, auctionRoomKey, normalizeAuctionId } from '../src/realtime/realtime.constants';
import { RealtimeHub, RealtimeUnavailableError } from '../src/realtime/realtime.hub';
import { AUCTION_A, AUCTION_B, FakeConnection, settingsFor } from './support/realtime-fixtures';

/**
 * MAZAD-032 — the in-process room registry: membership, caps, fan-out,
 * duplicate suppression, backpressure and terminal cleanup. Plain fakes, no sockets.
 */
const make = (overrides: Record<string, any> = {}) => new RealtimeHub(settingsFor(overrides));
const join = (hub: RealtimeHub, auction = AUCTION_A, conn = new FakeConnection()) => {
  expect(hub.admit(conn as any)).toBe('ADMITTED');
  expect(hub.subscribe(conn as any, auction)).toBe('ADDED');
  return conn;
};
const frame = (streamVersion: number, extra: object = {}) => ({ type: 'event', streamVersion, ...extra });

describe('auction ids and room keys', () => {
  it('accepts only 24 hex characters, lower-cases them, and rejects everything Mongoose would let through', () => {
    expect(normalizeAuctionId(AUCTION_A)).toBe(AUCTION_A);
    expect(normalizeAuctionId(AUCTION_A.toUpperCase())).toBe(AUCTION_A);
    for (const bad of ['', 'abc', 'abcdefghijkl', '64b0000000000000000aa00', '64b0000000000000000aa0011', 'auction:64b0000000000000000aa001', '64b0000000000000000aa00g', ' 64b0000000000000000aa001', '*', '../x', 12, null, undefined, {}, [], { $ne: null }, ['64b0000000000000000aa001']]) {
      expect(normalizeAuctionId(bad as any)).toBeNull();
    }
  });

  it('the room key is built from a validated id only', () => {
    expect(auctionRoomKey(AUCTION_A)).toBe(`auction:${AUCTION_A}`);
  });
});

describe('subscribe / unsubscribe', () => {
  it('a duplicate subscribe is a harmless no-op that adds no second membership', () => {
    const hub = make();
    const conn = join(hub);
    expect(hub.subscribe(conn as any, AUCTION_A)).toBe('ALREADY_SUBSCRIBED');
    expect(hub.stats()).toEqual({ connections: 1, rooms: 1, subscriptions: 1 });
    hub.publish(AUCTION_A, 1, frame(1));
    expect(conn.frames).toHaveLength(1); // one frame, not two
  });

  it('unsubscribe removes the membership; unsubscribing something never joined (or twice) is safe', () => {
    const hub = make();
    const conn = join(hub);
    expect(hub.unsubscribe(conn as any, AUCTION_A)).toBe(true);
    expect(hub.unsubscribe(conn as any, AUCTION_A)).toBe(false);
    expect(hub.unsubscribe(conn as any, AUCTION_B)).toBe(false);
    expect(hub.stats()).toEqual({ connections: 1, rooms: 0, subscriptions: 0 });
    hub.publish(AUCTION_A, 1, frame(1));
    expect(conn.frames).toEqual([]);
  });

  it('an empty room is deleted, so memory is bounded by live subscriptions', () => {
    const hub = make();
    const a = join(hub, AUCTION_A);
    const b = join(hub, AUCTION_A);
    hub.unsubscribe(a as any, AUCTION_A);
    expect(hub.stats().rooms).toBe(1);
    hub.unsubscribe(b as any, AUCTION_A);
    expect(hub.stats().rooms).toBe(0);
    expect(hub.hasSubscribers(AUCTION_A)).toBe(false);
  });

  it('enforces the per-socket subscription cap and reports it without adding the room', () => {
    const hub = make({ maxSubscriptionsPerSocket: 2 });
    const conn = new FakeConnection();
    hub.admit(conn as any);
    expect(hub.subscribe(conn as any, '64b0000000000000000aa001')).toBe('ADDED');
    expect(hub.subscribe(conn as any, '64b0000000000000000aa002')).toBe('ADDED');
    expect(hub.subscribe(conn as any, '64b0000000000000000aa003')).toBe('LIMIT_REACHED');
    expect(conn.subscriptions.size).toBe(2);
    expect(hub.stats().rooms).toBe(2);
    // Re-subscribing to one already held is not "a new one", so it still answers ALREADY_SUBSCRIBED at the cap.
    expect(hub.subscribe(conn as any, '64b0000000000000000aa001')).toBe('ALREADY_SUBSCRIBED');
    // Freeing a slot lets it subscribe again.
    hub.unsubscribe(conn as any, '64b0000000000000000aa001');
    expect(hub.subscribe(conn as any, '64b0000000000000000aa003')).toBe('ADDED');
  });

  it('a connection that was never admitted (or already left) cannot join a room', () => {
    const hub = make();
    const stranger = new FakeConnection();
    expect(hub.subscribe(stranger as any, AUCTION_A)).toBe('NOT_CONNECTED');
    const conn = join(hub);
    hub.disconnect(conn as any);
    expect(hub.subscribe(conn as any, AUCTION_A)).toBe('NOT_CONNECTED');
    expect(hub.stats()).toEqual({ connections: 0, rooms: 0, subscriptions: 0 });
  });
});

describe('disconnect cleanup', () => {
  it('removes every membership, empties the rooms and frees the address slot — idempotently', () => {
    const hub = make({ maxConnectionsPerIp: 1 });
    const conn = new FakeConnection('c1', '10.0.0.9');
    hub.admit(conn as any);
    hub.subscribe(conn as any, AUCTION_A);
    hub.subscribe(conn as any, AUCTION_B);
    expect(hub.admit(new FakeConnection('c2', '10.0.0.9') as any)).toBe('IP_LIMIT');
    hub.disconnect(conn as any);
    hub.disconnect(conn as any); // second call (error + close both fire) must not double-decrement
    expect(hub.stats()).toEqual({ connections: 0, rooms: 0, subscriptions: 0 });
    expect(conn.subscriptions.size).toBe(0);
    expect(hub.admit(new FakeConnection('c3', '10.0.0.9') as any)).toBe('ADMITTED');
    expect(hub.admit(new FakeConnection('c4', '10.0.0.9') as any)).toBe('IP_LIMIT'); // the slot count is exact, not off by one
  });

  it('one member leaving does not affect the others in the room', () => {
    const hub = make();
    const a = join(hub);
    const b = join(hub);
    hub.disconnect(a as any);
    hub.publish(AUCTION_A, 1, frame(1));
    expect(a.frames).toEqual([]);
    expect(b.frames).toHaveLength(1);
  });
});

describe('admission limits', () => {
  it('refuses beyond the total connection cap and beyond the per-address cap, counting addresses separately', () => {
    const hub = make({ maxConnections: 3, maxConnectionsPerIp: 2 });
    expect(hub.admit(new FakeConnection('a', '1.1.1.1') as any)).toBe('ADMITTED');
    expect(hub.admit(new FakeConnection('b', '1.1.1.1') as any)).toBe('ADMITTED');
    expect(hub.admit(new FakeConnection('c', '1.1.1.1') as any)).toBe('IP_LIMIT');
    expect(hub.admit(new FakeConnection('d', '2.2.2.2') as any)).toBe('ADMITTED');
    expect(hub.admit(new FakeConnection('e', '3.3.3.3') as any)).toBe('AT_CAPACITY');
  });

  it('admitting the same connection twice does not double count it', () => {
    const hub = make({ maxConnectionsPerIp: 2 });
    const conn = new FakeConnection();
    hub.admit(conn as any);
    hub.admit(conn as any);
    expect(hub.stats().connections).toBe(1);
    expect(hub.admit(new FakeConnection('x') as any)).toBe('ADMITTED');
  });
});

describe('fan-out, ordering and duplicates', () => {
  it('delivers to every member of the auction and only to them (rooms are isolated)', () => {
    const hub = make();
    const a1 = join(hub, AUCTION_A);
    const a2 = join(hub, AUCTION_A);
    const b1 = join(hub, AUCTION_B);
    const result = hub.publish(AUCTION_A, 1, frame(1, { auctionId: AUCTION_A }));
    expect(result).toEqual({ recipients: 2, dropped: 0 });
    expect(a1.frames).toHaveLength(1);
    expect(a2.frames).toHaveLength(1);
    expect(b1.frames).toEqual([]);
  });

  it('publishing with no subscribers is an accepted no-op', () => {
    const hub = make();
    expect(hub.publish(AUCTION_A, 1, frame(1))).toEqual({ recipients: 0, dropped: 0, skipped: 'NO_SUBSCRIBERS' });
  });

  it('frames of one auction reach a socket in publish order, and the payload is serialised once', () => {
    const hub = make();
    const conn = join(hub);
    for (let v = 1; v <= 20; v++) hub.publish(AUCTION_A, v, frame(v));
    expect(conn.frames.map((f) => f.streamVersion)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('a redelivered or stale event is skipped, so duplicate outbox delivery is harmless while the room lives', () => {
    const hub = make();
    const conn = join(hub);
    expect(hub.publish(AUCTION_A, 3, frame(3)).recipients).toBe(1);
    expect(hub.publish(AUCTION_A, 3, frame(3))).toEqual({ recipients: 0, dropped: 0, skipped: 'DUPLICATE_OR_STALE' });
    expect(hub.publish(AUCTION_A, 2, frame(2))).toMatchObject({ skipped: 'DUPLICATE_OR_STALE' }); // an older event never regresses a client
    expect(hub.publish(AUCTION_A, 4, frame(4)).recipients).toBe(1);
    expect(conn.frames.map((f) => f.streamVersion)).toEqual([3, 4]);
  });

  it('a gap is NOT papered over: version 5 after 3 is delivered as-is so the client can see the jump and resync', () => {
    const hub = make();
    const conn = join(hub);
    hub.publish(AUCTION_A, 3, frame(3));
    hub.publish(AUCTION_A, 5, frame(5));
    expect(conn.frames.map((f) => f.streamVersion)).toEqual([3, 5]);
  });

  it('duplicate suppression is per auction and forgotten when the room empties (clients still deduplicate on eventId)', () => {
    const hub = make();
    const conn = join(hub, AUCTION_A);
    join(hub, AUCTION_B);
    hub.publish(AUCTION_A, 7, frame(7));
    expect(hub.publish(AUCTION_B, 1, frame(1)).recipients).toBe(1); // another auction's counter is independent
    hub.unsubscribe(conn as any, AUCTION_A);
    const fresh = join(hub, AUCTION_A);
    expect(hub.publish(AUCTION_A, 7, frame(7)).recipients).toBe(1); // a new room has no memory
    expect(fresh.frames).toHaveLength(1);
  });

  it('a socket that is no longer open is dropped and cleaned up rather than written to', () => {
    const hub = make();
    const dead = join(hub);
    const alive = join(hub);
    dead.open = false;
    expect(hub.publish(AUCTION_A, 1, frame(1))).toEqual({ recipients: 1, dropped: 1 });
    expect(dead.frames).toEqual([]);
    expect(hub.stats()).toEqual({ connections: 1, rooms: 1, subscriptions: 1 });
    expect(alive.frames).toHaveLength(1);
  });

  it('a slow peer (unsent buffer over the limit) is terminated and dropped; it never stalls or grows a queue for the others', () => {
    const hub = make({ maxBufferedBytes: 1_000 });
    const slow = join(hub);
    const fast = join(hub);
    slow.buffered = 5_000;
    expect(hub.publish(AUCTION_A, 1, frame(1))).toEqual({ recipients: 1, dropped: 1 });
    expect(slow.terminated).toBe(true);
    expect(slow.frames).toEqual([]);
    expect(fast.frames).toHaveLength(1);
    expect(hub.stats().connections).toBe(1);
  });

  it('a socket whose write throws is terminated and dropped, and the remaining members still receive the frame', () => {
    const hub = make();
    const broken = join(hub);
    const ok = join(hub);
    broken.failSend = true;
    expect(hub.publish(AUCTION_A, 1, frame(1))).toEqual({ recipients: 1, dropped: 1 });
    expect(broken.terminated).toBe(true);
    expect(ok.frames).toHaveLength(1);
  });
});

describe('room closing (terminal / not visible)', () => {
  it('removes every subscription to the auction, optionally tells members why, and leaves sockets connected for other auctions', () => {
    const hub = make();
    const conn = join(hub, AUCTION_A);
    hub.subscribe(conn as any, AUCTION_B);
    const other = join(hub, AUCTION_A);
    expect(hub.closeRoom(AUCTION_A, { type: 'closed', auctionId: AUCTION_A })).toBe(2);
    expect(conn.frames).toEqual([{ type: 'closed', auctionId: AUCTION_A }]);
    expect(other.frames).toEqual([{ type: 'closed', auctionId: AUCTION_A }]);
    expect([...conn.subscriptions]).toEqual([AUCTION_B]);
    expect(hub.hasSubscribers(AUCTION_A)).toBe(false);
    expect(hub.hasSubscribers(AUCTION_B)).toBe(true);
    expect(conn.closed).toBeUndefined(); // the socket itself stays open
    hub.publish(AUCTION_A, 9, frame(9));
    expect(conn.frames).toHaveLength(1); // no later frame for the closed room
  });

  it('closing a room nobody is in is a no-op; a closed room can be re-joined', () => {
    const hub = make();
    expect(hub.closeRoom(AUCTION_A)).toBe(0);
    const conn = join(hub);
    hub.closeRoom(AUCTION_A);
    expect(hub.subscribe(conn as any, AUCTION_A)).toBe('ADDED');
  });
});

describe('shutdown', () => {
  it('tells every client to go away (1001), forgets everything, and refuses to publish or admit', () => {
    const hub = make();
    const conn = join(hub);
    hub.shutdown();
    expect(conn.closed).toEqual({ code: RealtimeCloseCode.GOING_AWAY, reason: 'SERVER_SHUTDOWN' });
    expect(hub.accepting).toBe(false);
    expect(hub.stats()).toEqual({ connections: 0, rooms: 0, subscriptions: 0 });
    expect(() => hub.publish(AUCTION_A, 1, frame(1))).toThrow(RealtimeUnavailableError); // so the outbox retries instead of acknowledging
    expect(hub.admit(new FakeConnection() as any)).toBe('CLOSED');
  });
});
