'use strict';

const { Types } = require('mongoose');
const { runTransactionWithRetry } = require('../common/mongo/transaction-runner');
const {
  mapNotificationEvent,
  NOTIFICATION_SUBSCRIBED_EVENT_TYPES,
} = require('../domain/notifications/notification-event.mapper');
const { NOTIFICATION_DELIVERY_UNIQUE_INDEX } = require('../models/notification-delivery.model');
const { NOTIFICATION_DEDUP_INDEX } = require('../models/notification.model');
const {
  NotificationChannel,
  NotificationDeliveryStatus,
} = require('../domain/notifications/notification.types');
const NOTIFICATIONS_CONSUMER_NAME = 'notifications';
class NotificationsOutboxConsumer {
  constructor(registry, connection, notifications, deliveries) {
    this.registry = registry;
    this.connection = connection;
    this.notifications = notifications;
    this.deliveries = deliveries;
    this.name = NOTIFICATIONS_CONSUMER_NAME;
    this.subscribedTypes = NOTIFICATION_SUBSCRIBED_EVENT_TYPES;
    this.configured = true;
  }
  onModuleInit() {
    this.registry.register(this);
  }
  async deliver(event) {
    const drafts = mapNotificationEvent(event);
    await runTransactionWithRetry(
      this.connection,
      async (session) => {
        for (const draft of drafts) {
          const notification = await this.notifications
            .findOneAndUpdate(
              {
                sourceEventId: draft.sourceEventId,
                recipientAccountId: new Types.ObjectId(draft.recipientAccountId),
                type: draft.type,
              },
              {
                $setOnInsert: {
                  ...draft,
                  recipientAccountId: new Types.ObjectId(draft.recipientAccountId),
                },
              },
              { upsert: true, new: true, session, setDefaultsOnInsert: true },
            )
            .exec();
          if (!notification) throw new Error('notification upsert did not return a row');
          await this.deliveries
            .updateOne(
              { notificationId: notification._id, channel: NotificationChannel.IN_APP },
              {
                $setOnInsert: {
                  notificationId: notification._id,
                  channel: NotificationChannel.IN_APP,
                  status: NotificationDeliveryStatus.DELIVERED,
                  attempts: 1,
                  lastAttemptAt: draft.createdAt,
                  deliveredAt: draft.createdAt,
                  createdAt: draft.createdAt,
                },
              },
              { upsert: true, session },
            )
            .exec();
        }
      },
      {
        uniqueIndexNames: [NOTIFICATION_DEDUP_INDEX, NOTIFICATION_DELIVERY_UNIQUE_INDEX],
        retryExhausted: () => new Error('notification transaction retry exhausted'),
      },
    );
  }
}

Object.assign(exports, { NOTIFICATIONS_CONSUMER_NAME, NotificationsOutboxConsumer });
