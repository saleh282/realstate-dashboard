import { ForbiddenException, Global, Module, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as mongoose from 'mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import WebSocket from 'ws';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuctionsQueryService } from '../src/auctions/auctions-query.service';
import { AuctionStatus } from '../src/auctions/auction.types';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { validateEnvironment } from '../src/config/environment.validation';
import { OutboxConsumerRegistry } from '../src/outbox/outbox-consumer.port';
import { OutboxDispatcherWorker } from '../src/outbox/outbox-dispatcher.worker';
import { RealtimeAuctionAccess } from '../src/realtime/realtime-auction-access';
import { RealtimeAuthenticator, RealtimeUnauthorizedError } from '../src/realtime/realtime-authenticator';
import { RealtimeCutoverService } from '../src/realtime/realtime-cutover.service';
import { REALTIME_CUTOVER_STORE } from '../src/realtime/realtime-cutover.store';
import { resolveClientAddress } from '../src/realtime/realtime-client-address';
import { RealtimeOutboxConsumer } from '../src/realtime/realtime-outbox.consumer';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';
import { RealtimeHub } from '../src/realtime/realtime.hub';
import { RealtimeModule } from '../src/realtime/realtime.module';
import { RealtimeSettings } from '../src/realtime/realtime.settings';
import { AccountStatus } from '../src/users/identity.types';
import { AUCTION_A, MemoryCutoverStore, activated, delivery } from './support/realtime-fixtures';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const express = require('express');

/**
 * MAZAD-032 — the parts around the sockets: the handshake authenticator against
 * the REAL JWT strategy, client-address derivation against REAL Express,
 * settings, environment rules (including the single-instance guard), the real
 * Nest module graph, and scope guards.
 */
const SECRET = 'realtime-test-access-secret';
const USER_ID = '64b000000000000000000001';

describe('RealtimeAuthenticator — same rules as the HTTP guard, via the real JwtStrategy', () => {
  const sign = (payload: object, options: { secret?: string; expiresIn?: any } = {}) =>
    new JwtService({}).sign(payload as any, { secret: options.secret ?? SECRET, expiresIn: options.expiresIn ?? '15m' });
  const valid = () => sign({ sub: USER_ID, sid: 'session-1', typ: 'access' });

  function build(overrides: { user?: any; sessionActive?: boolean; findById?: jest.Mock } = {}) {
    const config = { get: jest.fn((key: string) => (key === 'JWT_ACCESS_SECRET' ? SECRET : undefined)) } as any;
    const users = { findById: overrides.findById ?? jest.fn().mockResolvedValue('user' in overrides ? overrides.user : { accountStatus: AccountStatus.ACTIVE }) };
    const sessions = { isSessionActive: jest.fn().mockResolvedValue(overrides.sessionActive ?? true) };
    const strategy = new JwtStrategy(config, users as any, sessions as any);
    return { authenticator: new RealtimeAuthenticator(new JwtService({}), strategy, config), users, sessions };
  }
  const outcome = async (promise: Promise<unknown>) => { try { return await promise; } catch (error) { return error; } };

  it('no Authorization header is a guest; nothing is looked up', async () => {
    const { authenticator, users } = build();
    expect(await authenticator.authenticate(undefined)).toBeNull();
    expect(await authenticator.authenticate('')).toBeNull();
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('a valid access token for an active account authenticates', async () => {
    const { authenticator, users, sessions } = build();
    expect(await authenticator.authenticate(`Bearer ${valid()}`)).toEqual({ userId: USER_ID, sessionId: 'session-1' });
    expect(users.findById).toHaveBeenCalledWith(USER_ID);
    expect(sessions.isSessionActive).toHaveBeenCalledWith(USER_ID, 'session-1');
  });

  it('a suspended account is accepted exactly as the HTTP strategy accepts it', async () => {
    const { authenticator } = build({ user: { accountStatus: AccountStatus.SUSPENDED } });
    expect(await authenticator.authenticate(`Bearer ${valid()}`)).toMatchObject({ userId: USER_ID });
  });

  it.each([
    ['a header that is not a bearer credential', 'Basic dXNlcjpwYXNz'],
    ['a bearer header with no token', 'Bearer'],
    ['a bearer header with two tokens', 'Bearer a.b.c d.e.f'],
    ['a token glued to the scheme', 'Bearerabc.def.ghi'],
    ['characters outside the token alphabet', 'Bearer abc<script>.def.ghi'],
    ['a bare token', 'abc.def.ghi'],
  ])('%s is refused, never treated as a guest', async (_label, header) => {
    const { authenticator, users } = build();
    expect(await outcome(authenticator.authenticate(header))).toBeInstanceOf(RealtimeUnauthorizedError);
    expect(users.findById).not.toHaveBeenCalled();
  });

  it.each([
    ['a token signed with another secret', () => sign({ sub: USER_ID, sid: 's', typ: 'access' }, { secret: 'someone-elses-secret' })],
    ['an expired token', () => sign({ sub: USER_ID, sid: 's', typ: 'access' }, { expiresIn: '-10s' })],
    ['a tampered token', () => `${valid().slice(0, -3)}AAA`],
    ['a garbage token', () => 'not-a-jwt'],
    ['a password-reset token (purpose-scoped)', () => sign({ sub: USER_ID, sid: 's', typ: 'password_reset', purpose: 'password_reset' })],
    ['a session-less token', () => sign({ sub: USER_ID, typ: 'access' })],
    ['a refresh-typed token', () => sign({ sub: USER_ID, sid: 's', typ: 'refresh' })],
  ])('%s is refused', async (_label, make) => {
    const { authenticator } = build();
    expect(await outcome(authenticator.authenticate(`Bearer ${make()}`))).toBeInstanceOf(RealtimeUnauthorizedError);
  });

  it('a revoked session and a deleted user are refused', async () => {
    expect(await outcome(build({ sessionActive: false }).authenticator.authenticate(`Bearer ${valid()}`))).toBeInstanceOf(RealtimeUnauthorizedError);
    expect(await outcome(build({ user: null }).authenticator.authenticate(`Bearer ${valid()}`))).toBeInstanceOf(RealtimeUnauthorizedError);
  });

  it.each([AccountStatus.BLOCKED, AccountStatus.PERMANENTLY_BANNED, AccountStatus.DELETION_PENDING, AccountStatus.ANONYMIZED])(
    'an account in status %s is refused (the same statuses HTTP rejects)', async (accountStatus) => {
      const { authenticator } = build({ user: { accountStatus } });
      expect(await outcome(authenticator.authenticate(`Bearer ${valid()}`))).toBeInstanceOf(RealtimeUnauthorizedError);
    },
  );

  it('a database failure is NOT reported as a bad credential (so a client does not discard a good token)', async () => {
    const { authenticator } = build({ findById: jest.fn().mockRejectedValue(new Error('mongo timeout')) });
    const error = await outcome(authenticator.authenticate(`Bearer ${valid()}`));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RealtimeUnauthorizedError);
    expect((error as Error).message).toBe('mongo timeout');
  });

  it('the rejection carries no detail about why, and never the token', async () => {
    const token = valid();
    const error = (await outcome(build({ user: { accountStatus: AccountStatus.PERMANENTLY_BANNED } }).authenticator.authenticate(`Bearer ${token}`))) as Error;
    expect(error).toBeInstanceOf(RealtimeUnauthorizedError);
    expect(error.message).toBe('realtime credential rejected');
    expect(JSON.stringify(error)).not.toContain(token);
    expect(error instanceof UnauthorizedException || error instanceof ForbiddenException).toBe(false);
  });
});

describe('resolveClientAddress — the same address Express derives for HTTP', () => {
  const request = (peer: string, forwarded?: string) => ({ headers: forwarded ? { 'x-forwarded-for': forwarded } : {}, socket: { remoteAddress: peer } }) as any;
  const app = (trust: unknown) => { const a = express(); a.set('trust proxy', trust); return a; };

  it('a trusted proxy\'s X-Forwarded-For names the real client', () => {
    expect(resolveClientAddress(request('10.0.0.5', '203.0.113.7'), app(['10.0.0.0/8']))).toBe('203.0.113.7');
  });

  it('the forwarded header is ignored when the peer is not a trusted proxy (a client cannot forge its address)', () => {
    expect(resolveClientAddress(request('198.51.100.9', '1.2.3.4'), app(['10.0.0.0/8']))).toBe('198.51.100.9');
    expect(resolveClientAddress(request('198.51.100.9', '1.2.3.4'), app(false))).toBe('198.51.100.9');
  });

  it('a spoofed leftmost entry loses to the first untrusted address from the right', () => {
    expect(resolveClientAddress(request('10.0.0.5', '9.9.9.9, 203.0.113.7'), app(['10.0.0.0/8']))).toBe('203.0.113.7');
  });

  it('a hop-count setting is honoured', () => {
    expect(resolveClientAddress(request('10.0.0.5', '203.0.113.7'), app(1))).toBe('203.0.113.7');
  });

  it('a value that is not an IP falls back to the socket peer (no unlimited buckets from arbitrary strings)', () => {
    expect(resolveClientAddress(request('10.0.0.5', 'not-an-ip'), app(['10.0.0.0/8']))).toBe('10.0.0.5');
  });

  it('agrees with Express itself for the same request', () => {
    const expressApp = app(['loopback']);
    const raw = request('127.0.0.1', '198.51.100.23');
    const viaExpress = Object.create(expressApp.request, { headers: { value: raw.headers }, connection: { value: raw.socket }, socket: { value: raw.socket } }).ip;
    expect(resolveClientAddress(raw, expressApp)).toBe(viaExpress);
  });

  it('without an Express app it is the socket peer', () => {
    expect(resolveClientAddress(request('192.0.2.1', '203.0.113.7'))).toBe('192.0.2.1');
    expect(resolveClientAddress({ headers: {}, socket: undefined } as any)).toBe('unknown');
  });
});

describe('RealtimeSettings', () => {
  const settings = (values: Record<string, string>) => new RealtimeSettings({ get: (key: string) => values[key] } as any);

  it('is OFF by default, with documented defaults for every limit', () => {
    const s = settings({});
    expect(s.enabled).toBe(false);
    expect(s.topology).toBe('single_instance');
    expect(s).toMatchObject({
      maxConnections: 5_000, maxConnectionsPerIp: 100, maxSubscriptionsPerSocket: 50, maxMessageBytes: 2_048, messageRateLimit: 30,
      messageRateWindowMs: 10_000, heartbeatMs: 30_000, maxBufferedBytes: 1_048_576,
    });
  });

  it('reads overrides, ignores garbage (falls back to the default), and never exceeds the transport hard cap', () => {
    const s = settings({ REALTIME_ENABLED: ' TRUE ', REALTIME_MAX_SUBSCRIPTIONS_PER_SOCKET: '7', REALTIME_MAX_CONNECTIONS: 'lots', REALTIME_MAX_MESSAGE_BYTES: '999999', REALTIME_MESSAGE_RATE_LIMIT: '-3' });
    expect(s.enabled).toBe(true);
    expect(s.maxSubscriptionsPerSocket).toBe(7);
    expect(s.maxConnections).toBe(5_000);
    expect(s.maxMessageBytes).toBe(8_192);
    expect(s.messageRateLimit).toBe(30);
  });

  it('browser origins follow the HTTP CORS rule: production is allow-list only; development without a list allows any', () => {
    expect(settings({ NODE_ENV: 'production', CORS_ORIGINS: 'https://a.example, https://b.example' }).allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(settings({ NODE_ENV: 'production' }).allowedOrigins).toEqual([]);
    expect(settings({ NODE_ENV: 'development' }).allowedOrigins).toBe(true);
    expect(settings({ NODE_ENV: 'development', CORS_ORIGINS: 'https://a.example' }).allowedOrigins).toEqual(['https://a.example']);
  });
});

describe('RealtimeAuctionAccess — the real HTTP visibility gate, per status', () => {
  const oid = (hex: string) => new mongoose.Types.ObjectId(hex);
  function accessFor(doc: any | null, propertyVisible = true, lookup?: () => Promise<any>) {
    const auctions = { findById: () => ({ lean: () => ({ exec: lookup ?? (async () => doc) }) }) };
    const properties = { getAnchoredPublicProjections: async () => new Map(propertyVisible ? [[`${doc?.propertyId}:${doc?.propertyRevisionId}`, { id: 'p' }]] : []) };
    return new RealtimeAuctionAccess(new AuctionsQueryService(auctions as any, properties as any, { now: () => new Date() } as any));
  }
  const auction = (status: AuctionStatus) => ({ _id: oid(AUCTION_A), propertyId: oid('64b000000000000000000b01'), propertyRevisionId: oid('64b000000000000000000b02'), status });

  it.each([AuctionStatus.SCHEDULED, AuctionStatus.ACTIVE, AuctionStatus.ENDED_PENDING_CLOSE])('%s is publicly visible, so a guest may subscribe', async (status) => {
    expect(await accessFor(auction(status)).isPubliclyVisible(AUCTION_A)).toBe(true);
  });

  it.each([AuctionStatus.COMPLETED, AuctionStatus.CANCELLED, AuctionStatus.ENDED_NO_BIDS])(
    '%s is NOT publicly visible today (COMPLETED included — that product decision is unchanged), so a fresh subscription is refused', async (status) => {
      expect(await accessFor(auction(status)).isPubliclyVisible(AUCTION_A)).toBe(false);
    },
  );

  it('an active auction whose property is no longer public is refused, and a missing auction is refused with the same answer', async () => {
    expect(await accessFor(auction(AuctionStatus.ACTIVE), false).isPubliclyVisible(AUCTION_A)).toBe(false);
    expect(await accessFor(null).isPubliclyVisible(AUCTION_A)).toBe(false);
  });

  it('it follows the HTTP gate exactly: any non-404 failure is surfaced (the caller fails closed), never turned into "visible"', async () => {
    const failing = accessFor(auction(AuctionStatus.ACTIVE), true, async () => { throw new Error('mongo timeout'); });
    await expect(failing.isPubliclyVisible(AUCTION_A)).rejects.toThrow('mongo timeout');
  });

  it('only a NotFoundException means "hidden"', async () => {
    const queries = { getPubliclyVisible: jest.fn().mockRejectedValue(new NotFoundException()) };
    expect(await new RealtimeAuctionAccess(queries as any).isPubliclyVisible(AUCTION_A)).toBe(false);
    queries.getPubliclyVisible.mockRejectedValue(new ForbiddenException());
    await expect(new RealtimeAuctionAccess(queries as any).isPubliclyVisible(AUCTION_A)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('the real application wiring over a real socket (configureApp + RealtimeModule)', () => {
  it('configureApp installs the WebSocket adapter; the real module graph serves guests, refuses bad credentials, and delivers an outbox event through the registered consumer', async () => {
    const visible = jest.fn(async (id: string) => { if (id !== AUCTION_A) throw new NotFoundException(); return {}; });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, load: [() => ({ NODE_ENV: 'test', JWT_ACCESS_SECRET: 'x', JWT_REFRESH_SECRET: 'y', REALTIME_ENABLED: 'true' })] }),
        FakeMongooseCoreModule, RealtimeModule,
      ],
    }).overrideProvider(AuctionsQueryService).useValue({ getPubliclyVisible: visible })
      .overrideProvider(REALTIME_CUTOVER_STORE).useValue(new MemoryCutoverStore()).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, { NODE_ENV: 'test' } as any);
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as any).port;
    const open = (headers: Record<string, string> = {}) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime`, { headers });
      const frames: any[] = [];
      let closed: { code: number; reason: string } | undefined;
      ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
      ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; });
      ws.on('error', () => undefined);
      const until = async (cond: () => boolean) => { const end = Date.now() + 2_000; while (!cond()) { if (Date.now() > end) throw new Error(`timeout ${JSON.stringify({ frames, closed })}`); await new Promise((r) => setTimeout(r, 5)); } };
      return { ws, frames, until, closed: () => closed };
    };
    try {
      const guest = open();
      await guest.until(() => guest.frames.length === 1);
      expect(guest.frames[0]).toMatchObject({ type: 'ready', authenticated: false });
      guest.ws.send(JSON.stringify({ op: 'subscribe', auctionId: AUCTION_A }));
      await guest.until(() => guest.frames.length === 2);
      expect(guest.frames[1]).toMatchObject({ type: 'subscribed', auctionId: AUCTION_A });
      guest.ws.send(JSON.stringify({ op: 'subscribe', auctionId: '64b0000000000000000ffff9' }));
      await guest.until(() => guest.frames.length === 3);
      expect(guest.frames[2]).toMatchObject({ type: 'error', code: 'REALTIME_AUCTION_NOT_AVAILABLE' });

      // The consumer registered in the OUTBOX registry is the one that reaches this socket.
      await moduleRef.get(RealtimeCutoverService).activate();
      await moduleRef.get(OutboxConsumerRegistry).get('realtime')!.deliver(delivery(activated(AUCTION_A), 1));
      await guest.until(() => guest.frames.length === 4);
      expect(guest.frames[3]).toMatchObject({ type: 'event', event: 'AUCTION_ACTIVATED', auctionId: AUCTION_A, streamVersion: 1 });

      const stale = open({ Authorization: 'Bearer definitely.not.valid' }); // real JwtService + real JwtStrategy; refused before any database use
      await stale.until(() => stale.closed() !== undefined);
      expect(stale.closed()).toEqual({ code: 4401, reason: 'UNAUTHORIZED' });
    } finally {
      await app.close();
    }
  });
});

describe('environment validation — realtime and the single-instance guard', () => {
  const development = { NODE_ENV: 'development', MONGO_URI: 'mongodb://localhost/x', JWT_ACCESS_SECRET: 'a', JWT_ACCESS_EXPIRES_IN: '15m', JWT_REFRESH_SECRET: 'b', JWT_REFRESH_EXPIRES_IN: '7d' };
  const production = {
    NODE_ENV: 'production', MONGO_URI: 'mongodb://db/x', DEPLOYMENT_ENV: 'production', DB_ENV_ALLOWLIST: 'db/x', JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), JWT_ACCESS_EXPIRES_IN: '15m', JWT_REFRESH_EXPIRES_IN: '7d',
    MAIL_HOST: 'smtp.example.com', MAIL_PORT: '587', MAIL_SECURE: 'false', MAIL_USER: 'u', MAIL_PASS: 'p', MAIL_FROM: 'no-reply@example.com', MAIL_TLS_REJECT_UNAUTHORIZED: 'true',
    CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', CORS_ORIGINS: 'https://admin.example.com', TRUST_PROXY: '10.0.0.0/8',
    GEOCODING_USER_AGENT: 'Mazad/1.0 (ops@example.com)', GEOCODING_PROVIDER_BASE_URL: 'https://geocoder.internal.example.com',
  };

  it('realtime settings are optional; a valid set passes and every bad shape is named', () => {
    expect(() => validateEnvironment({ ...development })).not.toThrow();
    expect(() => validateEnvironment({
      ...development, REALTIME_ENABLED: 'true', REALTIME_TOPOLOGY: 'single_instance', REALTIME_MAX_CONNECTIONS: '5000', REALTIME_MAX_CONNECTIONS_PER_IP: '100',
      REALTIME_MAX_SUBSCRIPTIONS_PER_SOCKET: '50', REALTIME_MAX_MESSAGE_BYTES: '2048', REALTIME_MESSAGE_RATE_LIMIT: '30', REALTIME_MESSAGE_RATE_WINDOW_SECONDS: '10',
      REALTIME_HEARTBEAT_SECONDS: '30', REALTIME_MAX_BUFFERED_BYTES: '1048576',
    })).not.toThrow();
    const invalid = (extra: Record<string, string>) => () => validateEnvironment({ ...development, ...extra });
    expect(invalid({ REALTIME_ENABLED: 'yes' })).toThrow('REALTIME_ENABLED');
    expect(invalid({ REALTIME_MAX_CONNECTIONS: '0' })).toThrow('REALTIME_MAX_CONNECTIONS');
    expect(invalid({ REALTIME_MAX_CONNECTIONS_PER_IP: 'many' })).toThrow('REALTIME_MAX_CONNECTIONS_PER_IP');
    expect(invalid({ REALTIME_MAX_SUBSCRIPTIONS_PER_SOCKET: '501' })).toThrow('REALTIME_MAX_SUBSCRIPTIONS_PER_SOCKET');
    expect(invalid({ REALTIME_MAX_MESSAGE_BYTES: '8193' })).toThrow('REALTIME_MAX_MESSAGE_BYTES');
    expect(invalid({ REALTIME_MAX_MESSAGE_BYTES: '64' })).toThrow('REALTIME_MAX_MESSAGE_BYTES');
    expect(invalid({ REALTIME_MESSAGE_RATE_LIMIT: '0' })).toThrow('REALTIME_MESSAGE_RATE_LIMIT');
    expect(invalid({ REALTIME_MESSAGE_RATE_WINDOW_SECONDS: '301' })).toThrow('REALTIME_MESSAGE_RATE_WINDOW_SECONDS');
    expect(invalid({ REALTIME_HEARTBEAT_SECONDS: '1' })).toThrow('REALTIME_HEARTBEAT_SECONDS');
    expect(invalid({ REALTIME_MAX_BUFFERED_BYTES: '100' })).toThrow('REALTIME_MAX_BUFFERED_BYTES');
    expect(invalid({ REALTIME_TOPOLOGY: 'multi_instance' })).toThrow('REALTIME_TOPOLOGY must be single_instance');
  });

  it('production starts without realtime (the default is off) and with realtime only when the single-instance topology is declared', () => {
    expect(() => validateEnvironment(production)).not.toThrow();
    expect(() => validateEnvironment({ ...production, REALTIME_ENABLED: 'false' })).not.toThrow();
    expect(() => validateEnvironment({ ...production, REALTIME_ENABLED: 'true', REALTIME_TOPOLOGY: 'single_instance' })).not.toThrow();
  });

  it('production REFUSES to start with realtime enabled and no declared topology — several realtime replicas would silently drop events', () => {
    expect(() => validateEnvironment({ ...production, REALTIME_ENABLED: 'true' })).toThrow(/REALTIME_TOPOLOGY=single_instance is required in production/);
    expect(() => validateEnvironment({ ...production, REALTIME_ENABLED: 'TRUE', REALTIME_TOPOLOGY: '   ' })).toThrow(/REALTIME_TOPOLOGY=single_instance is required/);
    expect(() => validateEnvironment({ ...production, REALTIME_ENABLED: 'true', REALTIME_TOPOLOGY: 'shared' })).toThrow(/REALTIME_TOPOLOGY must be single_instance/);
  });

  it('development does not require the declaration', () => {
    expect(() => validateEnvironment({ ...development, REALTIME_ENABLED: 'true' })).not.toThrow();
  });
});

@Global()
@Module({ providers: [{ provide: getConnectionToken(), useValue: mongoose.createConnection() }], exports: [getConnectionToken()] })
class FakeMongooseCoreModule {}

describe('module wiring (real Nest graph, no database opened)', () => {
  // The cutover store is the one thing replaced: an unconnected Mongoose connection would only buffer its reads.
  const compile = (values: Record<string, string> = {}, cutoverStore = new MemoryCutoverStore()) => Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, load: [() => ({ NODE_ENV: 'test', JWT_ACCESS_SECRET: 'x', JWT_REFRESH_SECRET: 'y', ...values })] }),
      FakeMongooseCoreModule, RealtimeModule,
    ],
  }).overrideProvider(REALTIME_CUTOVER_STORE).useValue(cutoverStore).compile()
    .then(async (moduleRef) => { await moduleRef.init(); return moduleRef; }); // init() runs onModuleInit: this is where the consumer registers

  it('registers the `realtime` consumer exactly once, alongside the outbox, and it is not configured until enabled', async () => {
    const moduleRef = await compile();
    const registry = moduleRef.get(OutboxConsumerRegistry, { strict: false });
    expect(registry.list().map((c) => c.name)).toEqual(['realtime']);
    const consumer = moduleRef.get(RealtimeOutboxConsumer);
    expect(registry.get('realtime')).toBe(consumer);
    expect(consumer.configured).toBe(false); // opt-in: a plain deployment neither accepts sockets nor claims the stream
    expect(moduleRef.get(RealtimeGateway)).toBeDefined();
    expect(moduleRef.get(RealtimeHub)).toBeDefined();
    // The dispatcher worker skips it while not configured.
    const worker = moduleRef.get(OutboxDispatcherWorker, { strict: false });
    const dispatch = jest.spyOn((worker as any).dispatcher, 'dispatchConsumer');
    await worker.runOnce();
    expect(dispatch).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('is configured when REALTIME_ENABLED=true AND its activation cutover is established (bootstrap does that), not before', async () => {
    const store = new MemoryCutoverStore();
    const moduleRef = await compile({ REALTIME_ENABLED: 'true' }, store);
    await moduleRef.get(RealtimeCutoverService).activate(); // bootstrap already started this; activate() joins it
    expect(store.record).toMatchObject({ consumer: 'realtime' });
    expect(moduleRef.get(RealtimeOutboxConsumer).configured).toBe(true);
    await moduleRef.close();
  });

  it('a process with realtime DISABLED never reads or writes the cutover (so it cannot establish one)', async () => {
    const store = new MemoryCutoverStore();
    const moduleRef = await compile({}, store);
    expect(store.finds + store.scans + store.establishes).toBe(0);
    expect(moduleRef.get(RealtimeCutoverService).ready).toBe(false);
    await moduleRef.close();
  });

  it('enabled but the store is unreachable: not configured (the dispatcher skips it, nothing is claimed) until it recovers', async () => {
    const store = new MemoryCutoverStore();
    store.failFind = new Error('mongo unreachable');
    const moduleRef = await compile({ REALTIME_ENABLED: 'true' }, store);
    const consumer = moduleRef.get(RealtimeOutboxConsumer);
    await moduleRef.get(RealtimeCutoverService).activate();
    expect(consumer.configured).toBe(false);
    store.failFind = undefined;
    await moduleRef.get(RealtimeCutoverService).activate();
    expect(consumer.configured).toBe(true);
    await moduleRef.close();
  });

  it('the application module imports it (and nothing else changed about the outbox wiring)', () => {
    const imports: unknown[] = Reflect.getMetadata('imports', AppModule);
    expect(imports).toContain(RealtimeModule);
  });
});

describe('scope guards (MAZAD-032)', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const realtimeFiles = walk(path.join(srcDir, 'realtime')).filter((f) => f.endsWith('.ts'));
  const code = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
  const allRealtimeCode = realtimeFiles.map(code).join('\n');

  it('adds no broker, no second socket stack, no notification/push/e-mail surface and no HTTP controller', () => {
    expect(allRealtimeCode).not.toMatch(/redis|kafka|amqp|rabbit|socket\.io|firebase|web-push|nodemailer|@Controller|@Get\(|@Post\(|@Sse\(/i);
    for (const file of walk(srcDir).filter((f) => f.endsWith('.ts'))) {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/from 'socket\.io|require\('socket\.io|ioredis|from 'redis'|kafkajs|amqplib/);
    }
  });

  it('the realtime code never touches identity, private routing, payments, or the outbox collection', () => {
    expect(allRealtimeCode).not.toMatch(/privateRouting|bidderAccountId|winnerAccountId|advertiserAccountId|paymentId|PaymentConfirmed|MANAGED_MARKETING/);
    // The outbox is never written...
    expect(allRealtimeCode).not.toMatch(/OutboxService|recordRequired|outbox_events/);
    // ...and its MODEL appears only where the activation cutover's single read-only aggregate needs it: the store, and the module that registers it.
    const mayReadOutbox = /realtime-cutover\.store\.ts$|realtime\.module\.ts$/;
    for (const file of realtimeFiles.filter((f) => !mayReadOutbox.test(f))) expect(code(file)).not.toMatch(/OutboxEvent\b|OutboxEventSchema|OutboxEvent\.name/);
  });

  it('the ONLY database access in the realtime code is the cutover store, on the cutover\'s own collection (deliberately narrowed by the activation-cutover closure)', () => {
    const dbAccess = /InjectModel|\.updateOne\(|\.deleteOne\(|\.findOneAndUpdate\(|\.insertMany\(|\.bulkWrite\(|\.deleteMany\(|\.updateMany\(/;
    const store = realtimeFiles.filter((f) => f.endsWith('realtime-cutover.store.ts'));
    expect(store).toHaveLength(1);
    for (const file of realtimeFiles.filter((f) => !store.includes(f))) expect(code(file)).not.toMatch(dbAccess);
    // Its own collection (read/write) and the outbox model (read-only: `.aggregate` is the only call, guarded in realtime-cutover.spec.ts).
    expect(code(store[0]).match(/InjectModel\([^)]*\)/g)).toEqual(['InjectModel(RealtimeCutover.name)', 'InjectModel(OutboxEvent.name)']);
  });

  it('realtime remains one independently registered consumer alongside MAZAD-036 notifications', () => {
    const registrations = walk(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('outbox-consumer.port.ts') && /[rR]egistry\.register\(/.test(fs.readFileSync(f, 'utf8')));
    expect(registrations.map((f) => path.relative(srcDir, f)).sort()).toEqual([
      'notifications/notifications-outbox.consumer.ts',
      'realtime/realtime-outbox.consumer.ts',
    ]);
    expect(registrations.filter((f) => path.relative(srcDir, f).startsWith('realtime/'))).toHaveLength(1);
  });

  it('realtime subscribes to no payment event, and holds no reference to the payment modules', () => {
    expect(allRealtimeCode).not.toMatch(/AUCTION_ENTRY_PAYMENT_CONFIRMED|MANAGED_MARKETING_PAYMENT_CONFIRMED/);
    expect(allRealtimeCode).not.toMatch(/from '\.\.\/payments|from '\.\.\/managed-marketing/);
  });

  it('bid acceptance, finalization and the outbox producers were not touched by this task', () => {
    for (const file of ['auctions/auction-bid-acceptance.service.ts', 'auctions/auction-finalization.service.ts', 'auctions/auction-lifecycle.service.ts', 'outbox/outbox.service.ts']) {
      expect(code(path.join(srcDir, file))).not.toMatch(/realtime|@nestjs\/websockets/i);
    }
  });
});
