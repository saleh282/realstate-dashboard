'use strict';

const { ConflictException, HttpException, HttpStatus } = require('../src/common/http/errors');
const { HttpExceptionFilter } = require('../src/middleware/error-handler');
const {
  OBSERVED_REJECTION_CODES,
  classifyRejection,
  emitOperationalEvent,
  operationalMetrics,
} = require('../src/common/observability/operational-metrics');
function host(
  request = {
    method: 'POST',
    originalUrl: '/api/v1/users/me?token=secret',
    headers: {},
    requestId: 'req-9',
  },
) {
  const response = {
    headersSent: false,
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  return {
    host: { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) },
    response,
  };
}
describe('Phase 13 domain-rejection observability', () => {
  const logger = { error: jest.fn(), warn: jest.fn() };
  const filter = new HttpExceptionFilter(logger);
  beforeEach(() => {
    jest.clearAllMocks();
    operationalMetrics.reset();
  });
  it('counts and logs an observed code as a structured domain_rejection without changing the response', () => {
    const code = 'TEST_OBSERVED_CODE';
    OBSERVED_REJECTION_CODES.add(code);
    try {
      const { host: h, response } = host();
      filter.handle(
        new HttpException({ message: 'x', code }, 409),
        h.switchToHttp().getRequest?.(),
        h.switchToHttp().getResponse(),
      );
      expect(response.status).toHaveBeenCalledWith(409);
      expect(response.json.mock.calls[0][0]).toMatchObject({
        success: false,
        code,
        requestId: 'req-9',
      });
      const line = JSON.parse(
        logger.warn.mock.calls.find(([text]) => String(text).includes('domain_rejection'))[0],
      );
      expect(line).toEqual({
        event: 'domain_rejection',
        code,
        status: 409,
        requestId: 'req-9',
        method: 'POST',
        path: '/api/v1/users/me',
      });
      expect(JSON.stringify(line)).not.toContain('secret');
      expect(operationalMetrics.snapshot()[`domain_rejection{${code}}`]).toBe(1);
    } finally {
      OBSERVED_REJECTION_CODES.delete(code);
    }
  });
  it('counts rate limiting, without recording the caller', () => {
    const { host: h } = host();
    filter.handle(
      new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS),
      h.switchToHttp().getRequest?.(),
      h.switchToHttp().getResponse(),
    );
    const line = JSON.parse(logger.warn.mock.calls[0][0]);
    expect(line).toMatchObject({ event: 'rate_limited', status: 429, requestId: 'req-9' });
    expect(Object.keys(line)).not.toContain('ip');
    expect(operationalMetrics.snapshot()['rate_limited{http}']).toBe(1);
  });
  it('does not observe ordinary rejections (no noise from unrelated codes or plain 4xx)', () => {
    const { host: h } = host();
    filter.handle(
      new ConflictException({ message: 'x', code: 'SOMETHING_ELSE' }),
      h.switchToHttp().getRequest?.(),
      h.switchToHttp().getResponse(),
    );
    filter.handle(
      new HttpException('bad', 400),
      h.switchToHttp().getRequest?.(),
      h.switchToHttp().getResponse(),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(operationalMetrics.snapshot()).toEqual({});
  });
  it('classification is explicit: only the listed stable codes and 429', () => {
    expect(classifyRejection(429, undefined)).toEqual({ event: 'rate_limited', label: 'http' });
    expect(classifyRejection(400, 'BID_TOO_LOW')).toBeUndefined();
    expect(classifyRejection(500, undefined)).toBeUndefined();
  });
  it('emitOperationalEvent logs one JSON line and counts the event', () => {
    const sink = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    emitOperationalEvent(sink, 'log', 'form_definition_published', {
      definitionId: 'd1',
      version: 3,
    });
    expect(JSON.parse(sink.log.mock.calls[0][0])).toEqual({
      event: 'form_definition_published',
      definitionId: 'd1',
      version: 3,
    });
    expect(operationalMetrics.snapshot()['events{form_definition_published}']).toBe(1);
  });
});
