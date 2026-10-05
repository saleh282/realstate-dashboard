'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
const {
  NotificationTargetType,
  NotificationType,
} = require('../domain/notifications/notification.types');
class NotificationTargetValue {}
const NotificationTargetSchema = new mongooseSchema(
  {
    type: { type: String, required: true, enum: Object.values(NotificationTargetType) },
    id: { type: String, required: true, match: /^[a-f0-9]{24}$/ },
  },
  { _id: false, versionKey: false },
);
/** One immutable inbox item for one account. Only `readAt` is customer-mutable. */
class Notification {}
const NotificationSchema = new mongooseSchema(
  {
    recipientAccountId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'User',
      required: true,
      immutable: true,
    },
    type: { type: String, required: true, immutable: true, enum: Object.values(NotificationType) },
    schemaVersion: { type: Number, required: true, immutable: true, min: 1 },
    sourceEventId: { type: String, required: true, immutable: true, match: /^[a-f0-9]{24}$/ },
    aggregateType: { type: String, required: true, immutable: true },
    aggregateId: { type: String, required: true, immutable: true, match: /^[a-f0-9]{24}$/ },
    required: { type: Boolean, required: true, immutable: true },
    title: { type: String, required: true, immutable: true, maxlength: 120 },
    message: { type: String, required: true, immutable: true, maxlength: 500 },
    target: { type: NotificationTargetSchema, required: true, immutable: true },
    createdAt: { type: Date, required: true, immutable: true },
    readAt: { type: Date },
  },
  { collection: 'notifications', versionKey: false },
);
const NOTIFICATION_DEDUP_INDEX = 'notification_source_recipient_type_unique';
NotificationSchema.index(
  { sourceEventId: 1, recipientAccountId: 1, type: 1 },
  { unique: true, name: NOTIFICATION_DEDUP_INDEX },
);
NotificationSchema.index(
  { recipientAccountId: 1, createdAt: -1, _id: -1 },
  { name: 'notification_recipient_created' },
);
NotificationSchema.index(
  { recipientAccountId: 1, readAt: 1, createdAt: -1 },
  { name: 'notification_recipient_read_created' },
);

Object.assign(exports, {
  NotificationTargetValue,
  Notification,
  NotificationSchema,
  NOTIFICATION_DEDUP_INDEX,
});
