import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClockService } from '../common/time/clock.service';
import { OutboxConsumerRegistry, OutboxDeliveryEvent, OutboxEventConsumer } from '../outbox/outbox-consumer.port';
import { OutboxEventType } from '../outbox/outbox-events';
import { RealtimeAuctionAccess } from './realtime-auction-access';
import { RealtimeCutoverService } from './realtime-cutover.service';
import { REALTIME_SUBSCRIBED_EVENT_TYPES, toRealtimeEvent } from './realtime-events';
import { closedFrame } from './realtime-frames';
import { RealtimeHub } from './realtime.hub';
import { REALTIME_CONSUMER_NAME } from './realtime.constants';
import { RealtimeSettings } from './realtime.settings';

/**
 * The first real MAZAD-031 outbox consumer (MAZAD-032): committed auction
 * events → WebSocket rooms. Registered once, under the permanent name
 * `realtime`, from `onModuleInit`; it has no effect on any business
 * transaction, producer or other consumer, and never mutates or deletes an
 * outbox event (the dispatcher owns `delivery.realtime`).
 *
 * WHAT `deliver` RESOLVING MEANS (the outbox acknowledgement). The realtime
 * hub accepted the publish: the frame was handed to the send queue of every
 * currently subscribed, open socket (or nobody was subscribed, or this process
 * had already fanned that event out). It does NOT mean any client received it:
 * a disconnected or slow client recovers by resyncing over HTTP. Nothing waits
 * for a client to acknowledge. If the hub cannot accept (shutting down), or the
 * visibility check cannot be evaluated, `deliver` THROWS and the outbox retries
 * with backoff — the event is never acknowledged when it could not be published.
 *
 * ORDERING. The dispatcher awaits each delivery before the next one for the
 * same auction, and everything below is either awaited or synchronous, so
 * frames of one auction leave in `streamVersion` order. No cross-auction order.
 *
 * DUPLICATES. Outbox delivery is at-least-once. A repeat of an event this
 * process already fanned out is skipped by the hub (`DUPLICATE_OR_STALE`) and
 * acknowledged; whatever still reaches a client twice carries the same
 * `eventId`, which clients deduplicate on. There is no exactly-once claim.
 *
 * VISIBILITY. Subscribing checks the HTTP visibility gate; publishing checks it
 * AGAIN for every non-terminal event of a room that has members, because an
 * auction can stop being public without an outbox event (its property being
 * unpublished). If it stopped, the room is closed with a `closed` frame and the
 * event is acknowledged without being sent: a delivery whose only possible
 * audience is now forbidden has been dealt with correctly, and retrying would
 * only loop. Terminal events (no bids / cancelled / finalized) are sent to the
 * existing members — they are the notice that the public life ended and carry
 * nothing beyond what those members already saw — and then the room is closed.
 * A fresh subscription to a hidden auction is refused by the gate.
 *
 * HISTORY (the activation cutover). Under MAZAD-031 a consumer registered late is owed ALL history, and the first time
 * realtime is enabled that is every subscribed event ever committed. Realtime is an ephemeral transport, so those must
 * not be broadcast as if they just happened. `RealtimeCutoverService` holds a persisted cutover written once, at the
 * first activation: the highest COMMITTED `aggregateVersion` of every auction at that moment, read from the outbox — no
 * clock, no event-id timestamp. An event `(auctionId, version)` with `version <= mark` is HISTORY and `deliver` resolves
 * for it without publishing anything: the dispatcher records PROCESSED through its ordinary state machine, so history
 * reaches a terminal delivery state without any special path, bulk write or deletion. Any other event was committed
 * after the marks were read — including one whose transaction was in flight at that moment — and is never history,
 * however long realtime was down: it is delivered, in order, when realtime returns. Until the cutover is known the
 * consumer is not configured, so the dispatcher skips it and nothing is claimed or burned.
 */
@Injectable()
export class RealtimeOutboxConsumer implements OutboxEventConsumer, OnModuleInit {
  private readonly logger = new Logger(RealtimeOutboxConsumer.name);
  readonly name = REALTIME_CONSUMER_NAME;
  readonly subscribedTypes: readonly OutboxEventType[] = REALTIME_SUBSCRIBED_EVENT_TYPES;
  /** Historical events this process consumed without broadcasting (diagnostics; resets on restart). */
  historicalConsumed = 0;

  constructor(
    private readonly registry: OutboxConsumerRegistry,
    private readonly hub: RealtimeHub,
    private readonly access: RealtimeAuctionAccess,
    private readonly clock: ClockService,
    private readonly settings: RealtimeSettings,
    private readonly cutover: RealtimeCutoverService,
  ) {}

  /**
   * While realtime is off this instance neither accepts sockets nor claims `realtime` deliveries (they stay owed, durably).
   * It also waits for the activation cutover: without it the consumer cannot tell history from live, and must not guess.
   */
  get configured(): boolean {
    return this.settings.enabled && this.cutover.ready;
  }

  onModuleInit(): void {
    this.registry.register(this);
    const { level, entry } = this.settings.startupSummary();
    this.logger[level](JSON.stringify(entry));
  }

  async deliver(event: OutboxDeliveryEvent): Promise<void> {
    // Before anything else (mapping, visibility, hub): history is consumed, not broadcast. A pure function of the event's place
    // in its auction's stream and the persisted cutover, so a retry, a redelivery or another instance decides identically.
    // Throws if the cutover is unknown.
    if (this.cutover.isHistorical(event)) {
      this.historicalConsumed += 1;
      return;
    }
    // Validates and projects; anything that is not a well-formed public auction event is a PERMANENT failure (dead-letter, this consumer only).
    const frame = toRealtimeEvent(event, this.clock.now());
    const { auctionId } = frame;

    if (!frame.terminal && this.hub.hasSubscribers(auctionId) && !(await this.access.isPubliclyVisible(auctionId))) {
      const closed = this.hub.closeRoom(auctionId, closedFrame({ serverTime: this.clock.now(), auctionId }));
      this.logger.warn(JSON.stringify({ event: 'realtime_room_closed_not_visible', auctionId, members: closed }));
      return;
    }

    frame.serverTime = this.clock.now().toISOString(); // the reference for a client countdown: as close to the send as possible
    const result = this.hub.publish(auctionId, frame.streamVersion, frame);
    if (frame.terminal) this.hub.closeRoom(auctionId);
    if (result.dropped > 0) {
      this.logger.warn(JSON.stringify({ event: 'realtime_publish_dropped_connections', auctionId, eventType: frame.event, recipients: result.recipients, dropped: result.dropped }));
    }
  }
}
