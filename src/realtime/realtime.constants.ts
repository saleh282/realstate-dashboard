import { API_GLOBAL_PREFIX } from '../common/http/api-prefix';

/**
 * Leaf module: no application imports beyond the API prefix, so environment
 * validation can read the hard limits without pulling in the realtime graph.
 */

/** Permanent identity of the realtime outbox consumer. It keys `delivery.realtime` on every event: NEVER rename it (a rename re-delivers all history). */
export const REALTIME_CONSUMER_NAME = 'realtime';

/** The single WebSocket endpoint. Under the API prefix so the same ingress rule routes it. */
export const REALTIME_PATH = `/${API_GLOBAL_PREFIX}/realtime`;

/** Version of the client↔server frame protocol (`ready.protocolVersion`). Event payload shapes carry their own `schemaVersion`. */
export const REALTIME_PROTOCOL_VERSION = 1;

/** Version of the client-facing event contract this server emits (independent of the outbox `schemaVersion`). */
export const REALTIME_EVENT_SCHEMA_VERSION = 1;

/** Absolute ceiling for one inbound frame, enforced by the WebSocket layer itself (frames above it close the socket with 1009 before being buffered). `REALTIME_MAX_MESSAGE_BYTES` may only lower it. */
export const REALTIME_MAX_MESSAGE_BYTES_HARD_CAP = 8_192;

/** Documented single-instance topology; the only value accepted for `REALTIME_TOPOLOGY` until a shared fan-out adapter exists. */
export const REALTIME_TOPOLOGY_SINGLE_INSTANCE = 'single_instance';

/**
 * Ceiling on the number of auctions the activation cutover can record. The cutover is ONE document (so it is written
 * atomically, exactly once); at ~30 bytes per auction this stays far below MongoDB's 16 MB document limit. Exceeding it
 * is refused (the consumer stays unconfigured, loudly) rather than silently truncated — a truncated cutover would let
 * history be broadcast.
 */
export const REALTIME_CUTOVER_MAX_AGGREGATES = 200_000;

/** Application close codes (4000–4999 are reserved for applications; 1001/1008/1013 are the standard ones). */
export const RealtimeCloseCode = {
  GOING_AWAY: 1001,
  POLICY_VIOLATION: 1008,
  TRY_AGAIN_LATER: 1013,
  UNAUTHORIZED: 4401,
  FORBIDDEN_ORIGIN: 4403,
  SLOW_CONSUMER: 4408,
  RATE_LIMITED: 4429,
  REALTIME_DISABLED: 4503,
} as const;

const AUCTION_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/**
 * The only way an auction id enters the system from a client. Strictly 24 hex
 * characters (Mongoose's `isValid` also accepts any 12-character string), and
 * lower-cased so it matches the outbox `aggregateId`, which is always lower-case hex.
 */
export function normalizeAuctionId(value: unknown): string | null {
  return typeof value === 'string' && AUCTION_ID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/** Room key. Built ONLY here, from a validated id: a client can never name a room. */
export const auctionRoomKey = (auctionId: string): string => `auction:${auctionId}`;
