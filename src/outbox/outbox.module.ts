import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClockService } from '../common/time/clock.service';
import { OutboxConsumerRegistry } from './outbox-consumer.port';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { OutboxDispatcherWorker } from './outbox-dispatcher.worker';
import { OutboxService } from './outbox.service';
import { OutboxWakeup } from './outbox-wakeup';
import { OutboxEvent, OutboxEventSchema } from './schemas/outbox-event.schema';

/**
 * Transactional outbox foundation (MAZAD-031). Internal only: no controller,
 * no realtime, no notification. Producers (auction lifecycle, bid acceptance,
 * finalization, payment confirmation) import this module and call
 * `OutboxService.recordRequired` inside their own transaction; they know nothing
 * about consumers.
 *
 * Consumers (MAZAD-032 realtime, MAZAD-036 notifications, …) are independent:
 * each registers itself with the exported `OutboxConsumerRegistry` from its own
 * module (`onModuleInit`) under a stable name and a list of subscribed event
 * types, and gets its own delivery progress per event. Adding one requires no
 * change here, in any producer, or in any other consumer. When no feature
 * consumer is registered, committed events remain durable and undispatched.
 * Delivery is at-least-once per consumer; consumers deduplicate by event id.
 *
 * `OutboxWakeup` (exported) lets a producer hint, AFTER its commit, that events are
 * waiting, so the worker dispatches at once instead of at the next tick. Optimisation only.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: OutboxEvent.name, schema: OutboxEventSchema }])],
  providers: [ClockService, OutboxService, OutboxWakeup, OutboxConsumerRegistry, OutboxDispatcherService, OutboxDispatcherWorker],
  exports: [OutboxService, OutboxWakeup, OutboxConsumerRegistry],
})
export class OutboxModule {}
