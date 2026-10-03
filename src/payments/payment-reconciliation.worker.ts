import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isProtectedProcess } from '../config/deployment-environment';
import { PAYMENT_PROVIDER_PORT, PaymentProviderPort } from './payment-provider.port';
import { DEFAULT_RECONCILIATION_BATCH_SIZE, DEFAULT_RECONCILIATION_INTERVAL_SECONDS, MAX_RECONCILIATION_BATCH_SIZE, paymentAttemptTtlMs } from './payment-reconciliation.config';
import { PaymentReconciliationService, PaymentReconciliationSummary } from './payment-reconciliation.service';

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
@Injectable()
export class PaymentReconciliationWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PaymentReconciliationWorker.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<unknown>;
  private stopped = false;
  private warnedUnconfigured = false;
  lastRunAt?: Date;
  lastSummary?: PaymentReconciliationSummary;

  constructor(
    private readonly reconciliation: PaymentReconciliationService,
    private readonly config: ConfigService,
    @Inject(PAYMENT_PROVIDER_PORT) private readonly provider: PaymentProviderPort,
  ) {}

  get enabled(): boolean {
    const raw = this.config.get<string>('PAYMENT_RECONCILIATION_WORKER_ENABLED')?.trim().toLowerCase();
    if (raw) return raw === 'true';
    return this.config.get<string>('NODE_ENV') !== 'test';
  }

  get intervalMs(): number {
    return Math.max(this.integer('PAYMENT_RECONCILIATION_INTERVAL_SECONDS', DEFAULT_RECONCILIATION_INTERVAL_SECONDS), MIN_INTERVAL_SECONDS) * 1000;
  }

  /** False in a protected deployment that has a provider bound but no explicit attempt lifetime: the worker then stays idle. */
  get expiryConfigured(): boolean {
    const env = { NODE_ENV: this.config.get('NODE_ENV'), DEPLOYMENT_ENV: this.config.get('DEPLOYMENT_ENV'), PAYMENT_ATTEMPT_TTL_SECONDS: this.config.get('PAYMENT_ATTEMPT_TTL_SECONDS') };
    return !isProtectedProcess(env) || paymentAttemptTtlMs(env) !== null;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Payment reconciliation worker disabled (PAYMENT_RECONCILIATION_WORKER_ENABLED=false)');
      return;
    }
    // Stagger the first run so several instances do not start in lockstep.
    this.schedule(Math.min(this.intervalMs, 3_000 + Math.floor(Math.random() * 3_000)));
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (!this.inFlight) return;
    await Promise.race([
      this.inFlight.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref()),
    ]);
  }

  /** Runs one reconciliation pass. Returns null when a pass is already running, or when there is nothing this process may do. */
  async runOnce(): Promise<PaymentReconciliationSummary | null> {
    if (this.inFlight) return null;
    const run = this.execute();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = undefined;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.schedule(this.intervalMs));
    }, delayMs);
    this.timer.unref();
  }

  private async execute(): Promise<PaymentReconciliationSummary | null> {
    if (!this.provider.configured) return null; // no gateway bound: nothing can be verified, and nothing is touched
    if (!this.expiryConfigured) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        this.logger.error(JSON.stringify({ event: 'payment_reconciliation_refused', reason: 'PAYMENT_ATTEMPT_TTL_SECONDS is not configured in a protected deployment' }));
      }
      return null;
    }
    try {
      const batch = Math.min(this.integer('PAYMENT_RECONCILIATION_BATCH_SIZE', DEFAULT_RECONCILIATION_BATCH_SIZE), MAX_RECONCILIATION_BATCH_SIZE);
      const summary = await this.reconciliation.reconcileDue(batch);
      this.lastRunAt = new Date();
      this.lastSummary = summary;
      // Quiet on a no-op tick — only log when something was worked.
      if (summary.claimed > 0) this.logger.log(JSON.stringify({ event: 'payment_reconciliation_run', ...summary }));
      return summary;
    } catch (error) {
      this.logger.error(JSON.stringify({ event: 'payment_reconciliation_run_failed', errorName: error instanceof Error ? error.name : typeof error }));
      return null;
    }
  }

  private integer(key: string, fallback: number): number {
    const raw = this.config.get<string>(key)?.trim();
    const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
