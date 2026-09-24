import { ConfigService } from '@nestjs/config';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import WebSocket from 'ws';
import { ClockService } from '../src/common/time/clock.service';
import { OutboxConsumerRegistry } from '../src/outbox/outbox-consumer.port';
import { RealtimeAuctionAccess } from '../src/realtime/realtime-auction-access';
import { RealtimeAuthenticator, RealtimeUnauthorizedError } from '../src/realtime/realtime-authenticator';
import { RealtimeOutboxConsumer } from '../src/realtime/realtime-outbox.consumer';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import { RealtimeHub } from '../src/realtime/realtime.hub';
import { RealtimeCutoverService } from '../src/realtime/realtime-cutover.service';
import { RealtimeSettings } from '../src/realtime/realtime.settings';
import { AUCTION_A, AUCTION_B, BIDDER, WINNER, activated, bid, delivery, extended, finalized, lifecycle, liveCutover, pendingClose } from './support/realtime-fixtures';

/**
 * MAZAD-032 — REAL sockets. A real Nest application with the real `WsAdapter`,
 * gateway, hub and outbox consumer, and real `ws` clients over localhost. Only
 * the visibility gate and the token check are doubles (their real
 * implementations are covered separately). No database, no outbox collection.
 */
const FIXED_NOW = new Date('2026-05-08T10:00:07.000Z');
type Started = Awaited<ReturnType<typeof start>>;
const started: Array<{ app: { close(): Promise<void> } }> = [];
const clients: Client[] = [];

async function start(options: { config?: Record<string, string>; visible?: (id: string) => boolean | Promise<boolean>; authenticate?: (header: string | undefined) => Promise<any> } = {}) {
  const config = new ConfigService({ REALTIME_ENABLED: 'true', ...options.config });
  const control = { visible: options.visible ?? ((id: string) => id === AUCTION_A || id === AUCTION_B), fail: undefined as Error | undefined };
  const access = { isPubliclyVisible: jest.fn(async (id: string) => { if (control.fail) throw control.fail; return control.visible(id); }) };
  const authenticate = options.authenticate ?? (async (header: string | undefined) => {
    if (header === undefined) return null;
    if (header === 'Bearer good-token') return { userId: '64b000000000000000000001', sessionId: 'session-1' };
    throw new RealtimeUnauthorizedError();
  });
  const authenticator = { authenticate: jest.fn(authenticate) };
  const clock = { now: () => new Date(FIXED_NOW) };
  const cutover = { ready: true }; // the activation cutover; the real service has its own suite
  const moduleRef = await Test.createTestingModule({
    providers: [
      { provide: ConfigService, useValue: config }, RealtimeSettings, RealtimeHub,
      { provide: RealtimeAuctionAccess, useValue: access }, { provide: RealtimeAuthenticator, useValue: authenticator },
      { provide: ClockService, useValue: clock }, { provide: RealtimeCutoverService, useValue: cutover }, RealtimeGateway,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(0, '127.0.0.1');
  const port: number = (app.getHttpServer().address() as any).port;
  const hub = moduleRef.get(RealtimeHub);
  const settings = moduleRef.get(RealtimeSettings);
  const gateway = moduleRef.get(RealtimeGateway);
  const consumer = new RealtimeOutboxConsumer(new OutboxConsumerRegistry(), hub, access as any, clock as any, settings, liveCutover());
  (consumer as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const context = { app, port, hub, settings, gateway, consumer, access, authenticator, control, config, cutover };
  started.push(context);
  return context;
}

class Client {
  frames: any[] = [];
  closed?: { code: number; reason: string };
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => { if (!isBinary) this.frames.push(JSON.parse(data.toString())); });
    ws.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() }; });
    ws.on('error', () => undefined);
  }
  static async connect(port: number, options: WebSocket.ClientOptions = {}): Promise<Client> {
    const client = new Client(new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime`, options));
    clients.push(client);
    await new Promise<void>((resolve) => { client.ws.once('open', () => resolve()); client.ws.once('close', () => resolve()); client.ws.once('error', () => resolve()); });
    return client;
  }
  send(message: unknown) { this.ws.send(typeof message === 'string' ? message : JSON.stringify(message)); }
  types() { return this.frames.map((f) => f.type); }
  events() { return this.frames.filter((f) => f.type === 'event'); }
  errors() { return this.frames.filter((f) => f.type === 'error').map((f) => f.code); }
  last() { return this.frames[this.frames.length - 1]; }
  async until(predicate: () => boolean, label: string, ms = 2_000) {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; frames=${JSON.stringify(this.frames)} closed=${JSON.stringify(this.closed)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  async frameCount(n: number) { await this.until(() => this.frames.length >= n, `${n} frames`); }
  async closedWith() { await this.until(() => this.closed !== undefined, 'close'); return this.closed!; }
  /** Sends and waits for the next frame of the reply. */
  async request(message: unknown) {
    const before = this.frames.length;
    this.send(message);
    await this.frameCount(before + 1);
    return this.frames[before];
  }
}

async function guest(ctx: Started, options: WebSocket.ClientOptions = {}) {
  const client = await Client.connect(ctx.port, options);
  await client.until(() => client.frames.length > 0 || client.closed !== undefined, 'ready or close');
  return client;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

afterEach(async () => {
  for (const client of clients.splice(0)) { try { client.ws.terminate(); } catch { /* already gone */ } }
  for (const ctx of started.splice(0)) await ctx.app.close();
});

describe('connect / ready', () => {
  it('a guest connects without any credential and receives a ready frame with the server clock and its limits', async () => {
    const ctx = await start();
    const client = await guest(ctx);
    expect(client.frames[0]).toEqual({
      type: 'ready', protocolVersion: 1, serverTime: FIXED_NOW.toISOString(), authenticated: false, limits: { maxSubscriptions: 50, maxMessageBytes: 2048 },
    });
    expect(ctx.authenticator.authenticate).toHaveBeenCalledWith(undefined);
    expect(ctx.hub.stats().connections).toBe(1);
  });

  it('an authenticated user connects with a bearer header and is marked authenticated', async () => {
    const ctx = await start();
    const client = await guest(ctx, { headers: { Authorization: 'Bearer good-token' } });
    expect(client.frames[0]).toMatchObject({ type: 'ready', authenticated: true });
    expect(ctx.authenticator.authenticate).toHaveBeenCalledWith('Bearer good-token');
  });

  it('a credential that is present but unacceptable is refused (4401) — never silently downgraded to guest — and nothing it sent is processed', async () => {
    const ctx = await start();
    const client = await Client.connect(ctx.port, { headers: { Authorization: 'Bearer stale-token' } });
    client.send({ op: 'subscribe', auctionId: AUCTION_A }); // sent before the credential check finished
    expect(await client.closedWith()).toEqual({ code: 4401, reason: 'UNAUTHORIZED' });
    expect(client.frames).toEqual([]);
    expect(ctx.access.isPubliclyVisible).not.toHaveBeenCalled();
    expect(ctx.hub.stats()).toEqual({ connections: 0, rooms: 0, subscriptions: 0 });
  });

  it('a dependency failure during the credential check is not reported as a bad token (1013, retryable)', async () => {
    const ctx = await start({ authenticate: async () => { throw new Error('mongo down'); } });
    const client = await Client.connect(ctx.port, { headers: { Authorization: 'Bearer good-token' } });
    expect(await client.closedWith()).toEqual({ code: 1013, reason: 'AUTH_UNAVAILABLE' });
  });

  it('messages sent the instant the socket opens are queued behind the credential check and answered in order', async () => {
    const ctx = await start({ authenticate: async () => { await new Promise((r) => setTimeout(r, 30)); return null; } });
    const client = await Client.connect(ctx.port);
    client.send({ op: 'subscribe', auctionId: AUCTION_A, requestId: 'r-1' });
    await client.frameCount(2);
    expect(client.types()).toEqual(['ready', 'subscribed']);
  });

  it('while realtime is disabled the socket is closed immediately with a stable code and nothing is registered', async () => {
    const ctx = await start({ config: { REALTIME_ENABLED: 'false' } });
    const client = await Client.connect(ctx.port);
    expect(await client.closedWith()).toEqual({ code: 4503, reason: 'REALTIME_DISABLED' });
    expect(ctx.hub.stats().connections).toBe(0);
  });

  it('only the exact endpoint path upgrades', async () => {
    const ctx = await start();
    const other = new WebSocket(`ws://127.0.0.1:${ctx.port}/api/v1/realtime/extra`);
    other.on('error', () => undefined);
    const outcome = await new Promise<string>((resolve) => { other.on('open', () => resolve('open')); other.on('close', () => resolve('closed')); other.on('unexpected-response', () => resolve('rejected')); });
    expect(outcome).not.toBe('open');
  });
});

describe('subscribe / unsubscribe', () => {
  it('a guest can subscribe to a publicly visible auction; the acknowledgement points at the authoritative HTTP resync endpoints', async () => {
    const ctx = await start();
    const client = await guest(ctx);
    const ack = await client.request({ op: 'subscribe', auctionId: AUCTION_A, requestId: 'req-1' });
    expect(ack).toEqual({
      type: 'subscribed', requestId: 'req-1', auctionId: AUCTION_A, alreadySubscribed: false, serverTime: FIXED_NOW.toISOString(),
      resync: {
        required: true, reason: 'SUBSCRIPTION_STARTED',
        http: { auction: `/api/v1/auctions/${AUCTION_A}`, bidState: `/api/v1/auctions/${AUCTION_A}/bid-state`, bidHistory: `/api/v1/auctions/${AUCTION_A}/bids` },
      },
    });
    expect(ctx.access.isPubliclyVisible).toHaveBeenCalledWith(AUCTION_A);
    expect(ctx.hub.stats()).toEqual({ connections: 1, rooms: 1, subscriptions: 1 });
  });

  it('until the activation cutover is persisted NOTHING can be subscribed: the refusal is retryable, does no lookup, joins no room; afterwards the same request succeeds', async () => {
    const ctx = await start();
    ctx.cutover.ready = false;
    const client = await guest(ctx);
    const refused = await client.request({ op: 'subscribe', auctionId: AUCTION_A, requestId: 'early' });
    expect(refused).toMatchObject({ type: 'error', code: 'REALTIME_TEMPORARILY_UNAVAILABLE', requestId: 'early', auctionId: AUCTION_A });
    expect(ctx.access.isPubliclyVisible).not.toHaveBeenCalled();
    expect(ctx.hub.stats()).toEqual({ connections: 1, rooms: 0, subscriptions: 0 });
    expect(client.closed).toBeUndefined(); // the socket stays open: the client just retries
    ctx.cutover.ready = true;
    expect((await client.request({ op: 'subscribe', auctionId: AUCTION_A, requestId: 'retry' })).type).toBe('subscribed');
    expect(ctx.hub.stats()).toEqual({ connections: 1, rooms: 1, subscriptions: 1 });
  });

  it('an authenticated user can subscribe too, and receives exactly what a guest receives', async () => {
    const ctx = await start();
    const user = await guest(ctx, { headers: { Authorization: 'Bearer good-token' } });
    const anon = await guest(ctx);
    for (const client of [user, anon]) expect((await client.request({ op: 'subscribe', auctionId: AUCTION_A })).type).toBe('subscribed');
    await ctx.consumer.deliver(delivery(bid(AUCTION_A, 1), 2));
    await user.until(() => user.events().length === 1, 'user event');
    await anon.until(() => anon.events().length === 1, 'guest event');
    expect(JSON.stringify(user.events())).toBe(JSON.stringify(anon.events()));
  });

  it('a hidden or missing auction is refused with one code, is not joined, and its events are never delivered', async () => {
    const ctx = await start({ visible: (id) => id === AUCTION_A });
    const client = await guest(ctx);
    const refused = await client.request({ op: 'subscribe', auctionId: AUCTION_B, requestId: 'x1' });
    expect(refused).toMatchObject({ type: 'error', code: 'REALTIME_AUCTION_NOT_AVAILABLE', requestId: 'x1', auctionId: AUCTION_B });
    const missing = await client.request({ op: 'subscribe', auctionId: '64b0000000000000000ffff9' });
    expect(missing.code).toBe('REALTIME_AUCTION_NOT_AVAILABLE'); // indistinguishable from "hidden"
    expect(ctx.hub.stats().rooms).toBe(0);
    await ctx.consumer.deliver(delivery(bid(AUCTION_B, 1), 1));
    await settle();
    expect(client.events()).toEqual([]);
  });

  it('a visibility lookup that fails is a retryable error, subscribes nothing, and leaks no detail', async () => {
    const ctx = await start();
    ctx.control.fail = new Error('mongodb://user:pass@host: connection refused');
    const client = await guest(ctx);
    const reply = await client.request({ op: 'subscribe', auctionId: AUCTION_A });
    expect(reply).toMatchObject({ type: 'error', code: 'REALTIME_TEMPORARILY_UNAVAILABLE' });
    expect(JSON.stringify(reply)).not.toMatch(/mongodb|pass|refused|Error/);
    expect(ctx.hub.stats().subscriptions).toBe(0);
    ctx.control.fail = undefined;
    expect((await client.request({ op: 'subscribe', auctionId: AUCTION_A })).type).toBe('subscribed');
  });

  it('an upper-case id is normalised, so the subscription receives the (lower-case) auction stream', async () => {
    const ctx = await start();
    const client = await guest(ctx);
    const ack = await client.request({ op: 'subscribe', auctionId: AUCTION_A.toUpperCase() });
    expect(ack).toMatchObject({ type: 'subscribed', auctionId: AUCTION_A });
    await ctx.consumer.deliver(delivery(activated(AUCTION_A), 1));
    await client.until(() => client.events().length === 1, 'event');
  });

  it('a duplicate subscribe is answered alreadySubscribed without a second lookup or a second copy of each event', async () => {
    const ctx = await start();
    const client = await guest(ctx);
    await client.request({ op: 'subscribe', auctionId: AUCTION_A });
    const again = await client.request({ op: 'subscribe', auctionId: AUCTION_A });
    expect(again).toMatchObject({ type: 'subscribed', alreadySubscribed: true });
    expect(ctx.access.isPubliclyVisible).toHaveBeenCalledTimes(1);
    expect(ctx.hub.stats().subscriptions).toBe(1);
    await ctx.consumer.deliver(delivery(bid(AUCTION_A, 1), 2));
    await client.until(() => client.events().length >= 1, 'event');
    await settle();
    expect(client.events()).toHaveLength(1);
  });

  it('unsubscribe stops delivery; unsubscribing twice, or something never joined, is safe', async () => {
    const ctx = await start();
    const client = await guest(ctx);
    await client.request({ op: 'subscribe', auctionId: AUCTION_A });
    expect(await client.request({ op: 'unsubscribe', auctionId: AUCTION_A, requestId: 'u1' })).toMatchObject({ type: 'unsubscribed', wasSubscribed: true, requestId: 'u1', auctionId: AUCTION_A });
    expect(await client.request({ op: 'unsubscribe', auctionId: AUCTION_A })).toMatchObject({ type: 'unsubscribed', wasSubscribed: false });
    expect(await client.request({ op: 'unsubscribe', auctionId: AUCTION_B })).toMatchObject({ type: 'unsubscribed', wasSubscribed: false });
    await ctx.consumer.deliver(delivery(bid(AUCTION_A, 1), 2));
    await settle();
    expect(client.events()).toEqual([]);
    expect(ctx.hub.stats().rooms).toBe(0);
  });

  it('a client that subscribed only to auction A never receives auction B events (rooms are isolated)', async () => {
    const ctx = await start();
    const onlyA = await guest(ctx);
    const onlyB = await guest(ctx);
    await onlyA.request({ op: 'subscribe', auctionId: AUCTION_A });
    await onlyB.request({ op: 'subscribe', auctionId: AUCTION_B });
    await ctx.consumer.deliver(delivery(bid(AUCTION_A, 1), 1));
    await ctx.consumer.deliver(delivery(bid(AUCTION_B, 1), 1));
    await onlyA.until(() => onlyA.events().length === 1, 'A event');
    await onlyB.until(() => onlyB.events().length === 1, 'B event');
    await settle();
    expect(onlyA.events().map((f) => f.auctionId)).toEqual([AUCTION_A]);
    expect(onlyB.events().map((f) => f.auctionId)).toEqual([AUCTION_B]);
  });

  it('disconnecting cleans every membership and frees the room', async () => {
    const ctx = await start();
    const client = await guest(ctx);
    await client.request({ op: 'subscribe', auctionId: AUCTION_A });
    await client.request({ op: 'subscribe', auctionId: AUCTION_B });
    expect(ctx.hub.stats()).toEqual({ connections: 1, rooms: 2, subscriptions: 2 });
    client.ws.close();
    await client.closedWith();
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (ctx.hub.stats().connections === 0) { clearInterval(t); resolve(); } }, 5); });
    expect(ctx.hub.stats()).toEqual({ connections: 0, rooms: 0, subscriptions: 0 });
  });

  it('an abrupt disconnect (no close handshake) is cleaned up as well', async () => {
    const ctx = await start();
    const client = await guest(ctx);
    await client.request({ op: 'subscribe', auctionId: AUCTION_A });
    client.ws.terminate();
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (ctx.hub.stats().connections === 0) { clearInterval(t); resolve(); } }, 5); });
    expect(ctx.hub.stats()).toEqual({ connections: 0, rooms: 0, subscriptions: 0 });
  });
});

describe('malformed input and arbitrary rooms', () => {
  it.each([
    ['not JSON', 'this is not json', 'REALTIME_MESSAGE_MALFORMED'],
    ['a JSON array', '[1,2,3]', 'REALTIME_MESSAGE_MALFORMED'],
    ['a JSON string', '"subscribe"', 'REALTIME_MESSAGE_MALFORMED'],
    ['JSON null', 'null', 'REALTIME_MESSAGE_MALFORMED'],
    ['a number', '42', 'REALTIME_MESSAGE_MALFORMED'],
    ['an empty object', '{}', 'REALTIME_MESSAGE_MALFORMED'],
    ['a non-string op', JSON.stringify({ op: 7, auctionId: AUCTION_A }), 'REALTIME_MESSAGE_MALFORMED'],
    ['an unknown op', JSON.stringify({ op: 'join', auctionId: AUCTION_A }), 'REALTIME_OPERATION_UNKNOWN'],
    ['a missing auctionId', JSON.stringify({ op: 'subscribe' }), 'REALTIME_AUCTION_ID_INVALID'],
    ['an invalid auctionId', JSON.stringify({ op: 'subscribe', auctionId: 'not-an-id' }), 'REALTIME_AUCTION_ID_INVALID'],
    ['a 12-character auctionId (accepted by Mongoose, not by us)', JSON.stringify({ op: 'subscribe', auctionId: 'abcdefghijkl' }), 'REALTIME_AUCTION_ID_INVALID'],
    ['a wildcard auctionId', JSON.stringify({ op: 'subscribe', auctionId: '*' }), 'REALTIME_AUCTION_ID_INVALID'],
    ['a room name in the id field', JSON.stringify({ op: 'subscribe', auctionId: `auction:${AUCTION_A}` }), 'REALTIME_AUCTION_ID_INVALID'],
    ['an operator object as the id', JSON.stringify({ op: 'subscribe', auctionId: { $ne: null } }), 'REALTIME_AUCTION_ID_INVALID'],
    ['an array as the id', JSON.stringify({ op: 'subscribe', auctionId: [AUCTION_A] }), 'REALTIME_AUCTION_ID_INVALID'],
    ['an extra `room` field (a client can never name a room)', JSON.stringify({ op: 'subscribe', auctionId: AUCTION_A, room: 'admin' }), 'REALTIME_MESSAGE_MALFORMED'],
    ['an extra `channel` field', JSON.stringify({ op: 'subscribe', auctionId: AUCTION_A, channel: 'auction:*' }), 'REALTIME_MESSAGE_MALFORMED'],
    ['a __proto__ key', '{"op":"subscribe","auctionId":"' + AUCTION_A + '","__proto__":{"admin":true}}', 'REALTIME_MESSAGE_MALFORMED'],
    ['an unsafe requestId', JSON.stringify({ op: 'subscribe', auctionId: AUCTION_A, requestId: '<script>alert(1)</script>' }), 'REALTIME_MESSAGE_MALFORMED'],
    ['an over-long requestId', JSON.stringify({ op: 'subscribe', auctionId: AUCTION_A, requestId: 'r'.repeat(65) }), 'REALTIME_MESSAGE_MALFORMED'],
    ['a non-string requestId', JSON.stringify({ op: 'subscribe', auctionId: AUCTION_A, requestId: 5 }), 'REALTIME_MESSAGE_MALFORMED'],
  ])('%s → a stable error code, nothing subscribed, no lookup performed', async (_label, raw, code) => {
    const ctx = await start();
    const client = await guest(ctx);
    const reply = await client.request(raw);
    expect(reply).toMatchObject({ type: 'error', code });
    expect(Object.keys(reply).every((key) => ['type', 'code', 'message', 'requestId', 'auctionId', 'serverTime'].includes(key))).toBe(true);
    expect(JSON.stringify(reply)).not.toMatch(/stack|node_modules|\.ts|at Object|SyntaxError|Unexpected/);
    expect(ctx.hub.stats().rooms).toBe(0);
    expect(ctx.access.isPubliclyVisible).not.toHaveBeenCalled();
    expect(client.closed).toBeUndefined(); // one bad message does not kill the connection
  });

  it('a binary frame is rejected as malformed', async () => {
    const ctx = await start();
    const client = await guest(ctx);
    const before = client.frames.length;
    client.ws.send(Buffer.from([1, 2, 3, 4]), { binary: true });
    await client.frameCount(before + 1);
    expect(client.last()).toMatchObject({ type: 'error', code: 'REALTIME_MESSAGE_MALFORMED' });
  });

  it('a frame above the configured limit is answered with MESSAGE_TOO_LARGE and not parsed', async () => {
    const ctx = await start();
    const client = await guest(ctx);
    const reply = await client.request(JSON.stringify({ op: 'subscribe', auctionId: AUCTION_A, requestId: 'x'.repeat(3_000) }));
    expect(reply).toMatchObject({ type: 'error', code: 'REALTIME_MESSAGE_TOO_LARGE' });
    expect(ctx.hub.stats().rooms).toBe(0);
  });

  it('a frame above the transport hard ceiling closes the socket (1009) before it is buffered', async () => {
    const ctx = await start();
    const client = await guest(ctx);
    client.send('x'.repeat(20_000));
    expect((await client.closedWith()).code).toBe(1009);
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (ctx.hub.stats().connections === 0) { clearInterval(t); resolve(); } }, 5); });
  });

  it('the configured message limit can only be lowered below the hard ceiling', async () => {
    const ctx = await start({ config: { REALTIME_MAX_MESSAGE_BYTES: '100000' } });
    expect(ctx.settings.maxMessageBytes).toBe(8192);
  });
});

describe('resource and abuse controls', () => {
  it('one socket cannot subscribe to unlimited auctions: the cap is enforced, before any lookup', async () => {
    const ctx = await start({ config: { REALTIME_MAX_SUBSCRIPTIONS_PER_SOCKET: '3' }, visible: () => true });
    const client = await guest(ctx);
    const ids = ['64b0000000000000000aa0a1', '64b0000000000000000aa0a2', '64b0000000000000000aa0a3', '64b0000000000000000aa0a4'];
    for (const id of ids.slice(0, 3)) expect((await client.request({ op: 'subscribe', auctionId: id })).type).toBe('subscribed');
    const lookups = ctx.access.isPubliclyVisible.mock.calls.length;
    const refused = await client.request({ op: 'subscribe', auctionId: ids[3] });
    expect(refused).toMatchObject({ type: 'error', code: 'REALTIME_SUBSCRIPTION_LIMIT_REACHED', auctionId: ids[3] });
    expect(ctx.access.isPubliclyVisible.mock.calls.length).toBe(lookups);
    expect(ctx.hub.stats().subscriptions).toBe(3);
    await client.request({ op: 'unsubscribe', auctionId: ids[0] });
    expect((await client.request({ op: 'subscribe', auctionId: ids[3] })).type).toBe('subscribed');
  });

  it('a burst of subscribes cannot race past the cap: messages of one socket are processed strictly in order', async () => {
    const ctx = await start({ config: { REALTIME_MAX_SUBSCRIPTIONS_PER_SOCKET: '3' }, visible: async () => { await new Promise((r) => setTimeout(r, 5)); return true; } });
    const client = await guest(ctx);
    for (let i = 1; i <= 10; i++) client.send({ op: 'subscribe', auctionId: `64b0000000000000000aa0${(0xb0 + i).toString(16)}`, requestId: `b${i}` });
    await client.until(() => client.frames.length >= 11, 'burst replies');
    expect(client.frames.filter((f) => f.type === 'subscribed')).toHaveLength(3);
    expect(client.frames.filter((f) => f.code === 'REALTIME_SUBSCRIPTION_LIMIT_REACHED')).toHaveLength(7);
    expect(ctx.hub.stats().subscriptions).toBe(3);
    expect(client.frames.slice(1).map((f) => f.requestId)).toEqual(Array.from({ length: 10 }, (_, i) => `b${i + 1}`)); // answered in request order
  });

  it('inbound messages are rate limited per socket: over the limit → ONE RATE_LIMITED notice and the message is dropped, the socket stays open', async () => {
    const ctx = await start({ config: { REALTIME_MESSAGE_RATE_LIMIT: '5', REALTIME_MESSAGE_RATE_WINDOW_SECONDS: '60' } });
    const client = await guest(ctx);
    for (let i = 0; i < 5; i++) expect((await client.request('nope')).code).toBe('REALTIME_MESSAGE_MALFORMED'); // the allowance
    client.send('nope'); // 6th
    client.send('nope'); // 7th
    await client.until(() => client.errors().includes('REALTIME_RATE_LIMITED'), 'rate-limit notice');
    await settle();
    expect(client.errors().filter((c) => c === 'REALTIME_RATE_LIMITED')).toHaveLength(1); // told once per window, not once per message
    expect(client.errors().filter((c) => c === 'REALTIME_MESSAGE_MALFORMED')).toHaveLength(5); // the excess was dropped unanswered
    expect(client.closed).toBeUndefined();
    // Nothing that was dropped could have subscribed.
    client.send({ op: 'subscribe', auctionId: AUCTION_A });
    await settle();
    expect(ctx.hub.stats().subscriptions).toBe(0);
  });

  it('a flood (more than twice the limit in one window) closes the socket with 4429 and stops processing it', async () => {
    const ctx = await start({ config: { REALTIME_MESSAGE_RATE_LIMIT: '5', REALTIME_MESSAGE_RATE_WINDOW_SECONDS: '60' } });
    const client = await guest(ctx);
    for (let i = 0; i < 12; i++) client.send('nope');
    expect(await client.closedWith()).toEqual({ code: 4429, reason: 'RATE_LIMITED' });
    expect(client.errors().filter((c) => c === 'REALTIME_RATE_LIMITED')).toHaveLength(1);
    expect(client.errors().filter((c) => c === 'REALTIME_MESSAGE_MALFORMED').length).toBeLessThanOrEqual(5);
    expect(ctx.hub.stats().connections).toBe(0);
    expect(ctx.access.isPubliclyVisible).not.toHaveBeenCalled();
  });

  it('the rate limit is per socket: one abusive client does not affect another', async () => {
    const ctx = await start({ config: { REALTIME_MESSAGE_RATE_LIMIT: '3', REALTIME_MESSAGE_RATE_WINDOW_SECONDS: '60' } });
    const abusive = await guest(ctx);
    const calm = await guest(ctx);
    for (let i = 0; i < 8; i++) abusive.send('nope');
    await abusive.closedWith();
    expect((await calm.request({ op: 'subscribe', auctionId: AUCTION_A })).type).toBe('subscribed');
  });

  it('caps connections per address (freed on disconnect) and in total', async () => {
    const ctx = await start({ config: { REALTIME_MAX_CONNECTIONS_PER_IP: '2', REALTIME_MAX_CONNECTIONS: '3' } });
    const one = await guest(ctx);
    await guest(ctx);
    const third = await guest(ctx);
    expect(await third.closedWith()).toEqual({ code: 4429, reason: 'TOO_MANY_CONNECTIONS' });
    expect(ctx.hub.stats().connections).toBe(2);
    one.ws.close();
    await one.closedWith();
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (ctx.hub.stats().connections === 1) { clearInterval(t); resolve(); } }, 5); });
    const fourth = await guest(ctx);
    expect(fourth.frames[0]).toMatchObject({ type: 'ready' });
  });

  it('caps total connections', async () => {
    const ctx = await start({ config: { REALTIME_MAX_CONNECTIONS: '1' } });
    await guest(ctx);
    const second = await guest(ctx);
    expect(await second.closedWith()).toEqual({ code: 1013, reason: 'AT_CAPACITY' });
  });

  it('the per-address limit follows the SAME client address Express derives under TRUST_PROXY, not the load balancer\'s', async () => {
    const ctx = await start({ config: { REALTIME_MAX_CONNECTIONS_PER_IP: '1' } });
    (ctx.app.getHttpAdapter().getInstance() as any).set('trust proxy', ['loopback']);
    const first = await guest(ctx, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    const second = await guest(ctx, { headers: { 'X-Forwarded-For': '203.0.113.8' } }); // a different real client behind the same proxy
    const sameAsFirst = await guest(ctx, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    expect(first.frames[0].type).toBe('ready');
    expect(second.frames[0].type).toBe('ready');
    expect(await sameAsFirst.closedWith()).toEqual({ code: 4429, reason: 'TOO_MANY_CONNECTIONS' });
  });

  it('a browser Origin outside the CORS allow-list is refused; an allowed origin and a native client (no Origin) connect', async () => {
    const ctx = await start({ config: { CORS_ORIGINS: 'https://admin.example.com' } });
    const evil = await Client.connect(ctx.port, { origin: 'https://evil.example' });
    expect(await evil.closedWith()).toEqual({ code: 4403, reason: 'FORBIDDEN_ORIGIN' });
    const allowed = await guest(ctx, { origin: 'https://admin.example.com' });
    expect(allowed.frames[0].type).toBe('ready');
    const native = await guest(ctx);
    expect(native.frames[0].type).toBe('ready');
  });

  it('heartbeat: a peer that never answers a ping is terminated on the next beat; a responsive one is kept', async () => {
    const ctx = await start();
    const responsive = await guest(ctx);
    const deaf = await guest(ctx, { autoPong: false });
    (ctx.gateway as any).beat(); // marks both not-alive and pings
    await new Promise((resolve) => setTimeout(resolve, 60)); // the responsive client's pong arrives
    (ctx.gateway as any).beat(); // the deaf one never answered
    await deaf.until(() => deaf.closed !== undefined, 'deaf close');
    expect(ctx.hub.stats().connections).toBe(1);
    expect(responsive.closed).toBeUndefined();
  });

  it('graceful shutdown tells clients to go away (1001) and the hub then refuses publishes', async () => {
    const ctx = await start();
    const client = await guest(ctx);
    await client.request({ op: 'subscribe', auctionId: AUCTION_A });
    ctx.gateway.onModuleDestroy();
    expect(await client.closedWith()).toEqual({ code: 1001, reason: 'SERVER_SHUTDOWN' });
    await expect(ctx.consumer.deliver(delivery(bid(AUCTION_A, 1), 1))).rejects.toThrow('not accepting');
  });
});

describe('events over the real socket', () => {
  it('BID_ACCEPTED reaches a subscriber with the authoritative amount, next minimum, end times and eventId', async () => {
    const ctx = await start();
    const client = await guest(ctx);
    await client.request({ op: 'subscribe', auctionId: AUCTION_A });
    const event = delivery(bid(AUCTION_A, 2, { extended: true }), 6);
    await ctx.consumer.deliver(event);
    await client.until(() => client.events().length === 1, 'bid event');
    expect(client.events()[0]).toMatchObject({
      type: 'event', event: 'BID_ACCEPTED', eventId: event.eventId, schemaVersion: 1, auctionId: AUCTION_A, streamVersion: 6, terminal: false, serverTime: FIXED_NOW.toISOString(),
      data: { sequence: 2, amountMinor: 110_000, currency: 'EGP', acceptedBidCount: 2, extended: true, currentEndAt: '2026-05-08T12:05:00.000Z', previousEndAt: '2026-05-08T12:00:00.000Z', nextMinimumBidMinor: 115_000 },
    });
  });

  it('a full lifecycle arrives in order, dense, identity-free, and ends the subscription at the terminal event', async () => {
    const ctx = await start({ visible: () => true });
    const client = await guest(ctx);
    await client.request({ op: 'subscribe', auctionId: AUCTION_A });
    const events = lifecycle().map((draft, index) => delivery(draft, index + 1));
    for (const event of events) await ctx.consumer.deliver(event);
    await client.until(() => client.events().length === 7, 'lifecycle');
    expect(client.events().map((f) => f.streamVersion)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(client.events().map((f) => f.event)).toEqual([
      'AUCTION_ACTIVATED', 'BID_ACCEPTED', 'BID_ACCEPTED', 'AUCTION_END_EXTENDED', 'BID_ACCEPTED', 'AUCTION_ENDED_PENDING_CLOSE', 'AUCTION_FINALIZED',
    ]);
    expect(client.events().map((f) => f.eventId)).toEqual(events.map((e) => e.eventId));
    expect(client.events().map((f) => f.terminal)).toEqual([false, false, false, false, false, false, true]);
    const wire = JSON.stringify(client.frames);
    for (const secret of [BIDDER, WINNER, 'privateRouting', 'bidderAccountId', 'winnerAccountId', 'audience', 'aggregateType']) expect(wire).not.toContain(secret);
    expect(client.events()[6].data.result).toEqual({ winningBidSequence: 3, winningBidAmountMinor: 115_000, currency: 'EGP' });
    // Terminal: the server ended the subscription but the connection stays usable.
    expect(ctx.hub.stats()).toEqual({ connections: 1, rooms: 0, subscriptions: 0 });
    expect(client.closed).toBeUndefined();
  });

  it('after a terminal event a fresh subscription to the (now hidden) auction is refused by the visibility gate', async () => {
    let completed = false;
    const ctx = await start({ visible: () => !completed });
    const client = await guest(ctx);
    await client.request({ op: 'subscribe', auctionId: AUCTION_A });
    completed = true; // COMPLETED auctions are outside the public visibility set
    await ctx.consumer.deliver(delivery(finalized(AUCTION_A), 2));
    await client.until(() => client.events().length === 1, 'terminal');
    expect(client.events()[0]).toMatchObject({ event: 'AUCTION_FINALIZED', terminal: true });
    expect((await client.request({ op: 'subscribe', auctionId: AUCTION_A })).code).toBe('REALTIME_AUCTION_NOT_AVAILABLE');
  });

  it('a property that becomes hidden while an auction is live closes the room on the next event, without sending that event', async () => {
    let hidden = false;
    const ctx = await start({ visible: () => !hidden });
    const client = await guest(ctx);
    await client.request({ op: 'subscribe', auctionId: AUCTION_A });
    await ctx.consumer.deliver(delivery(activated(AUCTION_A), 1));
    hidden = true;
    await ctx.consumer.deliver(delivery(bid(AUCTION_A, 1), 2));
    await client.until(() => client.types().includes('closed'), 'closed frame');
    expect(client.events().map((f) => f.event)).toEqual(['AUCTION_ACTIVATED']);
    expect(client.last()).toMatchObject({ type: 'closed', auctionId: AUCTION_A, reason: 'AUCTION_NOT_AVAILABLE', resync: { required: true, reason: 'SUBSCRIPTION_CLOSED' } });
    expect(ctx.hub.stats().subscriptions).toBe(0);
  });

  it('a duplicate outbox delivery reaches the socket once', async () => {
    const ctx = await start();
    const client = await guest(ctx);
    await client.request({ op: 'subscribe', auctionId: AUCTION_A });
    const event = delivery(bid(AUCTION_A, 1), 3);
    await ctx.consumer.deliver(event);
    await ctx.consumer.deliver({ ...event, attempt: 2 });
    await ctx.consumer.deliver({ ...event, attempt: 3 });
    await client.until(() => client.events().length >= 1, 'event');
    await settle();
    expect(client.events()).toHaveLength(1);
  });

  it('reconnect: the new socket gets a fresh ready and a resync-required acknowledgement, and history is NOT replayed over the socket', async () => {
    const ctx = await start();
    const first = await guest(ctx);
    await first.request({ op: 'subscribe', auctionId: AUCTION_A });
    await ctx.consumer.deliver(delivery(bid(AUCTION_A, 1), 2));
    await first.until(() => first.events().length === 1, 'first event');
    first.ws.terminate();
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (ctx.hub.stats().connections === 0) { clearInterval(t); resolve(); } }, 5); });
    await ctx.consumer.deliver(delivery(bid(AUCTION_A, 2), 3)); // happens while nobody is connected

    const second = await guest(ctx);
    expect(second.frames[0]).toMatchObject({ type: 'ready' });
    const ack = await second.request({ op: 'subscribe', auctionId: AUCTION_A });
    expect(ack.resync).toMatchObject({ required: true, reason: 'SUBSCRIPTION_STARTED' });
    await settle();
    expect(second.events()).toEqual([]); // missed events are recovered from HTTP, not replayed
    await ctx.consumer.deliver(delivery(bid(AUCTION_A, 3), 4));
    await second.until(() => second.events().length === 1, 'live event');
    expect(second.events()[0].streamVersion).toBe(4);
  });
});

describe('sanity', () => {
  it('the fixtures used above cover the pending-close and extension events', () => {
    expect(pendingClose().type).toBe('AUCTION_ENDED_PENDING_CLOSE');
    expect(extended().type).toBe('AUCTION_END_EXTENDED');
  });
});
