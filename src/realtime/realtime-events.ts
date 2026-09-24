import { AuctionStatus } from '../auctions/auction.types';
import { OutboxDeliveryEvent, OutboxPermanentDeliveryError } from '../outbox/outbox-consumer.port';
import { OutboxAggregateType, OutboxAudience, OutboxEventType } from '../outbox/outbox-events';
import { REALTIME_EVENT_SCHEMA_VERSION } from './realtime.constants';

/**
 * MAZAD-032 — the client-facing realtime event contract and the ONLY code that
 * turns a MAZAD-031 outbox event into something a socket may carry.
 *
 * WHAT A CLIENT MAY LEARN. Exactly what the anonymous HTTP contract already
 * shows for a publicly visible auction (`GET /auctions/:id`, `/bid-state`,
 * `/bids`): auction-level state, bid sequence/amount/count, and the
 * server-authoritative `currentEndAt`. Nothing about WHO: no bidder or winner
 * account id, no `privateRouting`, no bid/payment ids, no names/contacts, no
 * audit data, no cancellation reason. The outbox `payload` is never spread —
 * every field is named here — so a field added to an event later is invisible
 * to sockets until someone deliberately adds it below.
 *
 * WHAT A FRAME IS NOT. It is not the source of truth and not exactly-once.
 * `eventId` is stable across redeliveries (the outbox is at-least-once): clients
 * deduplicate on it. `streamVersion` is the per-auction dense event counter
 * (the outbox `aggregateVersion`): an event whose version is not `last + 1` means
 * something was missed, so the client re-reads the authoritative HTTP state.
 * Authoritative time is always the server's (`currentEndAt`, `serverTime`) —
 * never a device clock, and the client never computes an extension.
 *
 * `terminal: true` marks the last event of an auction's public life (no bids,
 * cancelled, finalized): the server then removes every subscription to that
 * auction. The finalized event carries only the identity-free result.
 */
export const REALTIME_SUBSCRIBED_EVENT_TYPES: readonly OutboxEventType[] = [
  OutboxEventType.AUCTION_ACTIVATED,
  OutboxEventType.BID_ACCEPTED,
  OutboxEventType.AUCTION_END_EXTENDED,
  OutboxEventType.AUCTION_ENDED_PENDING_CLOSE,
  OutboxEventType.AUCTION_ENDED_NO_BIDS,
  OutboxEventType.AUCTION_CANCELLED,
  OutboxEventType.AUCTION_FINALIZED,
];

/** After one of these the auction is no longer publicly readable (or will never change again): the room is closed. */
export const REALTIME_TERMINAL_EVENT_TYPES: ReadonlySet<OutboxEventType> = new Set([
  OutboxEventType.AUCTION_ENDED_NO_BIDS,
  OutboxEventType.AUCTION_CANCELLED,
  OutboxEventType.AUCTION_FINALIZED,
]);

interface FrameBase<E extends OutboxEventType, D> {
  type: 'event';
  event: E;
  /** Stable across redeliveries: deduplicate on this. */
  eventId: string;
  /** Version of THIS contract (`data` shape) — not the outbox schema version. */
  schemaVersion: number;
  auctionId: string;
  /** Dense per-auction counter. A jump ≥ 2 = missed events → resync over HTTP. Repeats/lower values are duplicates/stale. */
  streamVersion: number;
  /** When the change committed (server clock). */
  occurredAt: string;
  /** When this frame was produced (server clock): the reference for a countdown. */
  serverTime: string;
  terminal: boolean;
  data: D;
}

export type BidAcceptedFrame = FrameBase<OutboxEventType.BID_ACCEPTED, {
  sequence: number;
  amountMinor: number;
  currency: string;
  acceptedAt: string;
  acceptedBidCount: number;
  currentEndAt: string;
  previousEndAt: string;
  extended: boolean;
  nextMinimumBidMinor: number | null;
}>;
export type AuctionActivatedFrame = FrameBase<OutboxEventType.AUCTION_ACTIVATED, { status: AuctionStatus; currentEndAt: string }>;
export type AuctionEndExtendedFrame = FrameBase<OutboxEventType.AUCTION_END_EXTENDED, { status: AuctionStatus; previousEndAt: string; currentEndAt: string }>;
export type AuctionEndedPendingCloseFrame = FrameBase<OutboxEventType.AUCTION_ENDED_PENDING_CLOSE, { status: AuctionStatus; currentEndAt: string; acceptedBidCount: number }>;
export type AuctionEndedNoBidsFrame = FrameBase<OutboxEventType.AUCTION_ENDED_NO_BIDS, { status: AuctionStatus; currentEndAt: string }>;
export type AuctionCancelledFrame = FrameBase<OutboxEventType.AUCTION_CANCELLED, { status: AuctionStatus; previousStatus: AuctionStatus; cancelledAt: string }>;
export type AuctionFinalizedFrame = FrameBase<OutboxEventType.AUCTION_FINALIZED, {
  status: AuctionStatus;
  finalizedAt: string;
  acceptedBidCount: number;
  /** Identity-free outcome, the same three facts as the public projection's `result`. */
  result: { winningBidSequence: number; winningBidAmountMinor: number; currency: string };
}>;

export type RealtimeEventFrame =
  | BidAcceptedFrame
  | AuctionActivatedFrame
  | AuctionEndExtendedFrame
  | AuctionEndedPendingCloseFrame
  | AuctionEndedNoBidsFrame
  | AuctionCancelledFrame
  | AuctionFinalizedFrame;

/**
 * The event cannot be expressed as a safe public frame (wrong audience or
 * aggregate, unknown schema version, missing/ill-typed field). Retrying cannot
 * help, so it is a permanent failure: the delivery is dead-lettered FOR THE
 * REALTIME CONSUMER ONLY. The message deliberately names no value.
 */
const unmappable = (reason: string): OutboxPermanentDeliveryError => new OutboxPermanentDeliveryError(`realtime: ${reason}`);

type Payload = Record<string, unknown>;
const CURRENCY = /^[A-Z]{3}$/;

function integer(payload: Payload, key: string, min: number): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw unmappable(`invalid ${key}`);
  return value;
}
function nullableInteger(payload: Payload, key: string, min: number): number | null {
  return payload[key] === null ? null : integer(payload, key, min);
}
function currency(payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !CURRENCY.test(value)) throw unmappable(`invalid ${key}`);
  return value;
}
function instant(payload: Payload, key: string): string {
  const value = payload[key];
  const time = typeof value === 'string' ? new Date(value) : undefined;
  if (!time || Number.isNaN(time.getTime())) throw unmappable(`invalid ${key}`);
  return time.toISOString();
}
function boolean(payload: Payload, key: string): boolean {
  if (typeof payload[key] !== 'boolean') throw unmappable(`invalid ${key}`);
  return payload[key] as boolean;
}
function status(payload: Payload, key: string, expected?: AuctionStatus): AuctionStatus {
  const value = payload[key];
  if (typeof value !== 'string' || !(Object.values(AuctionStatus) as string[]).includes(value)) throw unmappable(`invalid ${key}`);
  if (expected !== undefined && value !== expected) throw unmappable(`unexpected ${key}`);
  return value as AuctionStatus;
}

/**
 * Outbox event → client frame. Pure (the caller supplies `serverTime`), and
 * strict: anything that is not a well-formed PUBLIC auction event of a known
 * schema version throws `OutboxPermanentDeliveryError`.
 */
export function toRealtimeEvent(event: OutboxDeliveryEvent, serverTime: Date): RealtimeEventFrame {
  if (event.aggregateType !== OutboxAggregateType.AUCTION) throw unmappable('not an auction event');
  // A PRIVATE event must never reach a public room, whatever its type says.
  if (event.audience !== OutboxAudience.PUBLIC) throw unmappable('event is not public');
  if (event.schemaVersion !== 1) throw unmappable('unsupported schema version');
  if (typeof event.eventId !== 'string' || !event.eventId) throw unmappable('missing eventId');
  if (!Number.isSafeInteger(event.aggregateVersion) || event.aggregateVersion < 1) throw unmappable('invalid aggregateVersion');
  if (!(event.occurredAt instanceof Date) || Number.isNaN(event.occurredAt.getTime())) throw unmappable('invalid occurredAt');
  const payload = event.payload as Payload;
  if (!payload || typeof payload !== 'object') throw unmappable('missing payload');
  // The event must be about the aggregate it is filed under: a payload can never redirect a frame to another auction's room.
  if (payload.auctionId !== event.aggregateId) throw unmappable('payload names a different auction');

  const base = {
    type: 'event' as const,
    eventId: event.eventId,
    schemaVersion: REALTIME_EVENT_SCHEMA_VERSION,
    auctionId: event.aggregateId,
    streamVersion: event.aggregateVersion,
    occurredAt: event.occurredAt.toISOString(),
    serverTime: serverTime.toISOString(),
    terminal: REALTIME_TERMINAL_EVENT_TYPES.has(event.type),
  };

  switch (event.type) {
    case OutboxEventType.BID_ACCEPTED:
      return {
        ...base, event: event.type,
        data: {
          sequence: integer(payload, 'sequence', 1),
          amountMinor: integer(payload, 'amountMinor', 0),
          currency: currency(payload, 'currency'),
          acceptedAt: instant(payload, 'acceptedAt'),
          acceptedBidCount: integer(payload, 'acceptedBidCount', 1),
          currentEndAt: instant(payload, 'currentEndAt'),
          previousEndAt: instant(payload, 'previousEndAt'),
          extended: boolean(payload, 'extended'),
          nextMinimumBidMinor: nullableInteger(payload, 'nextMinimumBidMinor', 0),
        },
      };
    case OutboxEventType.AUCTION_ACTIVATED:
      return { ...base, event: event.type, data: { status: status(payload, 'status', AuctionStatus.ACTIVE), currentEndAt: instant(payload, 'currentEndAt') } };
    case OutboxEventType.AUCTION_END_EXTENDED:
      return {
        ...base, event: event.type,
        data: { status: status(payload, 'status', AuctionStatus.ACTIVE), previousEndAt: instant(payload, 'previousEndAt'), currentEndAt: instant(payload, 'currentEndAt') },
      };
    case OutboxEventType.AUCTION_ENDED_PENDING_CLOSE:
      return {
        ...base, event: event.type,
        data: { status: status(payload, 'status', AuctionStatus.ENDED_PENDING_CLOSE), currentEndAt: instant(payload, 'currentEndAt'), acceptedBidCount: integer(payload, 'acceptedBidCount', 1) },
      };
    case OutboxEventType.AUCTION_ENDED_NO_BIDS:
      return { ...base, event: event.type, data: { status: status(payload, 'status', AuctionStatus.ENDED_NO_BIDS), currentEndAt: instant(payload, 'currentEndAt') } };
    case OutboxEventType.AUCTION_CANCELLED:
      // The cancellation reason is free text and is not in the outbox event; nothing about who cancelled either.
      return {
        ...base, event: event.type,
        data: { status: status(payload, 'status', AuctionStatus.CANCELLED), previousStatus: status(payload, 'previousStatus'), cancelledAt: instant(payload, 'cancelledAt') },
      };
    case OutboxEventType.AUCTION_FINALIZED:
      // `winnerAccountId` lives in privateRouting and is never read here.
      return {
        ...base, event: event.type,
        data: {
          status: status(payload, 'status', AuctionStatus.COMPLETED),
          finalizedAt: instant(payload, 'finalizedAt'),
          acceptedBidCount: integer(payload, 'acceptedBidCount', 1),
          result: {
            winningBidSequence: integer(payload, 'winningBidSequence', 1),
            winningBidAmountMinor: integer(payload, 'winningBidAmountMinor', 0),
            currency: currency(payload, 'currency'),
          },
        },
      };
    default:
      // Payment / managed-marketing events are not realtime events; the consumer does not subscribe to them.
      throw unmappable('event type is not a realtime event');
  }
}
