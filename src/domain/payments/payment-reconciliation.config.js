'use strict';

const { isProtectedProcess } = require('../../config/deployment-environment');
/**
 * Reconciliation / expiry configuration (MAZAD-028).
 *
 * EXPIRY HAS NO PRODUCTION DEFAULT. Until a real payment provider is selected
 * nobody knows how long its checkout session lives, so staging/production
 * never expire an attempt unless `PAYMENT_ATTEMPT_TTL_SECONDS` says so
 * explicitly — and a protected deployment that turns the worker on must set it.
 * Local/development (the FakePaymentProvider) fall back to a documented
 * development value so the lifecycle can be exercised without configuration.
 */
const DEV_PAYMENT_ATTEMPT_TTL_SECONDS = 15 * 60;
const DEFAULT_RECONCILIATION_BACKOFF_SECONDS = [15, 30, 60, 120, 300];
const DEFAULT_RECONCILIATION_INTERVAL_SECONDS = 15;
const DEFAULT_RECONCILIATION_BATCH_SIZE = 50;
const MAX_RECONCILIATION_BATCH_SIZE = 200;
const DEFAULT_RECONCILIATION_LEASE_SECONDS = 60;
const MAX_TTL_SECONDS = 30 * 24 * 3600;
const text = (env, key) => String(env[key] ?? '').trim();
const positiveInteger = (value) =>
  /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Number(value)
    : undefined;
/** The attempt lifetime in ms, or null = attempts never expire (the protected default until one is configured). */
function paymentAttemptTtlMs(env) {
  const configured = positiveInteger(text(env, 'PAYMENT_ATTEMPT_TTL_SECONDS'));
  if (configured !== undefined) return configured * 1000;
  return isProtectedProcess(env) ? null : DEV_PAYMENT_ATTEMPT_TTL_SECONDS * 1000;
}
function reconciliationBackoffMs(env) {
  const parsed = text(env, 'PAYMENT_RECONCILIATION_BACKOFF_SECONDS')
    .split(',')
    .map((item) => positiveInteger(item.trim()));
  const valid = parsed.length > 0 && parsed.every((item) => item !== undefined);
  return (valid ? parsed : [...DEFAULT_RECONCILIATION_BACKOFF_SECONDS]).map(
    (seconds) => seconds * 1000,
  );
}
function reconciliationLeaseMs(env) {
  return (
    (positiveInteger(text(env, 'PAYMENT_RECONCILIATION_LEASE_SECONDS')) ??
      DEFAULT_RECONCILIATION_LEASE_SECONDS) * 1000
  );
}
/** Startup validation, wired into `validateEnvironment`. */
function paymentReconciliationErrors(env) {
  const errors = [];
  const integer = (key, min, max) => {
    const value = text(env, key);
    if (value && (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max))
      errors.push(`${key} must be an integer between ${min} and ${max}`);
  };
  const enabled = text(env, 'PAYMENT_RECONCILIATION_WORKER_ENABLED').toLowerCase();
  if (enabled && !['true', 'false'].includes(enabled))
    errors.push('PAYMENT_RECONCILIATION_WORKER_ENABLED must be true or false');
  integer('PAYMENT_RECONCILIATION_INTERVAL_SECONDS', 1, 3_600);
  integer('PAYMENT_RECONCILIATION_BATCH_SIZE', 1, MAX_RECONCILIATION_BATCH_SIZE);
  integer('PAYMENT_RECONCILIATION_LEASE_SECONDS', 5, 3_600);
  integer('PAYMENT_ATTEMPT_TTL_SECONDS', 1, MAX_TTL_SECONDS);
  integer('PAYMENT_STALE_ALERT_SECONDS', 60, MAX_TTL_SECONDS);
  const backoff = text(env, 'PAYMENT_RECONCILIATION_BACKOFF_SECONDS');
  if (backoff) {
    const steps = backoff.split(',').map((item) => item.trim());
    if (
      steps.length > 10 ||
      steps.some((step) => positiveInteger(step) === undefined || Number(step) > 86_400)
    ) {
      errors.push(
        'PAYMENT_RECONCILIATION_BACKOFF_SECONDS must be up to 10 comma-separated positive integers (seconds), each at most 86400',
      );
    }
  }
  // No guessed business duration: a protected deployment that turns reconciliation/expiry on must state the attempt lifetime.
  if (enabled === 'true' && isProtectedProcess(env) && !text(env, 'PAYMENT_ATTEMPT_TTL_SECONDS')) {
    errors.push(
      'PAYMENT_ATTEMPT_TTL_SECONDS is required in staging and production when PAYMENT_RECONCILIATION_WORKER_ENABLED=true (no default expiry exists until a payment provider is selected)',
    );
  }
  return errors;
}

Object.assign(exports, {
  DEV_PAYMENT_ATTEMPT_TTL_SECONDS,
  DEFAULT_RECONCILIATION_BACKOFF_SECONDS,
  DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
  DEFAULT_RECONCILIATION_BATCH_SIZE,
  MAX_RECONCILIATION_BATCH_SIZE,
  DEFAULT_RECONCILIATION_LEASE_SECONDS,
  paymentAttemptTtlMs,
  reconciliationBackoffMs,
  reconciliationLeaseMs,
  paymentReconciliationErrors,
});
