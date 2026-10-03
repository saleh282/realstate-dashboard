/**
 * Delivery lifecycle of one outbox event FOR ONE CONSUMER (MAZAD-031).
 *
 * An event is delivered independently to every registered consumer that
 * subscribes to its type, so each consumer has its own state, stored under
 * `delivery.<consumerName>` on the event. "No `delivery.<name>` yet" is the
 * initial state and means PENDING and due now: the obligation is DERIVED from
 * the committed event, never created by the business transaction (which
 * therefore never needs to know any consumer).
 *
 *   (absent/PENDING) ──claim──▶ PROCESSING ──consumer ack──▶ PROCESSED
 *          ▲                        │
 *          └── transient failure (backoff) / lease expiry
 *                                   └── permanent failure / attempts exhausted ──▶ DEAD_LETTER
 *
 * DEAD_LETTER is a per-consumer parking state, never a deletion: the immutable
 * event stays intact and other consumers are unaffected. Nothing in the
 * application moves a delivery out of DEAD_LETTER; redriving is a deliberate
 * operator action.
 */

export enum OutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  PROCESSED = 'PROCESSED',
  DEAD_LETTER = 'DEAD_LETTER'
}

/** A delivery in one of these states is still owed to its consumer. */
export const OUTBOX_UNFINISHED_STATUSES = [OutboxStatus.PENDING, OutboxStatus.PROCESSING] as const;
/** A consumer is finished with an event once its delivery is in one of these states. */
export const OUTBOX_TERMINAL_STATUSES = [OutboxStatus.PROCESSED, OutboxStatus.DEAD_LETTER] as const;

/**
 * Closed set of failure classifications stored on a delivery. Deliberately NOT
 * the exception message or stack (those can carry payloads, hostnames or PII);
 * `lastErrorName` additionally keeps the error's constructor name.
 */

export enum OutboxErrorClass {
  /** The consumer threw / rejected: presumed transient, retried with backoff. */
  CONSUMER_ERROR = 'CONSUMER_ERROR',
  /** The consumer did not answer within the per-delivery timeout: presumed transient. */
  CONSUMER_TIMEOUT = 'CONSUMER_TIMEOUT',
  /** The consumer declared the event undeliverable (`OutboxPermanentDeliveryError`): dead-lettered immediately. */
  CONSUMER_PERMANENT = 'CONSUMER_PERMANENT',
  /** The delivery was claimed more times than allowed without ever being acknowledged (e.g. it crashes its worker). */
  LEASE_EXPIRED_MAX_ATTEMPTS = 'LEASE_EXPIRED_MAX_ATTEMPTS'
}

/**
 * Index names. They are referenced by the transaction runners: a duplicate on
 * the per-aggregate version index is a lost race with a concurrent
 * transaction on the same aggregate (never a reason to fail the business
 * operation), so it is retried like a WriteConflict.
 */
export const OUTBOX_AGGREGATE_VERSION_INDEX = 'outbox_aggregate_version';

/** A serialised payload larger than this is a contract violation (events carry identifiers and scalars, not documents). */
export const OUTBOX_MAX_PAYLOAD_BYTES = 4_096;

// ---------------------------------------------------------------------------
// Consumer identity and the per-consumer delivery sub-document.
// ---------------------------------------------------------------------------

/**
 * A consumer's stable identity (e.g. `notifications`). It is used as
 * a MongoDB field name inside `delivery` and inside an index name, so it must be
 * a plain lower-case token — no dots, no `$`, no hyphen. Renaming a consumer
 * creates a NEW consumer that re-receives all history: treat names as permanent.
 */
export const OUTBOX_CONSUMER_NAME_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/** Field names inside `delivery.<consumer>`. */
export type OutboxDeliveryField =
  | 'status' | 'attemptCount' | 'nextAttemptAt' | 'claimedBy' | 'leaseToken' | 'claimedAt' | 'lastAttemptAt'
  | 'processedAt' | 'deadLetteredAt' | 'lastErrorClass' | 'lastErrorName';

/** Dotted path of one of a consumer's delivery fields, e.g. `delivery.notifications.status`. */
export const outboxDeliveryPath = (consumer: string, field: OutboxDeliveryField): string => `delivery.${consumer}.${field}`;

/** Index that serves one consumer's scans (fresh events, retries, expired leases). Created when the consumer first dispatches. */
export const outboxConsumerScanIndexName = (consumer: string): string => `outbox_delivery_scan_${consumer}`;
export const outboxConsumerScanIndexSpec = (consumer: string): Record<string, 1> => ({
  // `type` first: a consumer that subscribes to a subset must not keep re-reading events it will never receive.
  type: 1,
  [outboxDeliveryPath(consumer, 'status')]: 1,
  [outboxDeliveryPath(consumer, 'nextAttemptAt')]: 1,
  _id: 1,
});

/** The delivery state of an event for one consumer; an event the consumer has never touched is PENDING. */
export function outboxDeliveryStatus(event: { delivery?: Record<string, { status?: OutboxStatus }> } | null | undefined, consumer: string): OutboxStatus {
  return event?.delivery?.[consumer]?.status ?? OutboxStatus.PENDING;
}
