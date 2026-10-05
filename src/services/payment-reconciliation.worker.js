'use strict';

const { Logger } = require('../common/logging/logger');
const { isProtectedProcess } = require('../config/deployment-environment');
const {
  DEFAULT_RECONCILIATION_BATCH_SIZE,
  DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
  MAX_RECONCILIATION_BATCH_SIZE,
  paymentAttemptTtlMs,
} = require('../domain/payments/payment-reconciliation.config');
const MIN_INTERVAL_SECONDS = 1;
const STOP_WAIT_MS = 10_000;
/**
 * Periodically reconciles INITIATED payment attempts of both purposes with the
 * provider and expires stale ones (MAZAD-028). Same shape and conventions as
 * a bounded background worker: one timer chain, an in-process re-entrancy guard
 * (never two local passes at once), a staggered start — but correctness NEVER
 * depends on the guard: each attempt is claimed with an atomic database lease
 * (`PaymentReconciliationService`), so overlapping instances are safe.
 *
 * It does nothing at all (no database access) while no payment provider is
 * bound, which is the production state today. In a protected deployment it
 * also refuses to run without an explicit attempt lifetime: there is no
 * guessed production expiry.
 */
class PaymentReconciliationWorker {
  constructor(reconciliation, config, provider) {
    this.reconciliation = reconciliation;
    this.config = config;
    this.provider = provider;
    this.logger = new Logger(PaymentReconciliationWorker.name);
    this.stopped = false;
    this.warnedUnconfigured = false;
  }
  get enabled() {
    const raw = this.config.get('PAYMENT_RECONCILIATION_WORKER_ENABLED')?.trim().toLowerCase();
    if (raw) return raw === 'true';
    return this.config.get('NODE_ENV') !== 'test';
  }
  get intervalMs() {
    return (
      Math.max(
        this.integer(
          'PAYMENT_RECONCILIATION_INTERVAL_SECONDS',
          DEFAULT_RECONCILIATION_INTERVAL_SECONDS,
        ),
        MIN_INTERVAL_SECONDS,
      ) * 1000
    );
  }
  /** False in a protected deployment that has a provider bound but no explicit attempt lifetime: the worker then stays idle. */
  get expiryConfigured() {
    const env = {
      NODE_ENV: this.config.get('NODE_ENV'),
      DEPLOYMENT_ENV: this.config.get('DEPLOYMENT_ENV'),
      PAYMENT_ATTEMPT_TTL_SECONDS: this.config.get('PAYMENT_ATTEMPT_TTL_SECONDS'),
    };
    return !isProtectedProcess(env) || paymentAttemptTtlMs(env) !== null;
  }
  onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log(
        'Payment reconciliation worker disabled (PAYMENT_RECONCILIATION_WORKER_ENABLED=false)',
      );
      return;
    }
    // Stagger the first run so several instances do not start in lockstep.
    this.schedule(Math.min(this.intervalMs, 3_000 + Math.floor(Math.random() * 3_000)));
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (!this.inFlight) return;
    await Promise.race([
      this.inFlight.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref()),
    ]);
  }
  /** Runs one reconciliation pass. Returns null when a pass is already running, or when there is nothing this process may do. */
  async runOnce() {
    if (this.inFlight) return null;
    const run = this.execute();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = undefined;
    }
  }
  schedule(delayMs) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.schedule(this.intervalMs));
    }, delayMs);
    this.timer.unref();
  }
  async execute() {
    if (!this.provider.configured) return null; // no gateway bound: nothing can be verified, and nothing is touched
    if (!this.expiryConfigured) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.logger.error(
          JSON.stringify({
            event: 'payment_reconciliation_refused',
            reason: 'PAYMENT_ATTEMPT_TTL_SECONDS is not configured in a protected deployment',
          }),
        );
      }
      return null;
    }
    try {
      const batch = Math.min(
        this.integer('PAYMENT_RECONCILIATION_BATCH_SIZE', DEFAULT_RECONCILIATION_BATCH_SIZE),
        MAX_RECONCILIATION_BATCH_SIZE,
      );
      const summary = await this.reconciliation.reconcileDue(batch);
      this.lastRunAt = new Date();
      this.lastSummary = summary;
      // Quiet on a no-op tick — only log when something was worked.
      if (summary.claimed > 0)
        this.logger.log(JSON.stringify({ event: 'payment_reconciliation_run', ...summary }));
      return summary;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'payment_reconciliation_run_failed',
          errorName: error instanceof Error ? error.name : typeof error,
        }),
      );
      return null;
    }
  }
  integer(key, fallback) {
    const raw = this.config.get(key)?.trim();
    const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}

Object.assign(exports, { PaymentReconciliationWorker });
