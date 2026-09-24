import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { ClockService } from '../common/time/clock.service';
import { OutboxConsumerRegistry, OutboxDeliveryEvent, OutboxEventConsumer, OutboxPermanentDeliveryError } from './outbox-consumer.port';
import {
  OUTBOX_TERMINAL_STATUSES,
  OUTBOX_UNFINISHED_STATUSES,
  OutboxErrorClass,
  OutboxStatus,
  outboxConsumerScanIndexName,
  outboxConsumerScanIndexSpec,
  outboxDeliveryPath,
} from './outbox.constants';
import { OutboxEvent, OutboxEventDocument } from './schemas/outbox-event.schema';

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
/** Each scan looks this many times past the batch (rows blocked behind an unfinished predecessor use up scan slots). */
const SCAN_FACTOR = 4;
/** Extra scans per pass that skip the aggregates already found blocked, so one stuck aggregate's backlog cannot starve the rest. */
const MAX_SCAN_ROUNDS = 4;
const JITTER_FLOOR = 0.8;

export class OutboxConsumerTimeoutError extends Error {
  constructor() {
    super('outbox consumer did not answer in time');
    this.name = 'OutboxConsumerTimeoutError';
  }
}

export type OutboxDispatchSummary = {
  /** The consumer this pass served. */
  consumer: string;
  /** Set (and nothing else happens) when the consumer is unknown or switched off. */
  skipped?: 'UNKNOWN_CONSUMER' | 'NOT_CONFIGURED';
  scanned: number;
  /** Events this consumer acknowledged AND whose PROCESSED marker was stored. */
  delivered: number;
  /** Failed deliveries scheduled for another attempt. */
  retried: number;
  deadLettered: number;
  /** Aggregates skipped this pass because an EARLIER event of theirs is still unfinished FOR THIS CONSUMER (ordering). */
  blockedAggregates: number;
  /** Deliveries another instance of this consumer claimed first. */
  lostClaims: number;
  /** Deliveries whose acknowledgement/failure write found the lease gone or could not be stored (the event will be redelivered). */
  unconfirmed: number;
};

const emptySummary = (consumer: string): OutboxDispatchSummary => ({ consumer, scanned: 0, delivered: 0, retried: 0, deadLettered: 0, blockedAggregates: 0, lostClaims: 0, unconfirmed: 0 });

/** Exponential backoff with a hard ceiling and a little downward jitter: `min(cap, base·2^(attempt-1)) × [0.8, 1.0]`. Never exceeds `capMs`. */
export function outboxBackoffMs(attempt: number, options: { baseMs: number; capMs: number; random?: () => number }): number {
  const exponential = Math.min(options.capMs, options.baseMs * 2 ** Math.max(0, Math.min(attempt, 60) - 1));
  const jitter = JITTER_FLOOR + (1 - JITTER_FLOOR) * (options.random ?? Math.random)();
  return Math.min(options.capMs, Math.round(exponential * jitter));
}

type Ctx = { consumer: OutboxEventConsumer; name: string; subscribed: string[]; path: (field: Parameters<typeof outboxDeliveryPath>[1]) => string };
type Claim = { doc: any; token: string };
type Settled = 'DELIVERED' | 'RETRY_SCHEDULED' | 'DEAD_LETTERED' | 'UNCONFIRMED';

/**
 * MAZAD-031 — moves committed outbox events to ONE registered consumer at a
 * time, with per-consumer delivery state.
 *
 * MULTI-CONSUMER MODEL. An event is written once, immutably, by the business
 * transaction. Each consumer's progress on it lives under `delivery.<name>` on
 * that same event, so consumers are fully independent: realtime PROCESSED while
 * notifications is PENDING (or retrying, or DEAD_LETTER) is an ordinary state,
 * and a consumer only ever writes its own `delivery.<name>.*`. The set of
 * events owed to a consumer is DERIVED, not created: every committed event of a
 * type it subscribes to whose `delivery.<name>` is absent (never touched) or
 * unfinished. So the business transaction never knows any consumer, and a
 * consumer registered years later finds all history still owed to it. There is
 * no cursor, no lag window and no backfill job, hence no way to silently skip an
 * event: what is committed is what is owed.
 *
 * DELIVERY GUARANTEE: at-least-once PER CONSUMER, never exactly-once. The outbox
 * guarantees (1) no event exists before its business transaction commits,
 * (2) a committed event is durable, (3) an event a consumer has not acknowledged
 * is retried for that consumer. It does NOT guarantee a consumer sees an event
 * only once: a crash after the consumer succeeded but before the PROCESSED marker
 * is stored, a consumer timeout that hid a success, or a lease that expired under
 * a slow consumer all redeliver. Every consumer MUST deduplicate by `eventId`.
 *
 * ALGORITHM (one pass for one consumer; safe to run from any number of
 * instances, and concurrently with every other consumer's passes):
 *  1. Unknown / switched-off consumer ⇒ return immediately; nothing is claimed,
 *     marked or counted. With no consumer registered, events simply stay durable.
 *  2. Scan the events owed to this consumer, oldest first, `_id` as tie-break:
 *     FRESH (`delivery.<name>.status` absent) plus RETRYABLE (status PENDING /
 *     PROCESSING with `nextAttemptAt ≤ now` — a PROCESSING lease that expired is
 *     due again), restricted to the consumer's subscribed types, bounded to
 *     `batch × 4` per scan. Aggregates found blocked are excluded from up to three
 *     follow-up scans in the same pass, so a stuck aggregate's backlog cannot
 *     starve newer aggregates behind it.
 *  3. Group by aggregate; within an aggregate go in `aggregateVersion` order.
 *  4. ORDERING GATE (per consumer): an event is only attempted when no
 *     lower-version event of the same aggregate that THIS consumer subscribes to
 *     is still unfinished FOR THIS CONSUMER (absent, PENDING or PROCESSING).
 *     DEAD_LETTER counts as finished (otherwise one poison event would stall an
 *     auction forever) — a consumer that sees a version gap resynchronises from
 *     authoritative state. Other consumers' progress is never consulted.
 *  5. CLAIM atomically: one `findOneAndUpdate` on `{_id, this consumer's delivery
 *     absent or unfinished and due}` sets PROCESSING, a fresh random `leaseToken`,
 *     `nextAttemptAt = now + lease`, and `attemptCount += 1` — all under
 *     `delivery.<name>`. Exactly one instance of the consumer wins each claim
 *     (MongoDB serialises writes to a document); the others see a non-matching
 *     filter and move on. No process-local mutex participates in correctness.
 *  6. Deliver with a per-delivery timeout strictly below the lease.
 *  7. ACK only after the consumer resolves: conditional write `{_id,
 *     delivery.<name>.status: PROCESSING, delivery.<name>.leaseToken}` →
 *     PROCESSED. A failure write is conditional on the same token, so a stale
 *     worker can never overwrite a newer claim.
 *  8. Failure: transient → PENDING with bounded exponential backoff;
 *     `OutboxPermanentDeliveryError`, or `attemptCount ≥ maxAttempts` →
 *     DEAD_LETTER (kept intact for investigation; the event and the other
 *     consumers' deliveries are untouched). A claim that already used up the
 *     attempts (a delivery that keeps crashing its worker) is dead-lettered
 *     without another delivery.
 *
 * Why an ordering gate that tolerates a stale read is still safe: the set of
 * unfinished lower versions only ever shrinks. Versions are assigned in commit
 * order per aggregate (an event is only visible once every lower version is), and
 * DEAD_LETTER deliveries are never re-opened by the application, so "no
 * unfinished predecessor" observed once stays true until the claim lands.
 *
 * ORDERING GUARANTEE (precise): FOR ONE CONSUMER and one aggregate, deliveries
 * START in `aggregateVersion` order, and version N+1 is not started before N is
 * PROCESSED or DEAD_LETTERED for that consumer. Different consumers may be at
 * different versions of the same aggregate. There is NO ordering across
 * aggregates and no global sequence (that would serialise every business
 * transaction). Because of at-least-once redelivery a consumer can still receive
 * a duplicate of an older version after a newer one; it must dedupe by `eventId`
 * / ignore versions it has already applied.
 */
@Injectable()
export class OutboxDispatcherService {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  /** Opaque per-process id stored on claims (diagnostics only; carries no host name). */
  readonly instanceId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  /** Overridable in tests. */
  random: () => number = Math.random;
  /** consumer name → its scan index has been ensured by this process (a scheduling optimisation only). */
  private readonly indexed = new Map<string, Promise<void>>();

  constructor(
    @InjectModel(OutboxEvent.name) private readonly events: Model<OutboxEventDocument>,
    private readonly registry: OutboxConsumerRegistry,
    private readonly clock: ClockService,
    private readonly config: ConfigService,
  ) {}

  get batchSize(): number {
    return this.integer('OUTBOX_DISPATCHER_BATCH_SIZE', DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
  }
  get leaseMs(): number {
    return this.integer('OUTBOX_LEASE_SECONDS', 60, 10, 3_600) * 1000;
  }
  get maxAttempts(): number {
    return this.integer('OUTBOX_MAX_ATTEMPTS', 12, 1, 100);
  }
  get retryBaseMs(): number {
    return this.integer('OUTBOX_RETRY_BASE_SECONDS', 2, 1, 3_600) * 1000;
  }
  get retryCapMs(): number {
    return Math.max(this.retryBaseMs, this.integer('OUTBOX_RETRY_MAX_SECONDS', 600, 1, 86_400) * 1000);
  }
  /** Always strictly below the lease, so a live delivery never outlives its own claim. */
  get consumerTimeoutMs(): number {
    return Math.min(this.integer('OUTBOX_CONSUMER_TIMEOUT_SECONDS', 15, 1, 300) * 1000, Math.floor(this.leaseMs / 2));
  }

  /** Runs one bounded dispatch pass for the consumer registered under `consumerName`. */
  async dispatchConsumer(consumerName: string, limit?: number): Promise<OutboxDispatchSummary> {
    const summary = emptySummary(consumerName);
    const consumer = this.registry.get(consumerName);
    if (!consumer) {
      summary.skipped = 'UNKNOWN_CONSUMER';
      return summary;
    }
    if (consumer.configured !== true) {
      summary.skipped = 'NOT_CONFIGURED';
      return summary;
    }
    const ctx: Ctx = { consumer, name: consumer.name, subscribed: [...consumer.subscribedTypes], path: (field) => outboxDeliveryPath(consumer.name, field) };
    await this.ensureScanIndex(ctx);
    const batch = Math.min(Math.max(Math.trunc(limit ?? this.batchSize) || this.batchSize, 1), MAX_BATCH_SIZE);

    const scanLimit = batch * SCAN_FACTOR;
    const blockedAggregateIds: string[] = [];
    let attempts = 0;
    for (let round = 0; round < MAX_SCAN_ROUNDS && attempts < batch; round++) {
      const { candidates, exhausted } = await this.scanOwed(ctx, scanLimit, blockedAggregateIds);
      summary.scanned += candidates.length;
      if (!candidates.length) break;

      const groups = new Map<string, any[]>();
      for (const candidate of candidates) {
        const key = `${candidate.aggregateType}:${candidate.aggregateId}`;
        const group = groups.get(key);
        if (group) group.push(candidate);
        else groups.set(key, [candidate]);
      }
      for (const group of groups.values()) group.sort((a, b) => a.aggregateVersion - b.aggregateVersion);

      for (const group of groups.values()) {
        for (const event of group) {
          if (attempts >= batch) return summary;
          if (await this.hasUnfinishedPredecessor(ctx, event)) {
            summary.blockedAggregates += 1;
            blockedAggregateIds.push(event.aggregateId);
            break;
          }
          const claim = await this.claim(ctx, event);
          if (!claim) {
            summary.lostClaims += 1;
            blockedAggregateIds.push(event.aggregateId);
            break; // another instance of this consumer owns this event; its successors wait behind it
          }
          attempts += 1;
          const settled = await this.deliverClaimed(ctx, claim, summary);
          if (settled === 'RETRY_SCHEDULED' || settled === 'UNCONFIRMED') {
            blockedAggregateIds.push(event.aggregateId); // the successor is now (or still) behind an unfinished event
            break;
          }
        }
      }
      if (exhausted) break; // everything owed and due was looked at: nothing more to scan
    }
    return summary;
  }

  /**
   * The events owed to this consumer right now: never touched (`delivery.<name>.status` absent) or unfinished and due.
   * Two index-backed queries, merged into one deterministic order `(dueAt, _id)` where a never-touched event is due at its
   * `occurredAt` and a retry at its `nextAttemptAt`.
   */
  private async scanOwed(ctx: Ctx, scanLimit: number, blockedAggregateIds: string[]): Promise<{ candidates: any[]; exhausted: boolean }> {
    const exclude = blockedAggregateIds.length ? { aggregateId: { $nin: blockedAggregateIds } } : {};
    const sort = { [ctx.path('nextAttemptAt')]: 1, _id: 1 } as Record<string, 1>;
    const fresh: any[] = await this.events
      .find({ type: { $in: ctx.subscribed }, [ctx.path('status')]: null, ...exclude })
      .sort(sort).limit(scanLimit).lean().exec();
    const retryable: any[] = await this.events
      .find({ type: { $in: ctx.subscribed }, [ctx.path('status')]: { $in: [...OUTBOX_UNFINISHED_STATUSES] }, [ctx.path('nextAttemptAt')]: { $lte: this.clock.now() }, ...exclude })
      .sort(sort).limit(scanLimit).lean().exec();
    const dueAt = (event: any): number => new Date(event.delivery?.[ctx.name]?.nextAttemptAt ?? event.occurredAt).getTime();
    const merged = [...fresh, ...retryable].sort((a, b) => dueAt(a) - dueAt(b) || (String(a._id) < String(b._id) ? -1 : String(a._id) > String(b._id) ? 1 : 0));
    return { candidates: merged.slice(0, scanLimit), exhausted: fresh.length < scanLimit && retryable.length < scanLimit };
  }

  private async hasUnfinishedPredecessor(ctx: Ctx, event: any): Promise<boolean> {
    const blocker = await this.events
      .findOne({
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        aggregateVersion: { $lt: event.aggregateVersion },
        type: { $in: ctx.subscribed }, // an event this consumer is never sent cannot hold it back
        [ctx.path('status')]: { $nin: [...OUTBOX_TERMINAL_STATUSES] }, // absent, PENDING or PROCESSING: still owed to THIS consumer
      })
      .select('_id')
      .lean()
      .exec();
    return Boolean(blocker);
  }

  private async claim(ctx: Ctx, event: any): Promise<Claim | null> {
    const now = this.clock.now();
    const token = randomUUID();
    const doc: any = await this.events
      .findOneAndUpdate(
        {
          _id: event._id,
          $or: [
            { [ctx.path('status')]: null },
            { [ctx.path('status')]: { $in: [...OUTBOX_UNFINISHED_STATUSES] }, [ctx.path('nextAttemptAt')]: { $lte: now } },
          ],
        },
        {
          $set: {
            [ctx.path('status')]: OutboxStatus.PROCESSING,
            [ctx.path('claimedBy')]: this.instanceId,
            [ctx.path('leaseToken')]: token,
            [ctx.path('claimedAt')]: now,
            [ctx.path('lastAttemptAt')]: now,
            [ctx.path('nextAttemptAt')]: new Date(now.getTime() + this.leaseMs), // the lease expiry: an abandoned claim becomes due again
          },
          $inc: { [ctx.path('attemptCount')]: 1 },
        },
        { new: true },
      )
      .lean()
      .exec();
    return doc ? { doc, token } : null;
  }

  private attempts(ctx: Ctx, doc: any): number {
    return doc.delivery?.[ctx.name]?.attemptCount ?? 0;
  }

  private async deliverClaimed(ctx: Ctx, claim: Claim, summary: OutboxDispatchSummary): Promise<Settled> {
    const { doc, token } = claim;
    if (this.attempts(ctx, doc) > this.maxAttempts) {
      // Claimed again after already using every attempt without ever being acknowledged (a crash loop): stop here.
      return this.deadLetter(ctx, doc, token, OutboxErrorClass.LEASE_EXPIRED_MAX_ATTEMPTS, undefined, summary);
    }

    try {
      await this.withTimeout(() => ctx.consumer.deliver(this.toDelivery(ctx, doc)));
    } catch (error) {
      return this.settleFailure(ctx, doc, token, error, summary);
    }

    try {
      const result: any = await this.events
        .updateOne(
          { _id: doc._id, [ctx.path('status')]: OutboxStatus.PROCESSING, [ctx.path('leaseToken')]: token },
          {
            $set: { [ctx.path('status')]: OutboxStatus.PROCESSED, [ctx.path('processedAt')]: this.clock.now() },
            $unset: { [ctx.path('claimedBy')]: '', [ctx.path('leaseToken')]: '' },
          },
        )
        .exec();
      if ((result?.matchedCount ?? result?.modifiedCount ?? 0) < 1) {
        // Someone reclaimed the delivery after our lease expired. The consumer already has the event; the newer claim will deliver again (duplicate, deduped by eventId).
        summary.unconfirmed += 1;
        return 'UNCONFIRMED';
      }
      summary.delivered += 1;
      return 'DELIVERED';
    } catch {
      // The consumer acknowledged but we could not store the marker: the delivery stays PROCESSING and is redelivered after the lease.
      this.logger.warn(JSON.stringify({ event: 'outbox_ack_not_stored', consumer: ctx.name, eventId: String(doc._id), type: doc.type }));
      summary.unconfirmed += 1;
      return 'UNCONFIRMED';
    }
  }

  private async settleFailure(ctx: Ctx, doc: any, token: string, error: unknown, summary: OutboxDispatchSummary): Promise<Settled> {
    const errorClass = error instanceof OutboxPermanentDeliveryError
      ? OutboxErrorClass.CONSUMER_PERMANENT
      : error instanceof OutboxConsumerTimeoutError
        ? OutboxErrorClass.CONSUMER_TIMEOUT
        : OutboxErrorClass.CONSUMER_ERROR;
    const attempt = this.attempts(ctx, doc);
    if (errorClass === OutboxErrorClass.CONSUMER_PERMANENT || attempt >= this.maxAttempts) {
      return this.deadLetter(ctx, doc, token, errorClass, error, summary);
    }

    const now = this.clock.now();
    const delay = outboxBackoffMs(attempt, { baseMs: this.retryBaseMs, capMs: this.retryCapMs, random: this.random });
    try {
      const result: any = await this.events
        .updateOne(
          { _id: doc._id, [ctx.path('status')]: OutboxStatus.PROCESSING, [ctx.path('leaseToken')]: token },
          {
            $set: {
              [ctx.path('status')]: OutboxStatus.PENDING,
              [ctx.path('nextAttemptAt')]: new Date(now.getTime() + delay),
              [ctx.path('lastErrorClass')]: errorClass,
              [ctx.path('lastErrorName')]: this.safeName(error),
            },
            $unset: { [ctx.path('claimedBy')]: '', [ctx.path('leaseToken')]: '' },
          },
        )
        .exec();
      if ((result?.matchedCount ?? result?.modifiedCount ?? 0) < 1) {
        summary.unconfirmed += 1;
        return 'UNCONFIRMED';
      }
    } catch {
      // Could not record the failure: the lease expiry is the retry schedule.
      summary.unconfirmed += 1;
      return 'UNCONFIRMED';
    }
    summary.retried += 1;
    return 'RETRY_SCHEDULED';
  }

  private async deadLetter(ctx: Ctx, doc: any, token: string, errorClass: OutboxErrorClass, error: unknown, summary: OutboxDispatchSummary): Promise<Settled> {
    try {
      const result: any = await this.events
        .updateOne(
          { _id: doc._id, [ctx.path('status')]: OutboxStatus.PROCESSING, [ctx.path('leaseToken')]: token },
          {
            $set: {
              [ctx.path('status')]: OutboxStatus.DEAD_LETTER,
              [ctx.path('deadLetteredAt')]: this.clock.now(),
              [ctx.path('lastErrorClass')]: errorClass,
              ...(error ? { [ctx.path('lastErrorName')]: this.safeName(error) } : {}),
            },
            $unset: { [ctx.path('claimedBy')]: '', [ctx.path('leaseToken')]: '' },
          },
        )
        .exec();
      if ((result?.matchedCount ?? result?.modifiedCount ?? 0) < 1) {
        summary.unconfirmed += 1;
        return 'UNCONFIRMED';
      }
    } catch {
      summary.unconfirmed += 1;
      return 'UNCONFIRMED';
    }
    summary.deadLettered += 1;
    // Identifiers and classification only — never the payload or the error message.
    this.logger.error(JSON.stringify({
      event: 'outbox_event_dead_lettered',
      consumer: ctx.name,
      eventId: String(doc._id),
      type: doc.type,
      aggregateType: doc.aggregateType,
      aggregateId: doc.aggregateId,
      aggregateVersion: doc.aggregateVersion,
      attemptCount: this.attempts(ctx, doc),
      errorClass,
    }));
    return 'DEAD_LETTERED';
  }

  /** The consumer only ever receives the immutable event plus ITS OWN attempt number — never another consumer's delivery state. */
  private toDelivery(ctx: Ctx, doc: any): OutboxDeliveryEvent {
    return {
      eventId: String(doc._id),
      type: doc.type,
      schemaVersion: doc.schemaVersion,
      aggregateType: doc.aggregateType,
      aggregateId: doc.aggregateId,
      aggregateVersion: doc.aggregateVersion,
      occurredAt: doc.occurredAt,
      audience: doc.audience,
      payload: doc.payload,
      ...(doc.privateRouting ? { privateRouting: doc.privateRouting } : {}),
      attempt: this.attempts(ctx, doc),
    };
  }

  /**
   * Ensures the consumer's scan index once per process. A failure is logged and retried on the next pass; dispatching
   * still proceeds (correctness never depends on the index, only speed does).
   */
  private ensureScanIndex(ctx: Ctx): Promise<void> {
    const known = this.indexed.get(ctx.name);
    if (known) return known;
    const created = (async () => {
      try {
        await (this.events as any).collection?.createIndex?.(outboxConsumerScanIndexSpec(ctx.name), { name: outboxConsumerScanIndexName(ctx.name) });
      } catch {
        this.indexed.delete(ctx.name);
        this.logger.warn(JSON.stringify({ event: 'outbox_scan_index_failed', consumer: ctx.name }));
      }
    })();
    this.indexed.set(ctx.name, created);
    return created;
  }

  /** Races the consumer against the per-delivery timeout. A late result of the abandoned call is ignored (at-least-once absorbs it). */
  private withTimeout(work: () => Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OutboxConsumerTimeoutError()), this.consumerTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([Promise.resolve().then(work), timeout]).finally(() => timer && clearTimeout(timer));
  }

  private safeName(error: unknown): string {
    const name = error instanceof Error ? error.name : typeof error;
    return /^[A-Za-z0-9_.$]{1,80}$/.test(name) ? name : 'Error';
  }

  private integer(key: string, fallback: number, min: number, max: number): number {
    const raw = this.config.get<string>(key)?.toString().trim();
    const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min) return fallback;
    return Math.min(parsed, max);
  }
}
