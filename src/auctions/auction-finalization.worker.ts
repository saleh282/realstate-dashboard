import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuctionFinalizationRunSummary, AuctionFinalizationService } from './auction-finalization.service';

const DEFAULT_INTERVAL_SECONDS = 30;
const MIN_INTERVAL_SECONDS = 5;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 200;
const STOP_WAIT_MS = 10_000;

/**
 * Eventually finalizes ENDED_PENDING_CLOSE auctions (MAZAD-030). Same shape
 * and conventions as `AuctionLifecycleWorker`: one timer chain, an in-process
 * re-entrancy guard, staggered start — but correctness NEVER depends on the
 * guard: each auction is finalized in its own database transaction
 * (`AuctionFinalizationService.finalize`), so any number of overlapping
 * workers/instances converge on one winner. It only ever picks auctions the
 * lifecycle expiry has already moved to ENDED_PENDING_CLOSE. Kept separate from
 * the lifecycle worker so a finalization problem cannot stall activation/expiry.
 */
@Injectable()
export class AuctionFinalizationWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AuctionFinalizationWorker.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<unknown>;
  private stopped = false;
  lastRunAt?: Date;
  lastSummary?: AuctionFinalizationRunSummary;

  constructor(
    private readonly finalization: AuctionFinalizationService,
    private readonly config: ConfigService,
  ) {}

  get enabled(): boolean {
    const raw = this.config.get<string>('AUCTION_FINALIZATION_WORKER_ENABLED')?.trim().toLowerCase();
    if (raw) return raw === 'true';
    return this.config.get<string>('NODE_ENV') !== 'test';
  }

  get intervalMs(): number {
    return Math.max(this.integer('AUCTION_FINALIZATION_INTERVAL_SECONDS', DEFAULT_INTERVAL_SECONDS), MIN_INTERVAL_SECONDS) * 1000;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log('Auction finalization worker disabled (AUCTION_FINALIZATION_WORKER_ENABLED=false)');
      return;
    }
    this.schedule(7_000 + Math.floor(Math.random() * 5_000));
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

  /** Runs one finalization pass. Returns null when a pass is already running or the pass itself failed. */
  async runOnce(): Promise<AuctionFinalizationRunSummary | null> {
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

  private async execute(): Promise<AuctionFinalizationRunSummary | null> {
    try {
      const batch = Math.min(this.integer('AUCTION_FINALIZATION_BATCH_SIZE', DEFAULT_BATCH_SIZE), MAX_BATCH_SIZE);
      const summary = await this.finalization.finalizeDueAuctions(batch);
      this.lastRunAt = new Date();
      this.lastSummary = summary;
      // Quiet on a no-op tick.
      if (summary.finalized > 0 || summary.alreadyFinalized > 0 || summary.failed > 0) {
        this.logger.log(JSON.stringify({ event: 'auction_finalization_run', ...summary }));
      }
      return summary;
    } catch (error) {
      this.logger.error(JSON.stringify({ event: 'auction_finalization_run_failed', errorName: error instanceof Error ? error.name : typeof error }));
      return null;
    }
  }

  private integer(key: string, fallback: number): number {
    const raw = this.config.get<string>(key)?.trim();
    const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
