import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ClockService } from '../common/time/clock.service';
import { OutboxConsumerRegistry } from './outbox-consumer.port';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { OutboxDispatcherWorker } from './outbox-dispatcher.worker';
import { OutboxService } from './outbox.service';
import { OutboxWakeup } from './outbox-wakeup';
import { OutboxEvent, OutboxEventSchema } from './schemas/outbox-event.schema';

/** Shared transactional events for property moderation, KYC and managed-marketing payments. Consumers register independently and deduplicate by event ID. */
@Module({
  imports: [MongooseModule.forFeature([{ name: OutboxEvent.name, schema: OutboxEventSchema }])],
  providers: [ClockService, OutboxService, OutboxWakeup, OutboxConsumerRegistry, OutboxDispatcherService, OutboxDispatcherWorker],
  exports: [OutboxService, OutboxWakeup, OutboxConsumerRegistry],
})
export class OutboxModule {}
