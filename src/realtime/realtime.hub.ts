import { Injectable } from '@nestjs/common';
import { RealtimeCloseCode } from './realtime.constants';
import { RealtimeSettings } from './realtime.settings';

/**
 * What the hub needs from one client connection. The gateway adapts a `ws`
 * socket to it; tests use plain fakes. `subscriptions` is OWNED by the hub —
 * nothing else mutates it — so a connection's rooms and the rooms' members can
 * never disagree.
 */
export interface RealtimeConnection {
  readonly id: string;
  readonly ip: string;
  /** Normalised auction ids this connection is subscribed to. */
  readonly subscriptions: Set<string>;
  isOpen(): boolean;
  /** Bytes queued for this peer and not yet flushed to the network. */
  bufferedAmount(): number;
  /** Hands one text frame to the transport's send queue (FIFO per connection). Never waits for the peer. */
  send(payload: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

/** The hub cannot accept a publish right now (shutting down). The outbox delivery must be retried, NOT acknowledged. */
export class RealtimeUnavailableError extends Error {
  constructor() {
    super('realtime hub is not accepting publishes');
    this.name = 'RealtimeUnavailableError';
  }
}

export type AdmitResult = 'ADMITTED' | 'CLOSED' | 'AT_CAPACITY' | 'IP_LIMIT';
export type SubscribeResult = 'ADDED' | 'ALREADY_SUBSCRIBED' | 'LIMIT_REACHED' | 'NOT_CONNECTED';
export interface PublishResult {
  /** Open connections the frame was handed to. */
  recipients: number;
  /** Connections that were closed/slow/failing and were dropped instead (they resync over HTTP when they reconnect). */
  dropped: number;
  skipped?: 'NO_SUBSCRIBERS' | 'DUPLICATE_OR_STALE';
}

interface Room {
  members: Set<RealtimeConnection>;
  /** Highest `streamVersion` already fanned out to this room in this process. */
  lastVersion: number;
}

/**
 * In-process registry of realtime connections and auction rooms (MAZAD-032).
 *
 * A room is `auction:<id>` — created only by `subscribe` from a validated id,
 * never from client-supplied text — and exists only while it has members, so
 * memory is bounded by live subscriptions.
 *
 * PUBLISH CONTRACT. `publish` is synchronous: it serialises the frame once and
 * hands it to each member's send queue in room-membership order, then returns.
 * Because the outbox dispatcher awaits each delivery before the next event of
 * the same auction, and `publish` never yields, frames for one auction reach
 * every socket in outbox order (a socket's queue is FIFO). There is no
 * fire-and-forget step that could reorder them. "Published" means "handed to
 * the transport for every currently subscribed open socket" — not "received":
 * a disconnected/slow client recovers by resyncing over HTTP.
 *
 * DUPLICATES. The outbox is at-least-once, so the same event can arrive again.
 * A room remembers the highest `streamVersion` it has fanned out and silently
 * skips anything at or below it, which makes a redelivery harmless while the
 * room lives. That is an optimisation: after a restart or once the room emptied
 * the memory is gone, and clients still deduplicate on `eventId`.
 *
 * SCOPE. Single process. Nothing here is shared between instances (see the
 * deployment-topology section of the MAZAD-032 doc).
 */
@Injectable()
export class RealtimeHub {
  private readonly connections = new Set<RealtimeConnection>();
  private readonly perIp = new Map<string, number>();
  private readonly rooms = new Map<string, Room>();
  private open = true;

  constructor(private readonly settings: RealtimeSettings) {}

  get accepting(): boolean {
    return this.open;
  }

  stats(): { connections: number; rooms: number; subscriptions: number } {
    let subscriptions = 0;
    for (const room of this.rooms.values()) subscriptions += room.members.size;
    return { connections: this.connections.size, rooms: this.rooms.size, subscriptions };
  }

  hasSubscribers(auctionId: string): boolean {
    return (this.rooms.get(auctionId)?.members.size ?? 0) > 0;
  }

  // ------------------------------ connections ------------------------------

  admit(connection: RealtimeConnection): AdmitResult {
    if (!this.open) return 'CLOSED';
    if (this.connections.has(connection)) return 'ADMITTED';
    if (this.connections.size >= this.settings.maxConnections) return 'AT_CAPACITY';
    if ((this.perIp.get(connection.ip) ?? 0) >= this.settings.maxConnectionsPerIp) return 'IP_LIMIT';
    this.connections.add(connection);
    this.perIp.set(connection.ip, (this.perIp.get(connection.ip) ?? 0) + 1);
    return 'ADMITTED';
  }

  /** Removes the connection and every one of its subscriptions. Idempotent: called from close, error and heartbeat paths alike. */
  disconnect(connection: RealtimeConnection): void {
    if (!this.connections.delete(connection)) return;
    const remaining = (this.perIp.get(connection.ip) ?? 1) - 1;
    if (remaining > 0) this.perIp.set(connection.ip, remaining);
    else this.perIp.delete(connection.ip);
    for (const auctionId of [...connection.subscriptions]) this.leave(connection, auctionId);
    connection.subscriptions.clear();
  }

  // ----------------------------- subscriptions -----------------------------

  /** Adds the connection to `auction:<id>` (a repeat is a harmless no-op). `auctionId` must already be normalised by `normalizeAuctionId`. */
  subscribe(connection: RealtimeConnection, auctionId: string): SubscribeResult {
    if (!this.connections.has(connection)) return 'NOT_CONNECTED';
    if (connection.subscriptions.has(auctionId)) return 'ALREADY_SUBSCRIBED';
    if (connection.subscriptions.size >= this.settings.maxSubscriptionsPerSocket) return 'LIMIT_REACHED';
    let room = this.rooms.get(auctionId);
    if (!room) {
      room = { members: new Set(), lastVersion: 0 };
      this.rooms.set(auctionId, room);
    }
    room.members.add(connection);
    connection.subscriptions.add(auctionId);
    return 'ADDED';
  }

  /** Returns whether the connection was subscribed. Unsubscribing something it never joined is a harmless no-op. */
  unsubscribe(connection: RealtimeConnection, auctionId: string): boolean {
    if (!connection.subscriptions.delete(auctionId)) return false;
    this.leave(connection, auctionId);
    return true;
  }

  // -------------------------------- fan-out --------------------------------

  /**
   * Fans one event frame out to the auction's room. Throws `RealtimeUnavailableError`
   * when the hub is shutting down (so the outbox retries instead of acknowledging
   * an event nobody could receive). Otherwise it returns normally — including
   * when nobody is subscribed, which is a correct "accepted": there is no one to tell.
   */
  publish(auctionId: string, streamVersion: number, frame: object): PublishResult {
    if (!this.open) throw new RealtimeUnavailableError();
    const room = this.rooms.get(auctionId);
    if (!room || room.members.size === 0) return { recipients: 0, dropped: 0, skipped: 'NO_SUBSCRIBERS' };
    if (streamVersion <= room.lastVersion) return { recipients: 0, dropped: 0, skipped: 'DUPLICATE_OR_STALE' };
    room.lastVersion = streamVersion;
    const payload = JSON.stringify(frame);
    let recipients = 0;
    let dropped = 0;
    for (const member of [...room.members]) {
      if (this.push(member, payload)) recipients += 1;
      else dropped += 1;
    }
    return { recipients, dropped };
  }

  /**
   * Removes every subscription to the auction (optionally telling members why
   * first). Used after a terminal event and when the auction stopped being
   * publicly visible: room membership must never outlive the auction's public
   * life. Sockets stay connected and may subscribe to other auctions.
   */
  closeRoom(auctionId: string, notice?: object): number {
    const room = this.rooms.get(auctionId);
    if (!room) return 0;
    this.rooms.delete(auctionId);
    const payload = notice ? JSON.stringify(notice) : undefined;
    const members = [...room.members];
    for (const member of members) {
      member.subscriptions.delete(auctionId);
      if (payload !== undefined) this.push(member, payload);
    }
    return members.length;
  }

  /** Graceful stop: refuse further publishes/admissions and tell every client to go away (they reconnect elsewhere and resync). */
  shutdown(): void {
    this.open = false;
    for (const connection of [...this.connections]) {
      try {
        connection.close(RealtimeCloseCode.GOING_AWAY, 'SERVER_SHUTDOWN');
      } catch {
        connection.terminate();
      }
    }
    this.connections.clear();
    this.perIp.clear();
    this.rooms.clear();
  }

  // -------------------------------- private --------------------------------

  private leave(connection: RealtimeConnection, auctionId: string): void {
    const room = this.rooms.get(auctionId);
    if (!room) return;
    room.members.delete(connection);
    if (room.members.size === 0) this.rooms.delete(auctionId);
  }

  /** Sends one frame to one member; a member that cannot take it is dropped, never allowed to grow an unbounded queue or stall the others. */
  private push(connection: RealtimeConnection, payload: string): boolean {
    if (!connection.isOpen()) {
      this.disconnect(connection);
      return false;
    }
    if (connection.bufferedAmount() > this.settings.maxBufferedBytes) {
      connection.terminate();
      this.disconnect(connection);
      return false;
    }
    try {
      connection.send(payload);
      return true;
    } catch {
      connection.terminate();
      this.disconnect(connection);
      return false;
    }
  }
}
