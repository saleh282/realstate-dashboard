import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { runTransactionWithRetry } from '../common/mongo/transaction-runner';
import { OutboxConsumerRegistry, OutboxDeliveryEvent, OutboxEventConsumer } from '../outbox/outbox-consumer.port';
import { OutboxEventType } from '../outbox/outbox-events';
import { mapNotificationEvent, NOTIFICATION_SUBSCRIBED_EVENT_TYPES } from './notification-event.mapper';
import { NotificationDelivery, NotificationDeliveryDocument, NOTIFICATION_DELIVERY_UNIQUE_INDEX } from './schemas/notification-delivery.schema';
import { Notification, NotificationDocument, NOTIFICATION_DEDUP_INDEX } from './schemas/notification.schema';
import { NotificationChannel, NotificationDeliveryStatus } from './notification.types';

export const NOTIFICATIONS_CONSUMER_NAME = 'notifications';

@Injectable()
export class NotificationsOutboxConsumer implements OutboxEventConsumer, OnModuleInit {
  readonly name = NOTIFICATIONS_CONSUMER_NAME;
  readonly subscribedTypes: readonly OutboxEventType[] = NOTIFICATION_SUBSCRIBED_EVENT_TYPES;
  readonly configured = true;

  constructor(
    private readonly registry: OutboxConsumerRegistry,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Notification.name) private readonly notifications: Model<NotificationDocument>,
    @InjectModel(NotificationDelivery.name) private readonly deliveries: Model<NotificationDeliveryDocument>,
  ) {}

  onModuleInit(): void { this.registry.register(this); }

  async deliver(event: OutboxDeliveryEvent): Promise<void> {
    const drafts = mapNotificationEvent(event);
    await runTransactionWithRetry(this.connection, async (session) => {
      for (const draft of drafts) {
        const notification = await this.notifications.findOneAndUpdate(
          { sourceEventId: draft.sourceEventId, recipientAccountId: new Types.ObjectId(draft.recipientAccountId), type: draft.type },
          { $setOnInsert: { ...draft, recipientAccountId: new Types.ObjectId(draft.recipientAccountId) } },
          { upsert: true, new: true, session, setDefaultsOnInsert: true },
        ).exec();
        if (!notification) throw new Error('notification upsert did not return a row');
        await this.deliveries.updateOne(
          { notificationId: notification._id, channel: NotificationChannel.IN_APP },
          { $setOnInsert: { notificationId: notification._id, channel: NotificationChannel.IN_APP, status: NotificationDeliveryStatus.DELIVERED, attempts: 1, lastAttemptAt: draft.createdAt, deliveredAt: draft.createdAt, createdAt: draft.createdAt } },
          { upsert: true, session },
        ).exec();
      }
    }, {
      uniqueIndexNames: [NOTIFICATION_DEDUP_INDEX, NOTIFICATION_DELIVERY_UNIQUE_INDEX],
      retryExhausted: () => new Error('notification transaction retry exhausted'),
    });
  }
}
