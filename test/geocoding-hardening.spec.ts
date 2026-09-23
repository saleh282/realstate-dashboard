import { INestApplication, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtService, JwtModule } from '@nestjs/jwt';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ExtractJwt, Strategy } from 'passport-jwt';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { Capability } from '../src/authorization/capability';
import { AuthorizationPolicyService } from '../src/authorization/authorization-policy.service';
import { CapabilityGuard } from '../src/authorization/capability.guard';
import { CAPABILITIES_KEY } from '../src/authorization/capabilities.decorator';
import { validateEnvironment } from '../src/config/environment.validation';
import { GeocodingController } from '../src/geocoding/geocoding.controller';
import { isPublicOsmNominatim, readGeocodingOptions } from '../src/geocoding/geocoding.config';
import { GeocodingModule } from '../src/geocoding/geocoding.module';
import { GEOCODING_BUSY_CODE, GeocodingService } from '../src/geocoding/geocoding.service';
import { GEOCODING_PROVIDER, GeocodingProvider } from '../src/geocoding/geocoding.types';
import { DisabledGeocodingProvider } from '../src/geocoding/disabled-geocoding.provider';
import { NominatimGeocodingProvider } from '../src/geocoding/nominatim-geocoding.provider';

const address = { displayName: 'x', district: '', street: '', additionalDetails: '', governorate: '', city: '' };
const fast = { minIntervalMs: 0, maxConcurrency: 4, maxQueue: 25, queueTimeoutMs: 10_000, cacheMaxEntries: 2_000 };

function provider(overrides: Partial<GeocodingProvider> = {}): GeocodingProvider {
  return { reverse: jest.fn(async () => address), search: jest.fn(async () => []), ...overrides };
}

describe('GeocodingService resource bounds', () => {
  afterEach(() => jest.useRealTimers());

  it('evicts the least recently used entries once the cache is full', async () => {
    const backend = provider();
    const service = new GeocodingService(backend, { ...fast, cacheMaxEntries: 3 });
    for (const lon of [31.1, 31.2, 31.3]) await service.reverse(30, lon);
    await service.reverse(30, 31.1); // touch the oldest so 31.2 becomes least recent
    await service.reverse(30, 31.4); // evicts 31.2
    expect(service.cacheSize).toBe(3);

    (backend.reverse as jest.Mock).mockClear();
    await service.reverse(30, 31.1);
    await service.reverse(30, 31.3);
    await service.reverse(30, 31.4);
    expect(backend.reverse).not.toHaveBeenCalled();
    await service.reverse(30, 31.2);
    expect(backend.reverse).toHaveBeenCalledTimes(1);
  });

  it('never lets the cache grow beyond its ceiling under many distinct queries', async () => {
    const service = new GeocodingService(provider(), { ...fast, cacheMaxEntries: 50 });
    for (let index = 0; index < 400; index++) await service.search(`query number ${index}`);
    expect(service.cacheSize).toBe(50);
  });

  it('rejects immediately once the waiting queue is full instead of growing without bound', async () => {
    const release: Array<() => void> = [];
    const backend = provider({
      reverse: jest.fn(() => new Promise<any>((resolve) => release.push(() => resolve(address)))),
    });
    const service = new GeocodingService(backend, { ...fast, maxConcurrency: 1, maxQueue: 2 });

    const running = service.reverse(30, 31.001);
    const queuedA = service.reverse(30, 31.002);
    const queuedB = service.reverse(30, 31.003);
    await expect(service.reverse(30, 31.004)).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: GEOCODING_BUSY_CODE, retryAfterSeconds: 5 }),
    });
    expect(service.queueLength).toBe(2);

    while (release.length) { release.shift()!(); await new Promise((resolve) => setImmediate(resolve)); }
    await expect(Promise.all([running, queuedA, queuedB])).resolves.toHaveLength(3);
    expect(service.queueLength).toBe(0);
  });

  it('drops a request that waits too long for a provider slot', async () => {
    jest.useFakeTimers();
    const backend = provider({ reverse: jest.fn(() => new Promise<any>(() => undefined)) });
    const service = new GeocodingService(backend, { ...fast, maxConcurrency: 1, queueTimeoutMs: 2_000 });
    void service.reverse(30, 31.001).catch(() => undefined);
    const waiting = service.reverse(30, 31.002);
    const outcome = expect(waiting).rejects.toMatchObject({ response: expect.objectContaining({ code: GEOCODING_BUSY_CODE }) });
    await jest.advanceTimersByTimeAsync(2_001);
    await outcome;
    expect(service.queueLength).toBe(0);
  });

  it('respects the configured concurrency', async () => {
    let active = 0;
    let peak = 0;
    const backend = provider({
      reverse: jest.fn(async () => {
        active += 1; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return address;
      }),
    });
    const service = new GeocodingService(backend, { ...fast, maxConcurrency: 2 });
    await Promise.all(Array.from({ length: 8 }, (_, index) => service.reverse(30, 31 + index / 1000)));
    expect(peak).toBe(2);
  });

  it('spaces provider calls by the minimum interval', async () => {
    jest.useFakeTimers();
    const starts: number[] = [];
    const backend = provider({ reverse: jest.fn(async () => { starts.push(Date.now()); return address; }) });
    const service = new GeocodingService(backend, { ...fast, minIntervalMs: 1_000 });
    const all = Promise.all([service.reverse(30, 31.001), service.reverse(30, 31.002), service.reverse(30, 31.003)]);
    await jest.advanceTimersByTimeAsync(2_100);
    await all;
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1_000);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(1_000);
  });

  it('frees its slot after a provider failure so later requests still succeed', async () => {
    const backend = provider({
      reverse: jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(address),
    });
    const service = new GeocodingService(backend, { ...fast, maxConcurrency: 1 });
    await expect(service.reverse(30, 31.001)).rejects.toThrow('boom');
    await expect(service.reverse(30, 31.002)).resolves.toEqual(address);
  });
});

describe('geocoding configuration', () => {
  const opts = (values: Record<string, string>) => readGeocodingOptions((key) => values[key]);

  it('keeps the strict serial defaults for the public OSM service and opens up for a private endpoint', () => {
    expect(opts({})).toMatchObject({ minIntervalMs: 1_100, maxConcurrency: 1, maxQueue: 25, cacheMaxEntries: 2_000 });
    expect(opts({ GEOCODING_PROVIDER_BASE_URL: 'https://nominatim.openstreetmap.org' })).toMatchObject({ maxConcurrency: 1 });
    expect(opts({ GEOCODING_PROVIDER_BASE_URL: 'https://geo.internal.example.com' })).toMatchObject({ minIntervalMs: 0, maxConcurrency: 4 });
  });

  it('accepts explicit overrides and ignores invalid ones', () => {
    expect(opts({ GEOCODING_PROVIDER_BASE_URL: 'https://g.example.com', GEOCODING_MAX_CONCURRENCY: '8', GEOCODING_CACHE_MAX_ENTRIES: '10' }))
      .toMatchObject({ maxConcurrency: 8, cacheMaxEntries: 10 });
    expect(opts({ GEOCODING_MAX_CONCURRENCY: '0', GEOCODING_MAX_QUEUE: 'many' })).toMatchObject({ maxConcurrency: 1, maxQueue: 25 });
  });

  it('recognises the public service by host', () => {
    expect(isPublicOsmNominatim(undefined)).toBe(true);
    expect(isPublicOsmNominatim('https://nominatim.openstreetmap.org/')).toBe(true);
    expect(isPublicOsmNominatim('https://geo.example.com')).toBe(false);
    expect(isPublicOsmNominatim('https://nominatim.openstreetmap.org.evil.example')).toBe(false);
  });
});

describe('production geocoder requirements', () => {
  const production = {
    NODE_ENV: 'production', MONGO_URI: 'mongodb://db/x',
    JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40),
    JWT_ACCESS_EXPIRES_IN: '15m', JWT_REFRESH_EXPIRES_IN: '7d',
    MAIL_HOST: 'smtp.example.com', MAIL_PORT: '587', MAIL_SECURE: 'false', MAIL_USER: 'u', MAIL_PASS: 'p',
    MAIL_FROM: 'no-reply@example.com', MAIL_TLS_REJECT_UNAUTHORIZED: 'true',
    CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's',
    CORS_ORIGINS: 'https://admin.example.com', TRUST_PROXY: '10.0.0.0/8',
    GEOCODING_USER_AGENT: 'Mazad/1.0 (ops@example.com)',
  };

  it('refuses the public OpenStreetMap service unless explicitly overridden', () => {
    expect(() => validateEnvironment(production)).toThrow(/GEOCODING_PROVIDER_BASE_URL must point to a self-hosted or commercial geocoder/);
    expect(() => validateEnvironment({ ...production, GEOCODING_PROVIDER_BASE_URL: 'https://nominatim.openstreetmap.org' })).toThrow(/self-hosted or commercial/);
    expect(() => validateEnvironment({ ...production, GEOCODING_ALLOW_PUBLIC_PROVIDER: 'true' })).not.toThrow();
  });

  it('accepts a private or commercial endpoint, or geocoding switched off', () => {
    expect(() => validateEnvironment({ ...production, GEOCODING_PROVIDER_BASE_URL: 'https://geo.internal.example.com' })).not.toThrow();
    expect(() => validateEnvironment({ ...production, GEOCODING_PROVIDER: 'disabled' })).not.toThrow();
  });

  it('validates provider name and tuning values', () => {
    const dev = { NODE_ENV: 'development', MONGO_URI: 'mongodb://x', JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'b', JWT_ACCESS_EXPIRES_IN: '15m', JWT_REFRESH_EXPIRES_IN: '7d' };
    expect(() => validateEnvironment({ ...dev, GEOCODING_PROVIDER: 'mapbox' })).toThrow('GEOCODING_PROVIDER must be');
    expect(() => validateEnvironment({ ...dev, GEOCODING_MAX_QUEUE: '0' })).toThrow('GEOCODING_MAX_QUEUE');
    expect(() => validateEnvironment({ ...dev, GEOCODING_MAX_CONCURRENCY: '4', GEOCODING_CACHE_MAX_ENTRIES: '100' })).not.toThrow();
  });
});

describe('NominatimGeocodingProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });
  const config = (values: Record<string, string>) => ({ get: (key: string) => values[key] }) as unknown as ConfigService;
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
  const status = (code: number) => ({ ok: false, status: code, json: async () => ({}) }) as Response;

  it('talks to the configured endpoint with its user agent and optional API key', async () => {
    const fetchMock = jest.fn().mockResolvedValue(ok([{ lat: '30.1', lon: '31.2', display_name: 'Nasr City', address: { suburb: 'Nasr City', state: 'Cairo' } }]));
    global.fetch = fetchMock as any;
    const backend = new NominatimGeocodingProvider(config({
      GEOCODING_PROVIDER_BASE_URL: 'https://geo.example.com/base/', GEOCODING_USER_AGENT: 'Mazad/1.0', GEOCODING_API_KEY: 'k3y', GEOCODING_API_KEY_PARAM: 'token',
    }));
    const places = await backend.search('nasr city', 'en');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/^https:\/\/geo\.example\.com\/search\?/);
    expect(new URL(String(url)).searchParams.get('token')).toBe('k3y');
    expect(init.headers['User-Agent']).toBe('Mazad/1.0');
    expect(places[0]).toMatchObject({ latitude: 30.1, longitude: 31.2, district: 'Nasr City', governorate: 'Cairo' });
  });

  it('defaults to the public service only when nothing is configured', async () => {
    const fetchMock = jest.fn().mockResolvedValue(ok({ display_name: 'x', address: {} }));
    global.fetch = fetchMock as any;
    await new NominatimGeocodingProvider(config({})).reverse(30, 31, 'ar');
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\/reverse/);
  });

  it('retries a provider outage once, then fails with a generic error that never contains the URL or API key', async () => {
    const fetchMock = jest.fn().mockResolvedValue(status(503));
    global.fetch = fetchMock as any;
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const backend = new NominatimGeocodingProvider(config({ GEOCODING_PROVIDER_BASE_URL: 'https://geo.example.com', GEOCODING_API_KEY: 'SUPERSECRETKEY' }));

    const failure = await backend.reverse(30, 31, 'ar').catch((error) => error);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failure.status).toBe(503);
    expect(JSON.stringify(failure.getResponse())).not.toMatch(/SUPERSECRETKEY|geo\.example\.com|503/);
    expect(errorLog.mock.calls.map((call) => String(call[0])).join('\n')).not.toMatch(/SUPERSECRETKEY|geo\.example\.com/);
    expect(JSON.parse(String(errorLog.mock.calls[0][0]))).toEqual({ event: 'geocoding_provider_unavailable', failure: 'http_503' });
  });

  it('classifies timeouts and network errors without leaking their text', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    global.fetch = jest.fn().mockRejectedValue(new DOMException('slow', 'TimeoutError')) as any;
    const timeout = await new NominatimGeocodingProvider(config({})).reverse(30, 31, 'ar').catch((error) => error);
    expect(timeout.status).toBe(503);

    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:443')) as any;
    const network = await new NominatimGeocodingProvider(config({})).reverse(30, 31, 'ar').catch((error) => error);
    expect(JSON.stringify(network.getResponse())).not.toContain('10.1.2.3');
  });

  it('does not retry a definitive provider rejection', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetchMock = jest.fn().mockResolvedValue(status(403));
    global.fetch = fetchMock as any;
    await expect(new NominatimGeocodingProvider(config({})).reverse(30, 31, 'ar')).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed search response', async () => {
    global.fetch = jest.fn().mockResolvedValue(ok({ not: 'an array' })) as any;
    await expect(new NominatimGeocodingProvider(config({})).search('x', 'ar')).rejects.toMatchObject({ status: 502 });
  });
});

describe('provider selection', () => {
  async function moduleWith(values: Record<string, string>) {
    return Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, load: [() => values] }), GeocodingModule],
    }).compile();
  }

  it('wires the Nominatim-compatible provider by default and warns when it is the public service', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await moduleWith({});
    expect(moduleRef.get(GEOCODING_PROVIDER)).toBeInstanceOf(NominatimGeocodingProvider);
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/public OpenStreetMap/);
    warn.mockRestore();
  });

  it('does not warn for a private endpoint and applies its tuned options', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await moduleWith({ GEOCODING_PROVIDER_BASE_URL: 'https://geo.internal.example.com', GEOCODING_CACHE_MAX_ENTRIES: '7' });
    expect(moduleRef.get(GEOCODING_PROVIDER)).toBeInstanceOf(NominatimGeocodingProvider);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('can be switched off without touching the API', async () => {
    const moduleRef = await moduleWith({ GEOCODING_PROVIDER: 'disabled' });
    expect(moduleRef.get(GEOCODING_PROVIDER)).toBeInstanceOf(DisabledGeocodingProvider);
    await expect(moduleRef.get(GeocodingService).search('cairo')).rejects.toMatchObject({ status: 503 });
  });
});

describe('geocoding access control', () => {
  const principal = (overrides: Record<string, unknown>) => ({
    userId: 'u1', systemRole: 'USER', accountType: 'USER', accountStatus: 'ACTIVE', brokerStatus: 'NOT_APPLIED', ...overrides,
  });

  it('is declared on the controller: authentication, then the geocoding capability', () => {
    expect(Reflect.getMetadata('__guards__', GeocodingController)).toEqual([JwtAuthGuard, CapabilityGuard]);
    expect(Reflect.getMetadata(CAPABILITIES_KEY, GeocodingController)).toEqual([Capability.GEOCODING_USE]);
  });

  it.each([
    ['an active user', {}, true],
    ['an active company', { accountType: 'COMPANY' }, true],
    ['an approved broker', { accountType: 'BROKER', brokerStatus: 'APPROVED' }, true],
    ['an active admin', { systemRole: 'ADMIN' }, true],
    ['an active super admin', { systemRole: 'SUPER_ADMIN' }, true],
    ['a broker who is not approved', { accountType: 'BROKER', brokerStatus: 'PENDING' }, false],
    ['a suspended user', { accountStatus: 'SUSPENDED' }, false],
    ['a suspended admin', { systemRole: 'ADMIN', accountStatus: 'SUSPENDED' }, false],
    ['a blocked user', { accountStatus: 'BLOCKED' }, false],
    ['a user pending deletion', { accountStatus: 'DELETION_PENDING' }, false],
    ['an anonymous caller', { userId: '' }, false],
  ])('%s', (_label, overrides, expected) => {
    expect(AuthorizationPolicyService.can(principal(overrides) as any, Capability.GEOCODING_USE)).toBe(expected);
  });

  describe('over HTTP', () => {
    let app: INestApplication;
    let jwt: JwtService;
    const backend = provider();

    class TestJwtStrategy extends PassportStrategy(Strategy, 'jwt') {
      constructor() {
        super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), secretOrKey: 'test-secret' });
      }
      validate(payload: Record<string, unknown>) {
        return payload;
      }
    }

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [PassportModule, JwtModule.register({ secret: 'test-secret' })],
        controllers: [GeocodingController],
        providers: [GeocodingService, TestJwtStrategy, { provide: GEOCODING_PROVIDER, useValue: backend }],
      }).compile();
      const nest = moduleRef.createNestApplication<NestExpressApplication>();
      configureApp(nest, { NODE_ENV: 'test' } as any);
      await nest.init();
      app = nest;
      jwt = moduleRef.get(JwtService);
    });
    afterAll(async () => app.close());

    const token = (overrides: Record<string, unknown> = {}) => jwt.sign(principal(overrides));
    const reverse = () => request(app.getHttpServer()).get('/api/v1/geocoding/reverse?latitude=30.05&longitude=31.24');

    it('turns away anonymous callers on both endpoints without reaching the provider', async () => {
      await reverse().expect(401);
      await request(app.getHttpServer()).get('/api/v1/geocoding/search?query=cairo').expect(401);
      await reverse().set('Authorization', 'Bearer not-a-token').expect(401);
      expect(backend.reverse).not.toHaveBeenCalled();
      expect(backend.search).not.toHaveBeenCalled();
    });

    it('serves an authenticated eligible caller', async () => {
      const res = await reverse().set('Authorization', `Bearer ${token()}`).expect(200);
      expect(res.body.data).toMatchObject({ displayName: 'x' });
      await request(app.getHttpServer()).get('/api/v1/geocoding/search?query=cairo').set('Authorization', `Bearer ${token({ systemRole: 'ADMIN' })}`).expect(200);
    });

    it('forbids an authenticated but ineligible caller', async () => {
      await reverse().set('Authorization', `Bearer ${token({ accountStatus: 'SUSPENDED' })}`).expect(403);
      await reverse().set('Authorization', `Bearer ${token({ accountType: 'BROKER', brokerStatus: 'PENDING' })}`).expect(403);
    });
  });
});
