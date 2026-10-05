'use strict';

/**
 * Minimal in-process operational counters (Phase 13). No vendor, no exporter:
 * counters live for the lifetime of the process and are read through the
 * Admin operations status endpoint; the same facts are also emitted as
 * structured JSON log lines so any log pipeline can alert on them.
 */
class OperationalMetrics {
  constructor() {
    this.counters = new Map();
    this.startedAt = Date.now();
  }
  increment(name, label, by = 1) {
    const key = label ? `${name}{${label}}` : name;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }
  snapshot() {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  /** Test seam only. */
  reset() {
    this.counters.clear();
  }
}
const operationalMetrics = new OperationalMetrics();
/**
 * Stable, expected-failure codes worth counting and logging as
 * `domain_rejection` because they signal a client/operator problem.
 * Deliberately explicit: ordinary validation noise is not listed. No domain
 * registers one today.
 */
const OBSERVED_REJECTION_CODES = new Set();
/** Classifies an HTTP failure; `undefined` means it is not an observed one. */
function classifyRejection(status, code) {
  if (status === 429) return { event: 'rate_limited', label: 'http' };
  if (typeof code === 'string' && OBSERVED_REJECTION_CODES.has(code))
    return { event: 'domain_rejection', label: code };
  return undefined;
}
/** Emits one structured event line (no payloads, no PII) and counts it. */
function emitOperationalEvent(logger, level, event, fields = {}) {
  operationalMetrics.increment('events', event);
  logger[level](JSON.stringify({ event, ...fields }));
}

Object.assign(exports, {
  operationalMetrics,
  OBSERVED_REJECTION_CODES,
  classifyRejection,
  emitOperationalEvent,
});
