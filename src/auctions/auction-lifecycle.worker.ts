import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuctionLifecycleRunSummary, AuctionLifecycleService } from './auction-lifecycle.service';

const DEFAULT_INTERVAL_SECONDS = 30;
const MIN_INTERVAL_SECONDS = 5;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 200;
const STOP_WAIT_MS = 10_000;

/**
 * Periodically activates due SCHEDULED auctions and expires due ACTIVE ones
 * (MAZAD-024). Mirrors `EvidenceCleanupWorker`'s concurrency shape
 * (`src/config/evidence-cleanup.worker.ts`): a single timer chain plus an
 * in-process re-entrancy guard (`inFlight`) means this process never runs
 * two passes at once, and `AuctionLifecycleService`'s per-document atomic
 * `findOneAndUpdate` claims mean multiple instances of this worker can run
 * the same tick without ever double-transitioning an auction — no
 * Redis/distributed lock needed for that.
 */
@Injectable()
export class AuctionLifecycleWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AuctionLifecycleWorker.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<unknown>;
  private stopped = false;
  lastRunAt?: Date;
  lastSummary?: AuctionLifecycleRunSummary;

  constructor(
    private readonly lifecycle: AuctionLifecycleService,
    private readonly config: ConfigService,
  ) {}

  get enabled(): boolean {
    const raw = this.config.get<string>('AUCTION_LIFECYCLE_WORKER_ENABLED')?.trim().toLowerCase();
    if (raw) return raw === 'true';
    return this.config.get<string>('NODE_ENV') !== 'test';
  }

  get intervalMs(): number {
    return Math.max(this.integer('AUCTION_LIFECYCLE_INTERVAL_SECONDS', DEFAULT_INTERVAL_SECONDS), MIN_INTERVAL_SECONDS) * 1000;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Auction lifecycle worker disabled (AUCTION_LIFECYCLE_WORKER_ENABLED=false)');
      return;
    }
    // Stagger the first run so several instances do not start in lockstep.
    this.schedule(5_000 + Math.floor(Math.random() * 5_000));
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

  /** Runs one activate+expire pass. Returns null when a pass is already running. */
  async runOnce(): Promise<AuctionLifecycleRunSummary | null> {
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

  private async execute(): Promise<AuctionLifecycleRunSummary | null> {
    try {
      const batch = Math.min(this.integer('AUCTION_LIFECYCLE_BATCH_SIZE', DEFAULT_BATCH_SIZE), MAX_BATCH_SIZE);
      // Activation first, then expiry, so an auction whose start and end
      // both fall due in the same tick is carried all the way through
      // instead of waiting an extra interval — a nicety, not a
      // correctness requirement (each call is independently safe).
      const { activated } = await this.lifecycle.activateDueAuctions(batch);
      const { endedNoBids, endedPendingClose } = await this.lifecycle.expireDueAuctions(batch);
      const summary: AuctionLifecycleRunSummary = { activated, endedNoBids, endedPendingClose };
      this.lastRunAt = new Date();
      this.lastSummary = summary;
      this.report(summary);
      return summary;
    } catch (error) {
      this.logger.error(JSON.stringify({
        event: 'auction_lifecycle_run_failed',
        errorName: error instanceof Error ? error.name : typeof error,
      }));
      return null;
    }
  }

  private report(summary: AuctionLifecycleRunSummary): void {
    // Quiet on a no-op tick (nothing due) — only log when something moved.
    if (summary.activated > 0 || summary.endedNoBids > 0 || summary.endedPendingClose > 0) {
      this.logger.log(JSON.stringify({ event: 'auction_lifecycle_run', ...summary }));
    }
  }

  private integer(key: string, fallback: number): number {
    const raw = this.config.get<string>(key)?.trim();
    const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
