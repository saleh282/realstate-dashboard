import { Injectable, Logger } from '@nestjs/common';

/**
 * In-process "an outbox event was just COMMITTED" hint .
 *
 * A pure latency optimisation on top of the MAZAD-031 outbox, never a delivery
 * mechanism: the event carries nothing and correctness never depends on it.
 *
 *  - Producers call `notify()` ONLY after their transaction committed (never from
 *    inside it, never on abort), so a pass it triggers can only find committed events.
 *  - The dispatcher worker listens and starts a pass at once for every consumer; if a
 *    pass is already running it records "run again" so an event committed during that
 *    pass is not left for the next periodic tick.
 *  - A lost, duplicated or unheard notification changes nothing about WHAT is delivered:
 *    the periodic tick still finds every owed event, and the lease-protected claim still
 *    decides who delivers it (no duplicate delivery, same per-aggregate order).
 *  - In-process only. A commit on another replica is picked up by the periodic tick of
 *    the consumer instance.
 */
@Injectable()
export class OutboxWakeup {
  private readonly logger = new Logger(OutboxWakeup.name);
  private readonly listeners = new Set<() => void>();
  /** Notifications received (diagnostics only). */
  notified = 0;

  /** Registers a listener; returns the function that removes it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Call after a transaction that recorded outbox events has COMMITTED. Never throws, never waits. */
  notify(): void {
    this.notified += 1;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        // A hint must never fail the business operation that already committed.
        this.logger.warn(JSON.stringify({ event: 'outbox_wakeup_listener_failed', errorName: error instanceof Error ? error.name : typeof error }));
      }
    }
  }
}
