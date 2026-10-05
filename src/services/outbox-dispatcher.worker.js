'use strict';

const { Logger } = require('../common/logging/logger');
const DEFAULT_INTERVAL_SECONDS = 5;
const MIN_INTERVAL_SECONDS = 1;
const STOP_WAIT_MS = 10_000;
/**
 * Periodically runs `OutboxDispatcherService.dispatchConsumer` for EVERY
 * registered consumer (MAZAD-031). Same shape as the lifecycle/finalization
 * workers — one timer chain, in-process re-entrancy guards, a staggered start —
 * but correctness NEVER depends on the guards: the dispatcher claims each
 * delivery with an atomic, lease-protected database write, so any number of
 * overlapping instances is safe.
 *
 * Consumers are independent here too: each has its OWN in-flight guard, and a
 * tick starts a pass for every consumer that is not already running one without
 * waiting for the others. A slow or failing consumer therefore only delays
 * itself; a fast one keeps its own cadence.
 *
 * With no consumer registered (the state until MAZAD-032/036) a tick does
 * nothing at all — no database access — and events stay durable. Nothing is ever
 * marked delivered just because nobody was listening. Consumers may register at
 * any point before or after start-up; each tick reads the current registry.
 *
 * WAKE-UP. Besides the periodic tick, an `OutboxWakeup`
 * notification (sent by a producer after its transaction COMMITTED) starts a pass
 * immediately for every configured consumer. A notification that arrives while a
 * consumer's pass is running marks it "run again": when the pass ends, one more
 * pass starts, so an event committed after the running pass scanned is not left
 * for the next tick. Many notifications during one pass collapse into one re-run.
 * This only changes WHEN a pass runs, never what it delivers: the periodic tick
 * stays the durability guarantee, and the database claim stays the only guard.
 */
class OutboxDispatcherWorker {
  constructor(dispatcher, registry, config, wakeup) {
    this.dispatcher = dispatcher;
    this.registry = registry;
    this.config = config;
    this.wakeup = wakeup;
    this.logger = new Logger(OutboxDispatcherWorker.name);
    this.inFlight = new Map();
    this.stopped = false;
    this.started = false;
    /** Consumers notified while their pass was running: they get one more pass when it ends. */
    this.rerun = new Set();
    /** Latest summary per consumer. */
    this.lastSummaries = new Map();
  }
  get enabled() {
    const raw = this.config.get('OUTBOX_DISPATCHER_ENABLED')?.toString().trim().toLowerCase();
    if (raw) return raw === 'true';
    return this.config.get('NODE_ENV') !== 'test';
  }
  get intervalMs() {
    return (
      Math.max(
        this.integer('OUTBOX_DISPATCHER_INTERVAL_SECONDS', DEFAULT_INTERVAL_SECONDS),
        MIN_INTERVAL_SECONDS,
      ) * 1000
    );
  }
  onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.log('Outbox dispatcher disabled (OUTBOX_DISPATCHER_ENABLED=false)');
      return;
    }
    if (this.registry.list().length === 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'outbox_no_consumers_registered',
          note: 'domain events stay durable until a consumer registers',
        }),
      );
    }
    this.started = true;
    this.unsubscribeWakeup = this.wakeup?.subscribe(() => this.onWakeup());
    this.schedule(1_000 + Math.floor(Math.random() * 2_000));
  }
  /** A producer committed outbox events: dispatch now (or right after the running pass). */
  onWakeup() {
    if (this.stopped || !this.started) return;
    for (const consumer of this.registry.list()) {
      if (consumer.configured !== true) continue;
      if (this.inFlight.has(consumer.name)) this.rerun.add(consumer.name);
      else this.startPass(consumer.name);
    }
  }
  async onModuleDestroy() {
    this.stopped = true;
    this.unsubscribeWakeup?.();
    this.rerun.clear();
    if (this.timer) clearTimeout(this.timer);
    if (this.inFlight.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.inFlight.values()]),
      new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref()),
    ]);
  }
  /**
   * Starts one pass for every configured consumer that is not already running one and waits for those passes.
   * Returns the summaries of the passes it started, keyed by consumer name (a failed pass is `null`).
   */
  async runOnce() {
    const started = this.startPasses();
    const results = {};
    await Promise.all(
      [...started].map(async ([name, pass]) => {
        results[name] = await pass;
      }),
    );
    return results;
  }
  /** Runs one pass for a single consumer. Returns null when that consumer is already running one or the pass failed. */
  async runConsumerOnce(name) {
    const pass = this.startPass(name);
    return pass ? pass : null;
  }
  startPasses() {
    const started = new Map();
    for (const consumer of this.registry.list()) {
      if (consumer.configured !== true) continue;
      const pass = this.startPass(consumer.name);
      if (pass) started.set(consumer.name, pass);
    }
    return started;
  }
  startPass(name) {
    if (this.inFlight.has(name)) return null;
    const pass = this.execute(name).finally(() => {
      this.inFlight.delete(name);
      // A wake-up arrived during this pass: the event it announced may have committed after the scan.
      if (this.rerun.delete(name) && !this.stopped) this.startPass(name);
    });
    this.inFlight.set(name, pass);
    return pass;
  }
  schedule(delayMs) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.startPasses(); // fire-and-forget: the tick never waits for a slow consumer
      this.schedule(this.intervalMs);
    }, delayMs);
    this.timer.unref();
  }
  async execute(name) {
    try {
      const summary = await this.dispatcher.dispatchConsumer(name);
      this.lastRunAt = new Date();
      this.lastSummaries.set(name, summary);
      // Quiet on a no-op tick.
      if (summary.delivered || summary.retried || summary.deadLettered || summary.unconfirmed) {
        this.logger.log(JSON.stringify({ event: 'outbox_dispatch_run', ...summary }));
      }
      return summary;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'outbox_dispatch_run_failed',
          consumer: name,
          errorName: error instanceof Error ? error.name : typeof error,
        }),
      );
      return null;
    }
  }
  integer(key, fallback) {
    const raw = this.config.get(key)?.toString().trim();
    const parsed = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}

Object.assign(exports, { OutboxDispatcherWorker });
