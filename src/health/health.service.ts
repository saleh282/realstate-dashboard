import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

export type ReadinessResult = {
  ready: boolean;
  checks: Record<string, 'up' | 'down' | 'draining'>;
};

const DEFAULT_PING_TIMEOUT_MS = 2_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;
const PRODUCTION_DRAIN_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Liveness only proves the process can answer. Readiness reflects whether this
 * instance should receive traffic: it needs its database, and it stops being
 * ready as soon as shutdown begins so a load balancer drains it first.
 */
@Injectable()
export class HealthService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(HealthService.name);
  private shuttingDown = false;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly config: ConfigService,
  ) {}

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  liveness() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  async readiness(): Promise<ReadinessResult> {
    if (this.shuttingDown) return { ready: false, checks: { shutdown: 'draining' } };
    const mongo = await this.pingDatabase();
    return { ready: mongo, checks: { mongo: mongo ? 'up' : 'down' } };
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.shuttingDown = true;
    this.logger.warn(`Shutdown requested${signal ? ` (${signal})` : ''}; readiness is now failing`);

    const timeoutMs = this.numberSetting('SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS);
    // Backstop: if draining or closing connections hangs, do not stay half-alive.
    setTimeout(() => {
      this.logger.error(`Graceful shutdown exceeded ${timeoutMs}ms; forcing exit`);
      process.exit(1);
    }, timeoutMs).unref();

    const defaultDrain = this.config.get('NODE_ENV') === 'production' ? PRODUCTION_DRAIN_MS : 0;
    const drainMs = this.numberSetting('SHUTDOWN_DRAIN_MS', defaultDrain);
    if (drainMs > 0) await new Promise((resolve) => setTimeout(resolve, drainMs));
  }

  private async pingDatabase(): Promise<boolean> {
    try {
      if (this.connection.readyState !== 1 || !this.connection.db) return false;
      await withTimeout(this.connection.db.admin().ping(), DEFAULT_PING_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  private numberSetting(key: string, fallback: number): number {
    const raw = this.config.get<string>(key);
    const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }
}
