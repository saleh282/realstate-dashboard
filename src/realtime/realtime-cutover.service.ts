import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { OutboxAggregateType } from '../outbox/outbox-events';
import { REALTIME_CONSUMER_NAME, REALTIME_CUTOVER_MAX_AGGREGATES } from './realtime.constants';
import { REALTIME_CUTOVER_STORE, RealtimeCutoverRecord, RealtimeCutoverStore } from './realtime-cutover.store';
import { RealtimeSettings } from './realtime.settings';

const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 60_000;
const AUCTION_ID = /^[a-f0-9]{24}$/;

/** The consumer asked whether an event is history before the cutover was known. It must not guess. */
export class RealtimeCutoverNotReadyError extends Error {
  constructor() {
    super('realtime cutover is not established yet');
    this.name = 'RealtimeCutoverNotReadyError';
  }
}

/** A persisted cutover that cannot be trusted. It is never repaired or replaced automatically: replacing it IS a new cutover. */
export class RealtimeCutoverInvalidError extends Error {
  constructor(reason: string) {
    super(`realtime cutover record is invalid: ${reason}`);
    this.name = 'RealtimeCutoverInvalidError';
  }
}

/** More auctions than one cutover document may carry. Permanent: retrying re-reads the same thing. */
export class RealtimeCutoverTooLargeError extends Error {
  constructor() {
    super('the outbox holds more auctions than one realtime cutover document can record');
    this.name = 'RealtimeCutoverTooLargeError';
  }
}

/** The three facts that identify an outbox event's place in its aggregate's stream. */
export interface CutoverEventRef {
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
}

/**
 * The persistent activation cutover of the `realtime` consumer (MAZAD-032 closure).
 *
 * WHY. The MAZAD-031 outbox derives what a consumer is owed from the committed events, so a consumer that registers late
 * — realtime, the first time it is enabled — is owed ALL history. For a durable consumer that is right. Realtime is an
 * ephemeral transport: telling connected clients about a bid accepted last month "as if it just happened" is wrong even
 * though the delivery is owed. This class answers one question for the consumer — "was this event already committed when
 * realtime was first activated?" — from durable database state, never from a clock.
 *
 * THE MECHANISM. The only commit-ordered quantity in the persistence model is the per-auction `aggregateVersion`: every
 * producer writes the Auction document (the serialisation point) BEFORE `OutboxService.recordRequired`, which assigns
 * `max + 1` inside the same transaction, so concurrent transactions on one auction serialise, versions are dense, and a
 * higher version was committed strictly after a lower one. (An event id's timestamp is NOT such a quantity: it comes from
 * the producing host's clock and is stamped at insert, before commit.) So at first activation the store READS, from
 * majority-committed data, the highest committed version of every auction — its MARK — and persists all marks in one
 * document, created once (`$setOnInsert`, first writer wins). Then, for an event `(auctionId, version)`:
 *
 *      history  ⇔  version ≤ mark(auctionId)          — it was committed before the marks were read
 *      live     ⇔  otherwise (higher version, or an auction with no mark)  — it was committed after
 *
 * THE RACE — a business transaction in flight while realtime is enabled. An uncommitted transaction's rows are invisible
 * to the read, so its event is not counted in any mark; when it commits it takes version mark+1 or higher (the version is
 * assigned in commit order) and is therefore LIVE, whatever its id or `occurredAt` say. A transaction that committed before
 * the read is counted and is history. There is no third case: the read sees the event or it does not. The one nuance runs
 * in the harmless direction: an event that commits AFTER the read but BEFORE the cutover document is persisted is live
 * although it precedes the persist — delivered (possibly already visible over HTTP), never suppressed.
 *
 * SAFETY. Every mark was read strictly BEFORE the document was persisted, so history ⊆ "committed before activation":
 * nothing committed after can ever be judged history, however long realtime is down afterwards. For history to also be
 * safe to withhold from a subscriber, that subscriber's HTTP read must reflect it: the gateway therefore refuses
 * subscriptions until the cutover is persisted (`ready`), so every subscriber reads HTTP after all marks were taken.
 *
 * CONVERGENCE. Concurrent first activations each read and then attempt the create-once write; exactly one document exists
 * afterwards and every process adopts it (a loser discards its own marks). A crash before the write persists nothing and
 * the next attempt reads afresh. A restart finds the document and reads nothing. Classification is a pure function of
 * `(auctionId, version)` and the persisted marks: identical on every retry, redelivery, restart and instance.
 *
 * WHAT IT DOES NOT TOUCH. The outbox: the event, the dispatcher, the late-registration guarantee and every other consumer
 * are unchanged; the only outbox access is that single read. A historical event still goes through the ordinary delivery
 * state machine (claimed, `deliver()` resolves, PROCESSED) — the consumer simply has nothing to publish for it.
 *
 * WHILE THE CUTOVER IS NOT KNOWN the consumer reports itself unconfigured (`ready === false`): the dispatcher skips it —
 * nothing is claimed, no attempt is burned, nothing can be dead-lettered because a cutover could not be read.
 */
@Injectable()
export class RealtimeCutoverService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeCutoverService.name);
  /** Opaque per-process id stored on the record this process establishes (diagnostics only). */
  readonly instanceId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private marks?: ReadonlyMap<string, number>;
  private inFlight?: Promise<boolean>;
  private timer?: NodeJS.Timeout;
  private failures = 0;
  private stopped = false;
  private permanentFailure = false;

  constructor(
    private readonly settings: RealtimeSettings,
    @Inject(REALTIME_CUTOVER_STORE) private readonly store: RealtimeCutoverStore,
  ) {}

  /** True once the persisted cutover is known to this process. */
  get ready(): boolean {
    return this.marks !== undefined;
  }

  /** Number of auctions the cutover recorded (diagnostics). */
  get aggregateCount(): number | undefined {
    return this.marks?.size;
  }

  /** A process that does not run realtime never reads or writes the cutover. */
  onApplicationBootstrap(): void {
    if (!this.settings.enabled) return;
    void this.keepTrying();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * One attempt to learn — or, the first time ever, take and establish — the cutover. Resolves true when it is known,
   * false when the store could not be reached or the record is unusable (logged; never throws).
   */
  activate(): Promise<boolean> {
    if (this.marks) return Promise.resolve(true);
    this.inFlight ??= this.attempt().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  /** True when the event was already committed when realtime was first activated. Throws until the cutover is known. */
  isHistorical(event: CutoverEventRef): boolean {
    if (!this.marks) throw new RealtimeCutoverNotReadyError();
    if (event.aggregateType !== OutboxAggregateType.AUCTION) return false;
    const mark = this.marks.get(event.aggregateId);
    return mark !== undefined && event.aggregateVersion <= mark;
  }

  private async keepTrying(): Promise<void> {
    if (this.stopped || this.marks || this.permanentFailure) return;
    if (await this.activate()) return;
    if (this.permanentFailure) return;
    const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(Math.max(this.failures - 1, 0), 10)); // 2 s, 4 s, … capped at 60 s
    this.timer = setTimeout(() => void this.keepTrying(), delay);
    this.timer.unref?.();
  }

  private async attempt(): Promise<boolean> {
    try {
      let persisted = await this.store.find(REALTIME_CONSUMER_NAME);
      if (!persisted) {
        // ORDER IS THE WHOLE POINT: the marks are read from committed state FIRST and persisted AFTER, so every mark
        // precedes the moment the cutover exists. A retry re-reads; nothing from a failed attempt survives.
        const marks = await this.store.readCommittedHighWaterMarks();
        const aggregateCount = Object.keys(marks).length;
        if (aggregateCount > REALTIME_CUTOVER_MAX_AGGREGATES) throw new RealtimeCutoverTooLargeError();
        persisted = await this.store.establish({ consumer: REALTIME_CONSUMER_NAME, marks, aggregateCount, establishedBy: this.instanceId });
      }
      this.marks = this.validated(persisted);
      this.failures = 0;
      this.logger.log(JSON.stringify({
        event: persisted.establishedBy === this.instanceId ? 'realtime_cutover_established' : 'realtime_cutover_loaded',
        aggregates: this.marks.size,
      }));
      return true;
    } catch (error) {
      this.failures += 1;
      this.permanentFailure = error instanceof RealtimeCutoverTooLargeError;
      // Class only: never a message (it can carry connection strings).
      this.logger.error(JSON.stringify({
        event: 'realtime_cutover_unavailable',
        errorName: error instanceof Error ? error.name : typeof error,
        permanent: this.permanentFailure,
        note: 'the realtime consumer stays unconfigured (nothing is claimed) until the cutover is known',
      }));
      return false;
    }
  }

  private validated(record: RealtimeCutoverRecord): ReadonlyMap<string, number> {
    if (!record || record.consumer !== REALTIME_CONSUMER_NAME) throw new RealtimeCutoverInvalidError('wrong consumer');
    const raw = record.marks;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RealtimeCutoverInvalidError('marks are not a map');
    const marks = new Map<string, number>();
    for (const [auctionId, version] of Object.entries(raw)) {
      if (!AUCTION_ID.test(auctionId) || !Number.isSafeInteger(version) || version < 1) throw new RealtimeCutoverInvalidError('unreadable mark');
      marks.set(auctionId, version);
    }
    if (marks.size !== record.aggregateCount) throw new RealtimeCutoverInvalidError('mark count does not match the record');
    return marks;
  }
}
