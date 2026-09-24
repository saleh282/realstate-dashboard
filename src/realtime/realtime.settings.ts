import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildCorsOptions } from '../config/cors.config';
import { REALTIME_MAX_MESSAGE_BYTES_HARD_CAP, REALTIME_TOPOLOGY_SINGLE_INSTANCE } from './realtime.constants';

const DEFAULTS = {
  maxConnections: 5_000,
  maxConnectionsPerIp: 100,
  maxSubscriptionsPerSocket: 50,
  maxMessageBytes: 2_048,
  messageRateLimit: 30,
  messageRateWindowSeconds: 10,
  heartbeatSeconds: 30,
  maxBufferedBytes: 1_048_576,
} as const;

/**
 * Realtime configuration (MAZAD-032), read from the environment at use time
 * (like the other workers) so it always reflects `ConfigService`. Shapes are
 * validated at boot by `environment.validation.ts`; an unset/garbled value falls
 * back to the documented default here as a second line of defence.
 *
 * `enabled` is OPT-IN and false by default: enabling realtime does two things
 * at once — it accepts WebSocket connections AND makes THIS process the sole
 * claimant of the outbox `realtime` consumer. In a multi-instance deployment
 * only the instance that serves the sockets may do that (see
 * `docs/MAZAD-032-realtime-auction-updates.md`, "Deployment topology").
 */
@Injectable()
export class RealtimeSettings {
  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return this.text('REALTIME_ENABLED').toLowerCase() === 'true';
  }
  /** Declared deployment topology; `single_instance` is the only supported one. */
  get topology(): string {
    return this.text('REALTIME_TOPOLOGY') || REALTIME_TOPOLOGY_SINGLE_INSTANCE;
  }
  get maxConnections(): number { return this.integer('REALTIME_MAX_CONNECTIONS', DEFAULTS.maxConnections); }
  get maxConnectionsPerIp(): number { return this.integer('REALTIME_MAX_CONNECTIONS_PER_IP', DEFAULTS.maxConnectionsPerIp); }
  get maxSubscriptionsPerSocket(): number { return this.integer('REALTIME_MAX_SUBSCRIPTIONS_PER_SOCKET', DEFAULTS.maxSubscriptionsPerSocket); }
  /** Never above the WebSocket layer's hard cap, whatever is configured. */
  get maxMessageBytes(): number { return Math.min(this.integer('REALTIME_MAX_MESSAGE_BYTES', DEFAULTS.maxMessageBytes), REALTIME_MAX_MESSAGE_BYTES_HARD_CAP); }
  /** Inbound messages allowed per socket per window. */
  get messageRateLimit(): number { return this.integer('REALTIME_MESSAGE_RATE_LIMIT', DEFAULTS.messageRateLimit); }
  get messageRateWindowMs(): number { return this.integer('REALTIME_MESSAGE_RATE_WINDOW_SECONDS', DEFAULTS.messageRateWindowSeconds) * 1000; }
  get heartbeatMs(): number { return this.integer('REALTIME_HEARTBEAT_SECONDS', DEFAULTS.heartbeatSeconds) * 1000; }
  /** A socket whose unsent outbound buffer exceeds this is terminated (it resyncs over HTTP on reconnect). */
  get maxBufferedBytes(): number { return this.integer('REALTIME_MAX_BUFFERED_BYTES', DEFAULTS.maxBufferedBytes); }

  /** Origins a BROWSER may connect from — the same allow-list as HTTP CORS. `true` = any (non-production with no list). Native clients send no Origin. */
  get allowedOrigins(): true | string[] {
    const origin = buildCorsOptions({ NODE_ENV: this.text('NODE_ENV'), CORS_ORIGINS: this.text('CORS_ORIGINS') } as NodeJS.ProcessEnv).origin;
    return origin === true ? true : Array.isArray(origin) ? (origin as string[]) : [];
  }

  private text(key: string): string {
    const value = this.config.get<unknown>(key);
    return value === undefined || value === null ? '' : String(value).trim();
  }

  private integer(key: string, fallback: number): number {
    const raw = this.text(key);
    const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
