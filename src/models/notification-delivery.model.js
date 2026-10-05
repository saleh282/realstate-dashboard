'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
const {
  NotificationChannel,
  NotificationDeliveryStatus,
} = require('../domain/notifications/notification.types');
/** IN_APP delivered means the inbox row exists; it makes no push/email/SMS claim. */
class NotificationDelivery {}
const NotificationDeliverySchema = new mongooseSchema(
  {
    notificationId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'Notification',
      required: true,
      immutable: true,
    },
    channel: {
      type: String,
      required: true,
      immutable: true,
      enum: Object.values(NotificationChannel),
    },
    status: { type: String, required: true, enum: Object.values(NotificationDeliveryStatus) },
    attempts: { type: Number, required: true, min: 1 },
    lastAttemptAt: { type: Date, required: true },
    deliveredAt: { type: Date, required: true },
    createdAt: { type: Date, required: true, immutable: true },
  },
  { collection: 'notification_deliveries', versionKey: false },
);
const NOTIFICATION_DELIVERY_UNIQUE_INDEX = 'notification_delivery_channel_unique';
NotificationDeliverySchema.index(
  { notificationId: 1, channel: 1 },
  { unique: true, name: NOTIFICATION_DELIVERY_UNIQUE_INDEX },
);

Object.assign(exports, {
  NotificationDelivery,
  NotificationDeliverySchema,
  NOTIFICATION_DELIVERY_UNIQUE_INDEX,
});
