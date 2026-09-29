import type { Logger } from '@nestjs/common';

/**
 * Minimal in-process operational counters (Phase 13). No vendor, no exporter:
 * counters live for the lifetime of the process and are read through the
 * Admin operations status endpoint; the same facts are also emitted as
 * structured JSON log lines so any log pipeline can alert on them.
 */
class OperationalMetrics {
  private readonly counters = new Map<string, number>();
  readonly startedAt = Date.now();

  increment(name: string, label?: string, by = 1): void {
    const key = label ? `${name}{${label}}` : name;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  /** Test seam only. */
  reset(): void { this.counters.clear(); }
}

export const operationalMetrics = new OperationalMetrics();

/**
 * Stable, expected-failure codes worth counting and logging as `domain_rejection`
 * because they signal a client/operator problem (stale forms, rejected
 * specifications or amenities, form lifecycle conflicts, payment trouble).
 * Deliberately explicit: ordinary validation noise and bid rejections are not here.
 */
export const OBSERVED_REJECTION_CODES: ReadonlySet<string> = new Set([
  'PROPERTY_FORM_VERSION_OUTDATED',
  'PROPERTY_ATTRIBUTES_INVALID',
  'PROPERTY_AMENITY_NOT_ALLOWED',
  'PROPERTY_AMENITIES_NOT_ENABLED',
  'PROPERTY_FORM_DEFINITION_INVALID',
  'PROPERTY_FORM_DEFINITION_NOT_PUBLISHED',
  'PROPERTY_FORM_DEFINITION_ARCHIVED',
  'FORM_DEFINITION_VERSION_CONFLICT',
  'FORM_DEFINITION_PUBLISH_INVALID',
  'FORM_DEFINITION_DRAFT_INVALID',
  'FORM_DEFINITION_CURRENT_VERSION_INVALID',
  'PAYMENT_PROVIDER_UNAVAILABLE',
  'PAYMENT_RECONCILIATION_REQUIRED',
  'PAYMENT_STATE_INCONSISTENT',
  'PAYMENT_RETRY_EXHAUSTED',
]);

export type RejectionObservation = { event: 'domain_rejection' | 'rate_limited'; label: string };

/** Classifies an HTTP failure; `undefined` means it is not an observed one. */
export function classifyRejection(status: number, code: unknown): RejectionObservation | undefined {
  if (status === 429) return { event: 'rate_limited', label: 'http' };
  if (typeof code === 'string' && OBSERVED_REJECTION_CODES.has(code)) return { event: 'domain_rejection', label: code };
  return undefined;
}

/** Emits one structured event line (no payloads, no PII) and counts it. */
export function emitOperationalEvent(logger: Pick<Logger, 'log' | 'warn' | 'error'>, level: 'log' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  operationalMetrics.increment('events', event);
  logger[level](JSON.stringify({ event, ...fields }));
}
