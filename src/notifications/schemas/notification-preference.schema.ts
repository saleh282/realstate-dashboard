import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { DEFAULT_NOTIFICATION_PREFERENCES, NotificationPreferenceMode } from '../notification.types';

export type NotificationPreferenceDocument = HydratedDocument<NotificationPreference>;

/**
 * V1 optional broker-opportunity modes. Required transactional inbox records
 * are not represented here and cannot be disabled. DAILY_DIGEST is post-V1.
 */
@Schema({ collection: 'notification_preferences', timestamps: true, versionKey: false })
export class NotificationPreference {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true }) recipientAccountId: Types.ObjectId;
  @Prop({ type: String, required: true, enum: Object.values(NotificationPreferenceMode), default: DEFAULT_NOTIFICATION_PREFERENCES.newPropertyAlerts })
  newPropertyAlerts: NotificationPreferenceMode;
}

export const NotificationPreferenceSchema = SchemaFactory.createForClass(NotificationPreference);
NotificationPreferenceSchema.index({ recipientAccountId: 1 }, { unique: true, name: 'notification_preference_recipient_unique' });
