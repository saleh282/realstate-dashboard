'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
const {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferenceMode,
} = require('../domain/notifications/notification.types');
/**
 * V1 optional broker-opportunity modes. Required transactional inbox records
 * are not represented here and cannot be disabled. DAILY_DIGEST is post-V1.
 */
class NotificationPreference {}
const NotificationPreferenceSchema = new mongooseSchema(
  {
    recipientAccountId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'User',
      required: true,
      immutable: true,
    },
    newPropertyAlerts: {
      type: String,
      required: true,
      enum: Object.values(NotificationPreferenceMode),
      default: DEFAULT_NOTIFICATION_PREFERENCES.newPropertyAlerts,
    },
  },
  { collection: 'notification_preferences', timestamps: true, versionKey: false },
);
NotificationPreferenceSchema.index(
  { recipientAccountId: 1 },
  { unique: true, name: 'notification_preference_recipient_unique' },
);

Object.assign(exports, { NotificationPreference, NotificationPreferenceSchema });
