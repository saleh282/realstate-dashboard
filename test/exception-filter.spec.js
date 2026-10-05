'use strict';
const { httpApp } = require('./support/http-app');
const { asyncHandler, sendResponse } = require('../src/views/response');
const { rateLimit } = require('../src/middleware/rate-limit');
const { BoundedFileFields, BoundedFile } = require('../src/middleware/upload');
const { BadRequestException, ServiceUnavailableException } = require('../src/common/http/errors');
const request = require('supertest');

const { HttpExceptionFilter } = require('../src/middleware/error-handler');
const { redactSensitive } = require('../src/common/logging/redact');
const {
  currentRequestId,
  resolveRequestId,
} = require('../src/common/request-context/request-context');
function fakeHost(overrides = {}) {
  const response = {
    headersSent: false,
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    ...overrides.response,
  };
  const req = overrides.request ?? {
    method: 'POST',
    originalUrl: '/api/v1/things?token=abc',
    headers: {},
  };
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => req }) };
  return { host, response };
}
describe('HttpExceptionFilter', () => {
  const logger = { error: jest.fn(), warn: jest.fn() };
  const filter = new HttpExceptionFilter(logger);
  beforeEach(() => jest.clearAllMocks());
  it('logs unexpected exceptions with request context but hides the details from the client', () => {
    const { host, response } = fakeHost({
      request: {
        method: 'POST',
        originalUrl: '/api/v1/things?token=abc',
        headers: {},
        requestId: 'req-1234',
      },
    });
    const boom = new Error('connect failed mongodb+srv://admin:hunter2@cluster0.example.net/db');
    filter.handle(boom, host.switchToHttp().getRequest?.(), host.switchToHttp().getResponse());
    expect(response.status).toHaveBeenCalledWith(500);
    const body = response.json.mock.calls[0][0];
    expect(body).toEqual({
      success: false,
      message: 'حدث خطأ غير متوقع، حاول مرة أخرى',
      requestId: 'req-1234',
    });
    expect(JSON.stringify(body)).not.toMatch(/mongodb|hunter2|stack/i);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [line, stack] = logger.error.mock.calls[0];
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({
      event: 'unhandled_exception',
      requestId: 'req-1234',
      method: 'POST',
      path: '/api/v1/things',
      status: 500,
      errorName: 'Error',
    });
    expect(line).not.toContain('token=abc');
    expect(line).not.toContain('hunter2');
    expect(String(stack)).not.toContain('hunter2');
  });
  it('logs 5xx HttpExceptions but keeps their safe client message and metadata', () => {
    const { host, response } = fakeHost();
    filter.handle(
      new ServiceUnavailableException({
        message: 'temporarily down',
        code: 'SOME_CODE',
        internal: 'secret',
      }),
      host.switchToHttp().getRequest?.(),
      host.switchToHttp().getResponse(),
    );
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json.mock.calls[0][0]).toMatchObject({
      success: false,
      message: 'temporarily down',
      code: 'SOME_CODE',
    });
    expect(response.json.mock.calls[0][0]).not.toHaveProperty('internal');
    expect(JSON.parse(logger.error.mock.calls[0][0])).toMatchObject({
      event: 'http_5xx',
      status: 503,
    });
  });
  it('stays quiet for an expected 5xx marked quiet, without exposing the marker', () => {
    const { host, response } = fakeHost();
    filter.handle(
      new ServiceUnavailableException({ message: 'not ready', code: 'NOT_READY', quiet: true }),
      host.switchToHttp().getRequest?.(),
      host.switchToHttp().getResponse(),
    );
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json.mock.calls[0][0]).not.toHaveProperty('quiet');
    expect(logger.error).not.toHaveBeenCalled();
  });
  it('does not log expected client errors', () => {
    const { host, response } = fakeHost();
    filter.handle(
      new BadRequestException({ message: ['a is required', 'b is invalid'], code: 'X' }),
      host.switchToHttp().getRequest?.(),
      host.switchToHttp().getResponse(),
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0]).toMatchObject({
      message: 'a is required',
      errors: ['a is required', 'b is invalid'],
      code: 'X',
    });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it('treats an unrecognised error carrying a 5xx-style status as a server fault', () => {
    const { host, response } = fakeHost();
    filter.handle(
      Object.assign(new Error('upstream exploded'), { status: 502, expose: false }),
      host.switchToHttp().getRequest?.(),
      host.switchToHttp().getResponse(),
    );
    expect(response.status).toHaveBeenCalledWith(500);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
  it('logs multer parser rejections as warnings and keeps their contract', () => {
    const { host, response } = fakeHost();
    filter.handle(
      Object.assign(new Error('File too large'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' }),
      host.switchToHttp().getRequest?.(),
      host.switchToHttp().getResponse(),
    );
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json.mock.calls[0][0]).toMatchObject({ code: 'EVIDENCE_FILE_TOO_LARGE' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
  it('reports errors caused by a caller who hung up as warnings, not server faults', () => {
    const { host } = fakeHost({
      request: { method: 'POST', originalUrl: '/api/v1/properties', headers: {}, aborted: true },
    });
    filter.handle(
      new Error('Request aborted'),
      host.switchToHttp().getRequest?.(),
      host.switchToHttp().getResponse(),
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(JSON.parse(logger.warn.mock.calls[0][0])).toMatchObject({
      event: 'client_disconnected',
      status: 500,
    });
    const gone = fakeHost({
      request: { method: 'POST', originalUrl: '/x', headers: {}, socket: { destroyed: true } },
    });
    filter.handle(
      new Error('anything'),
      gone.host.switchToHttp().getRequest?.(),
      gone.host.switchToHttp().getResponse(),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
  it('does not write twice when the response has already started', () => {
    const { host, response } = fakeHost({ response: { headersSent: true } });
    filter.handle(
      new Error('late failure'),
      host.switchToHttp().getRequest?.(),
      host.switchToHttp().getResponse(),
    );
    expect(response.json).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
  it('never lets a client-controlled id through unless it is well formed', () => {
    const good = fakeHost({
      request: { method: 'GET', originalUrl: '/x', headers: { 'x-request-id': 'client-abc_123' } },
    });
    filter.handle(
      new BadRequestException('x'),
      good.host.switchToHttp().getRequest?.(),
      good.host.switchToHttp().getResponse(),
    );
    expect(good.response.json.mock.calls[0][0].requestId).toBe('client-abc_123');
    for (const bad of ['has space', 'a'.repeat(101), 'line\nbreak', '<script>', '']) {
      const attempt = fakeHost({
        request: { method: 'GET', originalUrl: '/x', headers: { 'x-request-id': bad } },
      });
      filter.handle(
        new BadRequestException('x'),
        attempt.host.switchToHttp().getRequest?.(),
        attempt.host.switchToHttp().getResponse(),
      );
      expect(attempt.response.json.mock.calls[0][0].requestId).not.toBe(bad);
      expect(attempt.response.json.mock.calls[0][0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
describe('redactSensitive', () => {
  it.each([
    ['mongodb://user:pw@host/db', 'pw'],
    ['mongodb+srv://user:pw@host/db', 'pw'],
    ['Authorization: Bearer abc.def.ghi', 'abc.def.ghi'],
    ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'eyJzdWIi'],
    ['GET /x?api_key=SECRETVALUE&a=1', 'SECRETVALUE'],
    ['password=hunter2 next', 'hunter2'],
    ['{"secret":"topsecret"}', 'topsecret'],
  ])('scrubs credentials from %j', (input, leaked) => {
    expect(redactSensitive(input)).not.toContain(leaked);
  });
  it('truncates long text', () => {
    expect(redactSensitive('x'.repeat(5000), 100).length).toBeLessThan(130);
  });
});
class ProbeController {
  ok(req) {
    return { seen: currentRequestId(), onRequest: req.requestId };
  }
  boom() {
    throw new Error('mongodb://svc:topsecret@db.internal/prod exploded');
  }
  json() {
    return { ok: true };
  }
}
describe('request id and error handling through the real application setup', () => {
  let app;
  const logger = jest
    .spyOn(require('../src/common/logging/logger').Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  beforeAll(async () => {
    const moduleRef = {
      app: httpApp({}, (app) => {
        const controller = new ProbeController();
        app.get(
          '/api/v1/probe/ok',
          asyncHandler(async (req, res) => sendResponse.bind(null, res)(await controller.ok(req))),
        );
        app.get(
          '/api/v1/probe/boom',
          asyncHandler(async (req, res) => sendResponse.bind(null, res)(await controller.boom())),
        );
        app.post(
          '/api/v1/probe/json',
          asyncHandler(async (req, res) => sendResponse.bind(null, res)(await controller.json())),
        );
      }),
    };
    const nest = moduleRef.app;

    await nest.init();
    app = nest;
  });
  afterAll(async () => {
    await app.close();
    logger.mockRestore();
  });
  beforeEach(() => logger.mockClear());
  it('assigns one id, exposes it on the response, and makes it available to services', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/probe/ok').expect(200);
    const header = res.headers['x-request-id'];
    expect(header).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.data).toEqual({ seen: header, onRequest: header });
  });
  it('honours a well-formed client id end to end', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/ok')
      .set('X-Request-Id', 'trace-42')
      .expect(200);
    expect(res.headers['x-request-id']).toBe('trace-42');
    expect(res.body.data.seen).toBe('trace-42');
  });
  it('returns the same id in an unexpected-error body, header and server log without leaking internals', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/probe/boom')
      .set('X-Request-Id', 'trace-500')
      .expect(500);
    expect(res.headers['x-request-id']).toBe('trace-500');
    expect(res.body).toEqual({
      success: false,
      message: 'حدث خطأ غير متوقع، حاول مرة أخرى',
      requestId: 'trace-500',
    });
    expect(JSON.stringify(res.body)).not.toContain('topsecret');
    const logged = logger.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('trace-500');
    expect(logged).not.toContain('topsecret');
  });
  it('answers malformed JSON with a client error, not a server fault', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/probe/json')
      .set('Content-Type', 'application/json')
      .send('{"broken":')
      .expect(400);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.requestId).toBeTruthy();
    expect(logger).not.toHaveBeenCalled();
  });
  it('resolves ids deterministically', () => {
    expect(resolveRequestId('abc')).toBe('abc');
    expect(resolveRequestId(['first', 'second'])).toBe('first');
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
