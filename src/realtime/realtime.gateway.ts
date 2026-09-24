import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'http';
import type { RawData, WebSocket } from 'ws';
import { RealtimeErrorCode } from '../common/errors/realtime-error-codes';
import { ClockService } from '../common/time/clock.service';
import { RealtimeAuctionAccess } from './realtime-auction-access';
import { RealtimeAuthenticator, RealtimeUnauthorizedError } from './realtime-authenticator';
import { resolveClientAddress } from './realtime-client-address';
import { RealtimeCutoverService } from './realtime-cutover.service';
import { errorFrame, readyFrame, subscribedFrame, unsubscribedFrame } from './realtime-frames';
import { RealtimeConnection, RealtimeHub } from './realtime.hub';
import { REALTIME_MAX_MESSAGE_BYTES_HARD_CAP, REALTIME_PATH, RealtimeCloseCode, normalizeAuctionId } from './realtime.constants';
import { RealtimeSettings } from './realtime.settings';

const OPEN = 1; // WebSocket.OPEN — a literal so no runtime import of `ws` is needed here (the adapter owns it)
/** Client→server frame: only these keys exist. Anything else (a `room`, a `channel`, …) is rejected rather than ignored. */
const ALLOWED_KEYS = new Set(['op', 'auctionId', 'requestId']);
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** Unprocessed messages one socket may have queued behind a slow visibility lookup. */
const MAX_PENDING_MESSAGES = 16;

/** One `ws` socket seen through the hub's interface. */
class WsConnection implements RealtimeConnection {
  readonly subscriptions = new Set<string>();
  constructor(readonly id: string, readonly ip: string, readonly socket: WebSocket) {}
  isOpen(): boolean { return this.socket.readyState === OPEN; }
  bufferedAmount(): number { return this.socket.bufferedAmount; }
  send(payload: string): void {
    // The callback keeps a late transport error from becoming an uncaught exception; the peer is simply dropped.
    this.socket.send(payload, (error) => { if (error) this.socket.terminate(); });
  }
  close(code: number, reason: string): void { this.socket.close(code, reason); }
  terminate(): void { this.socket.terminate(); }
}

/** Per-socket state that is not the hub's business. */
class Session {
  principal: { userId: string; sessionId: string } | null = null;
  alive = true;
  closed = false;
  windowStartedAt = 0;
  windowCount = 0;
  rateNotified = false;
  pending = 0;
  chain: Promise<void> = Promise.resolve();
  constructor(readonly connection: WsConnection) {}
}

/**
 * The WebSocket endpoint of the auction realtime channel (MAZAD-032): a thin
 * transport that authenticates the handshake (optionally), applies the limits,
 * parses frames and maps `subscribe` / `unsubscribe` onto the hub. It emits no
 * business data itself — event frames come from the `realtime` outbox consumer
 * through the hub — and it owns no auction state.
 *
 * WHY THE GATEWAY PARSES FRAMES ITSELF. Nest's `@SubscribeMessage` routing in
 * `WsAdapter` swallows unparseable frames silently and offers no error reply, size
 * or rate hook. Owning the parse lets every malformed input get a stable
 * `{ type: 'error', code }` and lets the limits below be enforced. The adapter
 * still does the plumbing (HTTP upgrade routing on `REALTIME_PATH`, `ws`
 * server lifecycle, shutdown).
 *
 * PROTOCOL (client → server, JSON text, ≤ `REALTIME_MAX_MESSAGE_BYTES`):
 *   { "op": "subscribe" | "unsubscribe", "auctionId": "<24-hex>", "requestId"?: "<≤64 chars>" }
 * Only those three keys exist. The client never names a room: the server builds
 * `auction:<id>` from the validated id. Messages of one socket are processed
 * strictly in order, one at a time, so the subscription cap cannot be raced.
 *
 * ABUSE CONTROLS: total and per-address connection caps checked BEFORE any
 * authentication work; a fixed-window message rate per socket (a flood closes it
 * with 4429); a hard 8 KiB frame ceiling in the `ws` layer; a bounded processing
 * queue; a per-socket subscription cap; heartbeat pings that reap dead peers;
 * and termination of a peer whose unsent buffer grows past the limit.
 *
 * ORIGIN. A browser's `Origin`, when present, must be in the same allow-list as
 * HTTP CORS (`CORS_ORIGINS`); native clients send none. There are no cookies here,
 * so this is connection hygiene, not the primary control.
 */
@WebSocketGateway({ path: REALTIME_PATH, maxPayload: REALTIME_MAX_MESSAGE_BYTES_HARD_CAP })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly sessions = new Map<WebSocket, Session>();
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly hub: RealtimeHub,
    private readonly settings: RealtimeSettings,
    private readonly authenticator: RealtimeAuthenticator,
    private readonly access: RealtimeAuctionAccess,
    private readonly clock: ClockService,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly cutover: RealtimeCutoverService,
  ) {}

  onModuleInit(): void {
    this.heartbeat = setInterval(() => this.beat(), this.settings.heartbeatMs);
    this.heartbeat.unref();
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.hub.shutdown();
    this.sessions.clear();
  }

  // ------------------------------- lifecycle -------------------------------

  handleConnection(client: WebSocket, request: IncomingMessage): void {
    try {
      this.accept(client, request);
    } catch (error) {
      // Never let a handshake problem escape into the process (an uncaught error here would take the API down).
      this.logger.error(JSON.stringify({ event: 'realtime_connection_failed', errorName: error instanceof Error ? error.name : typeof error }));
      this.forget(client);
      client.terminate();
    }
  }

  handleDisconnect(client: WebSocket): void {
    this.forget(client);
  }

  private accept(client: WebSocket, request: IncomingMessage): void {
    if (!this.settings.enabled) return this.refuse(client, RealtimeCloseCode.REALTIME_DISABLED, 'REALTIME_DISABLED');
    if (!this.hub.accepting) return this.refuse(client, RealtimeCloseCode.TRY_AGAIN_LATER, 'SERVER_UNAVAILABLE');
    if (!this.originAllowed(request.headers?.origin)) return this.refuse(client, RealtimeCloseCode.FORBIDDEN_ORIGIN, 'FORBIDDEN_ORIGIN');

    const connection = new WsConnection(randomUUID(), resolveClientAddress(request, this.httpAdapterHost?.httpAdapter?.getInstance?.()), client);
    const admitted = this.hub.admit(connection);
    if (admitted === 'AT_CAPACITY' || admitted === 'CLOSED') return this.refuse(client, RealtimeCloseCode.TRY_AGAIN_LATER, 'AT_CAPACITY');
    if (admitted === 'IP_LIMIT') return this.refuse(client, RealtimeCloseCode.RATE_LIMITED, 'TOO_MANY_CONNECTIONS');

    const session = new Session(connection);
    this.sessions.set(client, session);
    client.on('message', (data: RawData, isBinary: boolean) => this.onMessage(session, data, isBinary));
    client.on('pong', () => { session.alive = true; });
    client.on('error', () => { this.forget(client); client.terminate(); });

    // Messages that arrive while the (asynchronous) credential check runs queue behind it.
    session.chain = this.establish(session, request.headers?.authorization).catch((error) => {
      this.logger.error(JSON.stringify({ event: 'realtime_establish_failed', errorName: error instanceof Error ? error.name : typeof error }));
      this.closeSession(session, RealtimeCloseCode.TRY_AGAIN_LATER, 'SERVER_ERROR');
    });
  }

  private async establish(session: Session, authorization: string | undefined): Promise<void> {
    try {
      session.principal = await this.authenticator.authenticate(authorization);
    } catch (error) {
      if (error instanceof RealtimeUnauthorizedError) return this.closeSession(session, RealtimeCloseCode.UNAUTHORIZED, 'UNAUTHORIZED');
      // A dependency failure, not a bad credential: do not tell the client its token is invalid.
      this.logger.error(JSON.stringify({ event: 'realtime_auth_unavailable', errorName: error instanceof Error ? error.name : typeof error }));
      return this.closeSession(session, RealtimeCloseCode.TRY_AGAIN_LATER, 'AUTH_UNAVAILABLE');
    }
    if (session.closed) return;
    this.send(session, readyFrame({
      serverTime: this.clock.now(),
      authenticated: session.principal !== null,
      maxSubscriptions: this.settings.maxSubscriptionsPerSocket,
      maxMessageBytes: this.settings.maxMessageBytes,
    }));
  }

  private refuse(client: WebSocket, code: number, reason: string): void {
    try {
      client.close(code, reason);
    } catch {
      client.terminate();
    }
  }

  private originAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true; // native clients
    const allowed = this.settings.allowedOrigins;
    return allowed === true || allowed.includes(origin);
  }

  private closeSession(session: Session, code: number, reason: string): void {
    this.forget(session.connection.socket);
    this.refuse(session.connection.socket, code, reason);
  }

  /** Idempotent cleanup: the hub drops every membership and the per-address slot. */
  private forget(client: WebSocket): void {
    const session = this.sessions.get(client);
    if (!session) return;
    session.closed = true;
    this.sessions.delete(client);
    this.hub.disconnect(session.connection);
  }

  private beat(): void {
    for (const session of [...this.sessions.values()]) {
      const socket = session.connection.socket;
      if (!session.alive) {
        this.forget(socket);
        socket.terminate();
        continue;
      }
      session.alive = false;
      try {
        socket.ping();
      } catch {
        this.forget(socket);
        socket.terminate();
      }
    }
  }

  // -------------------------------- messages --------------------------------

  private onMessage(session: Session, data: RawData, isBinary: boolean): void {
    if (session.closed) return;
    if (!this.withinRate(session)) return;
    if (session.pending >= MAX_PENDING_MESSAGES) return this.reply(session, RealtimeErrorCode.RATE_LIMITED);
    if (isBinary) return this.reply(session, RealtimeErrorCode.MESSAGE_MALFORMED);
    if (byteLength(data) > this.settings.maxMessageBytes) return this.reply(session, RealtimeErrorCode.MESSAGE_TOO_LARGE);
    const text = toText(data);
    session.pending += 1;
    session.chain = session.chain
      .then(() => this.handle(session, text))
      .catch((error) => {
        // A bug must never leak internals to the client or stop the socket's queue.
        this.logger.error(JSON.stringify({ event: 'realtime_message_failed', errorName: error instanceof Error ? error.name : typeof error }));
        this.reply(session, RealtimeErrorCode.TEMPORARILY_UNAVAILABLE);
      })
      .finally(() => { session.pending -= 1; });
  }

  /** Fixed-window limiter. Over the limit: drop and say so once per window; far over it: close the socket. */
  private withinRate(session: Session): boolean {
    const now = Date.now();
    const windowMs = this.settings.messageRateWindowMs;
    if (now - session.windowStartedAt >= windowMs) {
      session.windowStartedAt = now;
      session.windowCount = 0;
      session.rateNotified = false;
    }
    session.windowCount += 1;
    const limit = this.settings.messageRateLimit;
    if (session.windowCount <= limit) return true;
    if (session.windowCount > limit * 2) {
      this.closeSession(session, RealtimeCloseCode.RATE_LIMITED, 'RATE_LIMITED');
      return false;
    }
    if (!session.rateNotified) {
      session.rateNotified = true;
      this.reply(session, RealtimeErrorCode.RATE_LIMITED);
    }
    return false;
  }

  private async handle(session: Session, text: string): Promise<void> {
    if (session.closed) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return this.reply(session, RealtimeErrorCode.MESSAGE_MALFORMED);
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return this.reply(session, RealtimeErrorCode.MESSAGE_MALFORMED);
    const fields = message as Record<string, unknown>;
    if (Object.keys(fields).some((key) => !ALLOWED_KEYS.has(key))) return this.reply(session, RealtimeErrorCode.MESSAGE_MALFORMED);

    // `requestId` is echoed back, so it is accepted only in a strict, inert alphabet.
    let requestId: string | undefined;
    if (fields.requestId !== undefined) {
      if (typeof fields.requestId !== 'string' || !REQUEST_ID.test(fields.requestId)) return this.reply(session, RealtimeErrorCode.MESSAGE_MALFORMED);
      requestId = fields.requestId;
    }
    if (typeof fields.op !== 'string') return this.reply(session, RealtimeErrorCode.MESSAGE_MALFORMED, { requestId });
    if (fields.op !== 'subscribe' && fields.op !== 'unsubscribe') return this.reply(session, RealtimeErrorCode.OPERATION_UNKNOWN, { requestId });
    const auctionId = normalizeAuctionId(fields.auctionId);
    if (!auctionId) return this.reply(session, RealtimeErrorCode.AUCTION_ID_INVALID, { requestId });

    if (fields.op === 'unsubscribe') {
      const wasSubscribed = this.hub.unsubscribe(session.connection, auctionId);
      return this.send(session, unsubscribedFrame({ serverTime: this.clock.now(), auctionId, wasSubscribed, requestId }));
    }
    return this.subscribe(session, auctionId, requestId);
  }

  private async subscribe(session: Session, auctionId: string, requestId: string | undefined): Promise<void> {
    const connection = session.connection;
    // A repeat is answered without touching the database.
    if (connection.subscriptions.has(auctionId)) {
      return this.send(session, subscribedFrame({ serverTime: this.clock.now(), auctionId, alreadySubscribed: true, requestId }));
    }
    // Until the activation cutover is persisted nothing may be subscribed. Events the cutover classes as history are never pushed,
    // so a client must read HTTP only AFTER the cutover exists (the resync the `subscribed` ack asks for) — otherwise an event
    // committed in that window could be withheld from a client whose HTTP read missed it. Retry shortly; this only happens at boot.
    if (!this.cutover.ready) return this.reply(session, RealtimeErrorCode.TEMPORARILY_UNAVAILABLE, { requestId, auctionId });
    // Checked BEFORE the lookup so a capped socket cannot make the server do work for nothing.
    if (connection.subscriptions.size >= this.settings.maxSubscriptionsPerSocket) {
      return this.reply(session, RealtimeErrorCode.SUBSCRIPTION_LIMIT_REACHED, { requestId, auctionId });
    }
    let visible: boolean;
    try {
      visible = await this.access.isPubliclyVisible(auctionId);
    } catch (error) {
      // Fail closed: an unknown is not a yes. Nothing is subscribed and no detail reaches the client.
      this.logger.error(JSON.stringify({ event: 'realtime_visibility_check_failed', errorName: error instanceof Error ? error.name : typeof error }));
      return this.reply(session, RealtimeErrorCode.TEMPORARILY_UNAVAILABLE, { requestId, auctionId });
    }
    if (session.closed) return; // the peer left while we were checking
    if (!visible) return this.reply(session, RealtimeErrorCode.AUCTION_NOT_AVAILABLE, { requestId, auctionId });
    const result = this.hub.subscribe(connection, auctionId);
    if (result === 'NOT_CONNECTED') return;
    if (result === 'LIMIT_REACHED') return this.reply(session, RealtimeErrorCode.SUBSCRIPTION_LIMIT_REACHED, { requestId, auctionId });
    this.send(session, subscribedFrame({ serverTime: this.clock.now(), auctionId, alreadySubscribed: result === 'ALREADY_SUBSCRIBED', requestId }));
  }

  // -------------------------------- sending --------------------------------

  private reply(session: Session, code: RealtimeErrorCode, extra: { requestId?: string; auctionId?: string } = {}): void {
    this.send(session, errorFrame({ serverTime: this.clock.now(), code, ...extra }));
  }

  private send(session: Session, frame: object): void {
    const connection = session.connection;
    if (session.closed || !connection.isOpen()) return;
    if (connection.bufferedAmount() > this.settings.maxBufferedBytes) {
      // The peer is not reading its replies: same treatment as a slow event consumer.
      this.closeSession(session, RealtimeCloseCode.SLOW_CONSUMER, 'SLOW_CONSUMER');
      return;
    }
    try {
      connection.send(JSON.stringify(frame));
    } catch {
      this.forget(connection.socket);
      connection.terminate();
    }
  }
}

function byteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + chunk.length, 0);
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}

function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : data.toString('utf8');
}
