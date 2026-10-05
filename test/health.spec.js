'use strict';
const { configureHttpServer } = require('../src/app');
const { httpApp } = require('./support/http-app');
const { ConfigService } = require('../src/config/config');
const request = require('supertest');

const { HealthController } = require('../src/controllers/health.controller');
const { HealthService } = require('../src/services/health.service');
function connection(overrides = {}) {
  return {
    readyState: 1,
    db: { admin: () => ({ ping: jest.fn().mockResolvedValue({ ok: 1 }) }) },
    ...overrides,
  };
}
const config = (values = {}) => ({ get: (key) => values[key] });
describe('HealthService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it('is ready only while the database answers a ping', async () => {
    await expect(new HealthService(connection(), config()).readiness()).resolves.toEqual({
      ready: true,
      checks: { mongo: 'up' },
    });
    await expect(
      new HealthService(connection({ readyState: 0 }), config()).readiness(),
    ).resolves.toEqual({ ready: false, checks: { mongo: 'down' } });
    const failing = connection({
      db: { admin: () => ({ ping: jest.fn().mockRejectedValue(new Error('down')) }) },
    });
    await expect(new HealthService(failing, config()).readiness()).resolves.toMatchObject({
      ready: false,
    });
  });
  it('treats a hung database ping as not ready instead of hanging the probe', async () => {
    jest.useFakeTimers();
    const hung = connection({
      db: { admin: () => ({ ping: () => new Promise(() => undefined) }) },
    });
    const pending = new HealthService(hung, config()).readiness();
    await jest.advanceTimersByTimeAsync(2_500);
    await expect(pending).resolves.toEqual({ ready: false, checks: { mongo: 'down' } });
  });
  it('reports liveness without touching any dependency', () => {
    const db = connection();
    expect(new HealthService(db, config()).liveness()).toMatchObject({ status: 'ok' });
  });
  it('stops being ready as soon as shutdown begins and drains before closing', async () => {
    jest.useFakeTimers();
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    const service = new HealthService(
      connection(),
      config({ SHUTDOWN_DRAIN_MS: '3000', SHUTDOWN_TIMEOUT_MS: '20000' }),
    );
    let closed = false;
    const shutdown = service.beforeApplicationShutdown('SIGTERM').then(() => {
      closed = true;
    });
    await expect(service.readiness()).resolves.toEqual({
      ready: false,
      checks: { shutdown: 'draining' },
    });
    await jest.advanceTimersByTimeAsync(2_999);
    expect(closed).toBe(false);
    await jest.advanceTimersByTimeAsync(2);
    await shutdown;
    expect(closed).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });
  it('forces the process down if graceful shutdown hangs past the deadline', async () => {
    jest.useFakeTimers();
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    const service = new HealthService(
      connection(),
      config({ SHUTDOWN_DRAIN_MS: '0', SHUTDOWN_TIMEOUT_MS: '5000' }),
    );
    await service.beforeApplicationShutdown('SIGTERM');
    await jest.advanceTimersByTimeAsync(5_001);
    expect(exit).toHaveBeenCalledWith(1);
  });
  it('defaults to a short drain in production and none elsewhere', async () => {
    jest.useFakeTimers();
    jest.spyOn(process, 'exit').mockImplementation(() => undefined);
    const production = new HealthService(connection(), config({ NODE_ENV: 'production' }));
    let done = false;
    void production.beforeApplicationShutdown().then(() => {
      done = true;
    });
    await jest.advanceTimersByTimeAsync(4_000);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1_500);
    expect(done).toBe(true);
    const development = new HealthService(connection(), config({ NODE_ENV: 'development' }));
    let devDone = false;
    void development.beforeApplicationShutdown().then(() => {
      devDone = true;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(devDone).toBe(true);
  });
});
describe('health endpoints over HTTP', () => {
  let app;
  let db;
  let health;
  beforeAll(async () => {
    db = connection();
    const moduleRef = await (() => {
      const services = {};
      services.ConfigService = config({ SHUTDOWN_DRAIN_MS: '0' });
      services.HealthService = new HealthService(db, services.ConfigService);
      return {
        services,
        app: httpApp(
          services,
          (app, services) => {
            app.use('/health', require('../src/routes/health.routes').createRouter(services));
          },
          undefined,
        ),
      };
    })();
    const nest = moduleRef.app;

    await nest.init();
    app = nest;
    health = moduleRef.services.HealthService;
  });
  afterAll(async () => {
    jest.spyOn(health, 'beforeApplicationShutdown').mockResolvedValue(undefined);
    await app.close();
  });
  it('serves liveness and readiness outside the API prefix and never rate-limits probes', async () => {
    for (let index = 0; index < 6; index++) {
      await request(app.getHttpServer()).get('/health/live').expect(200);
      await request(app.getHttpServer()).get('/health/ready').expect(200);
    }
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body.data).toEqual({ status: 'ready', checks: { mongo: 'up' } });
    await request(app.getHttpServer()).get('/api/v1/health/live').expect(404);
  });
  it('answers 503 without leaking details once a dependency is down or shutdown starts', async () => {
    db.readyState = 0;
    const errorLog = jest.spyOn(require('../src/common/logging/logger').Logger.prototype, 'error');
    const down = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
    expect(down.body).toMatchObject({
      success: false,
      code: 'NOT_READY',
      details: { mongo: 'down' },
    });
    expect(JSON.stringify(down.body)).not.toMatch(/mongodb|stack|host/i);
    await request(app.getHttpServer()).get('/health/live').expect(200);
    db.readyState = 1;
    jest.useFakeTimers();
    await health.beforeApplicationShutdown('SIGTERM');
    jest.clearAllTimers();
    jest.useRealTimers();
    const draining = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(draining.body.details).toEqual({ shutdown: 'draining' });
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
});
describe('configureHttpServer', () => {
  it('keeps connections open longer than common load-balancer idle timeouts', () => {
    const server = { keepAliveTimeout: 5_000, headersTimeout: 60_000 };
    configureHttpServer(server);
    expect(server.keepAliveTimeout).toBeGreaterThan(60_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });
});
