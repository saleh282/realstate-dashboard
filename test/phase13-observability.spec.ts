import { ConflictException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { OBSERVED_REJECTION_CODES, classifyRejection, emitOperationalEvent, operationalMetrics } from '../src/common/observability/operational-metrics';
import { OperationalStatusService } from '../src/operations/operational-status.service';
import { AdminOperationsController } from '../src/admin/admin-operations.controller';
import { CAPABILITIES_KEY } from '../src/authorization/capabilities.decorator';
import { Capability } from '../src/authorization/capability';
import { PropertyErrorCode } from '../src/common/errors/property-error-codes';
import { PaymentErrorCode } from '../src/common/errors/payment-error-codes';
import { FormDefinitionErrorCode } from '../src/property-form-definitions/property-form-definition.constants';

function host(request: any = { method: 'POST', originalUrl: '/api/v1/properties?token=secret', headers: {}, requestId: 'req-9' }) {
  const response = { headersSent: false, setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { host: { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) } as any, response };
}

describe('Phase 13 domain-rejection observability', () => {
  const logger = { error: jest.fn(), warn: jest.fn() };
  const filter = new HttpExceptionFilter(logger);
  beforeEach(() => { jest.clearAllMocks(); operationalMetrics.reset(); });

  it.each([
    [PropertyErrorCode.FORM_VERSION_OUTDATED, 409],
    [PropertyErrorCode.AMENITY_NOT_ALLOWED, 400],
    [PropertyErrorCode.AMENITIES_NOT_ENABLED, 400],
    [PropertyErrorCode.ATTRIBUTES_INVALID, 400],
    [FormDefinitionErrorCode.PUBLISH_INVALID, 400],
    [FormDefinitionErrorCode.VERSION_CONFLICT, 409],
    [PaymentErrorCode.PROVIDER_UNAVAILABLE, 503],
    [PaymentErrorCode.RECONCILIATION_REQUIRED, 409],
  ])('counts and logs %s as a structured domain_rejection without changing the response', (code, status) => {
    const { host: h, response } = host();
    filter.catch(new HttpException({ message: 'x', code }, status), h);
    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json.mock.calls[0][0]).toMatchObject({ success: false, code, requestId: 'req-9' });
    const line = JSON.parse(logger.warn.mock.calls.find(([text]) => String(text).includes('domain_rejection'))![0]);
    expect(line).toEqual({ event: 'domain_rejection', code, status, requestId: 'req-9', method: 'POST', path: '/api/v1/properties' });
    expect(JSON.stringify(line)).not.toContain('secret');
    expect(operationalMetrics.snapshot()[`domain_rejection{${code}}`]).toBe(1);
  });

  it('counts rate limiting, without recording the caller', () => {
    const { host: h } = host();
    filter.catch(new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS), h);
    const line = JSON.parse(logger.warn.mock.calls[0][0]);
    expect(line).toMatchObject({ event: 'rate_limited', status: 429, requestId: 'req-9' });
    expect(Object.keys(line)).not.toContain('ip');
    expect(operationalMetrics.snapshot()['rate_limited{http}']).toBe(1);
  });

  it('does not observe ordinary rejections (no noise from unrelated codes or plain 4xx)', () => {
    const { host: h } = host();
    filter.catch(new ConflictException({ message: 'x', code: 'SOMETHING_ELSE' }), h);
    filter.catch(new HttpException('bad', 400), h);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(operationalMetrics.snapshot()).toEqual({});
  });

  it('classification is explicit: only the listed stable codes and 429', () => {
    expect(classifyRejection(409, 'PROPERTY_FORM_VERSION_OUTDATED')).toEqual({ event: 'domain_rejection', label: 'PROPERTY_FORM_VERSION_OUTDATED' });
    expect(classifyRejection(429, undefined)).toEqual({ event: 'rate_limited', label: 'http' });
    expect(classifyRejection(400, 'BID_TOO_LOW')).toBeUndefined();
    expect(classifyRejection(500, undefined)).toBeUndefined();
    expect(OBSERVED_REJECTION_CODES.size).toBeGreaterThan(10);
  });

  it('emitOperationalEvent logs one JSON line and counts the event', () => {
    const sink = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
    emitOperationalEvent(sink, 'log', 'form_definition_published', { definitionId: 'd1', version: 3 });
    expect(JSON.parse((sink.log as jest.Mock).mock.calls[0][0])).toEqual({ event: 'form_definition_published', definitionId: 'd1', version: 3 });
    expect(operationalMetrics.snapshot()['events{form_definition_published}']).toBe(1);
  });
});

describe('Phase 13 operational status', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const provider = { providerKey: 'unconfigured', configured: false } as any;
  const config = (values: Record<string, unknown> = {}) => ({ get: (key: string) => ({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production', ...values })[key] }) as any;
  const connection = (data: { ledger?: any[]; lock?: any; cleanup?: any[]; failing?: boolean; held?: number; payments?: Record<string, any[]> }) => ({
    db: {
      collection: (name: string) => {
        if (data.failing) throw new Error('down');
        if (name === 'migration_ledger') return { find: () => ({ toArray: async () => data.ledger ?? [] }) };
        if (name === 'migration_locks') return { findOne: async () => data.lock ?? null };
        if (name === 'auctions') return { countDocuments: async () => data.held ?? 0 };
        if (name === 'auction_entry_payments' || name === 'managed_marketing_payments') {
          return { countDocuments: async (filter: Record<string, any>) => (data.payments?.[name] ?? []).filter((row) => Object.entries(filter).every(([key, expected]) => {
            if (expected && typeof expected === 'object' && '$exists' in expected) return (row[key] !== undefined) === expected.$exists;
            if (expected && typeof expected === 'object' && '$lte' in expected) return row[key] !== undefined && row[key].getTime() <= expected.$lte.getTime();
            return row[key] === expected;
          })).length };
        }
        return {
          countDocuments: async () => (data.cleanup ?? []).length,
          find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => (data.cleanup ?? []).slice(0, 1) }) }) }),
        };
      },
    },
  }) as any;
  beforeEach(() => operationalMetrics.reset());

  it('is quiet on a healthy system and reports the payment provider in use', async () => {
    const status = await new OperationalStatusService(connection({ ledger: [{ migrationId: 'a', status: 'complete' }] }), config(), provider).status(now);
    expect(status).toMatchObject({ deploymentEnv: 'production', database: 'up', payment: { provider: 'unconfigured', configured: false }, migrations: { failed: [], running: [], lockHeld: false, complete: 1 }, attention: [] });
  });

  it('flags a failed migration, an interrupted one (running without a held lock) and a stalled cleanup queue', async () => {
    const service = new OperationalStatusService(connection({
      ledger: [{ migrationId: '022', status: 'failed' }, { migrationId: '023', status: 'running' }],
      cleanup: [{ createdAt: new Date(now.getTime() - 2 * 3600_000) }],
    }), config({ CLEANUP_ALERT_AGE_SECONDS: '600' }), provider);
    const status = await service.status(now);
    expect(status.attention).toEqual(['migrations_failed', 'migrations_interrupted', 'evidence_cleanup_stalled']);
    expect(status.migrations).toMatchObject({ failed: ['022'], running: ['023'] });
    expect(status.evidenceCleanup).toEqual({ pending: 1, oldestPendingAgeSeconds: 7200 });
  });

  it('a running migration WITH a live lock is normal progress, not an alert', async () => {
    const status = await new OperationalStatusService(connection({ ledger: [{ migrationId: '022', status: 'running' }], lock: { _id: 'global' } }), config(), provider).status(now);
    expect(status.attention).toEqual([]);
  });

  it('reports a database failure instead of throwing', async () => {
    const status = await new OperationalStatusService(connection({ failing: true }), config(), provider).status(now);
    expect(status).toMatchObject({ database: 'down', attention: ['database'] });
  });

  it('is served only to staff with the dashboard capability', () => {
    expect(Reflect.getMetadata(CAPABILITIES_KEY, AdminOperationsController)).toEqual([Capability.ADMIN_DASHBOARD_READ]);
  });
});
