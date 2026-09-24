/**
 * Stable, machine-readable codes of the auction realtime channel (MAZAD-032).
 * They travel in `{ type: 'error', code }` frames; clients switch on the code,
 * never on the (Arabic, display-only) message. A code is never re-used for a
 * different condition.
 */
export enum RealtimeErrorCode {
  /** Not JSON, not an object, unknown/extra field, bad `requestId`, or a binary frame. */
  MESSAGE_MALFORMED = 'REALTIME_MESSAGE_MALFORMED',
  MESSAGE_TOO_LARGE = 'REALTIME_MESSAGE_TOO_LARGE',
  OPERATION_UNKNOWN = 'REALTIME_OPERATION_UNKNOWN',
  /** `auctionId` is not a 24-hex ObjectId. Nothing is looked up. */
  AUCTION_ID_INVALID = 'REALTIME_AUCTION_ID_INVALID',
  /** Missing, or not publicly visible under the HTTP contract. One code for both, so ids cannot be probed. */
  AUCTION_NOT_AVAILABLE = 'REALTIME_AUCTION_NOT_AVAILABLE',
  SUBSCRIPTION_LIMIT_REACHED = 'REALTIME_SUBSCRIPTION_LIMIT_REACHED',
  RATE_LIMITED = 'REALTIME_RATE_LIMITED',
  /** The visibility check could not be completed (dependency failure). Safe to retry; nothing was subscribed. */
  TEMPORARILY_UNAVAILABLE = 'REALTIME_TEMPORARILY_UNAVAILABLE',
}
