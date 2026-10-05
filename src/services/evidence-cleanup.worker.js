'use strict';

const { Logger } = require('../common/logging/logger');
const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 30;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_ALERT_AGE_SECONDS = 3600;
const STUCK_ATTEMPTS = 5;
const STOP_WAIT_MS = 10_000;
/**
 * Periodically retries queued private-asset deletions. Runs never overlap in
 * this process (one timer chain plus a re-entrancy guard); across instances the
 * per-task lease in reconcilePendingCleanup keeps them from colliding.
 */
class EvidenceCleanupWorker {
  constructor(assets, config) {
    this.assets = assets;
    this.config = config;
    this.logger = new Logger(EvidenceCleanupWorker.name);
    this.stopped = false;
    this.consecutiveFailures = 0;
  }
  get enabled() {
    const raw = this.config.get('CLEANUP_WORKER_ENABLED')?.trim().toLowerCase();
    if (raw) return raw === 'true';
    return this.config.get('NODE_ENV') !== 'test';
  }
  get intervalMs() {
    return (
      Math.max(
        this.integer('CLEANUP_INTERVAL_SECONDS', DEFAULT_INTERVAL_SECONDS),
        MIN_INTERVAL_SECONDS,
      ) * 1000
    );
  }
  onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log('Evidence cleanup worker disabled (CLEANUP_WORKER_ENABLED=false)');
      return;
    }
    // Stagger the first run so several instances do not start in lockstep.
    this.schedule(15_000 + Math.floor(Math.random() * 15_000));
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
  /** Runs one reconcile pass. Returns null when a pass is already running. */
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
    try {
      const batch = Math.min(this.integer('CLEANUP_BATCH_SIZE', DEFAULT_BATCH_SIZE), 100);
      const result = await this.assets.reconcilePendingCleanup(batch);
      const backlog = await this.assets.cleanupBacklog(STUCK_ATTEMPTS);
      const summary = { ...result, ...backlog };
      this.lastRunAt = new Date();
      this.lastSummary = summary;
      this.consecutiveFailures = 0;
      this.report(summary);
      return summary;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.logger.error(
        JSON.stringify({
          event: 'evidence_cleanup_run_failed',
          consecutiveFailures: this.consecutiveFailures,
          errorName: error instanceof Error ? error.name : typeof error,
        }),
      );
      return null;
    }
  }
  report(summary) {
    const alertAge = this.integer('CLEANUP_ALERT_AGE_SECONDS', DEFAULT_ALERT_AGE_SECONDS);
    const line = (event) => JSON.stringify({ event, ...summary });
    if (
      summary.stuck > 0 ||
      (summary.oldestPendingAgeSeconds !== null && summary.oldestPendingAgeSeconds > alertAge)
    ) {
      // Private KYC/title-deed files are still sitting in storage: page a human.
      this.logger.error(line('evidence_cleanup_backlog_alert'));
    } else if (summary.failed > 0) {
      this.logger.warn(line('evidence_cleanup_run'));
    } else if (summary.processed > 0) {
      this.logger.log(line('evidence_cleanup_run'));
    }
  }
  integer(key, fallback) {
    const raw = this.config.get(key)?.trim();
    const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}

Object.assign(exports, { EvidenceCleanupWorker });
