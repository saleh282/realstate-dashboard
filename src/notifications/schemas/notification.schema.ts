import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { NotificationTargetType, NotificationType } from '../notification.types';

export type NotificationDocument = HydratedDocument<Notification>;

@Schema({ _id: false, versionKey: false })
export class NotificationTargetValue {
  @Prop({ type: String, required: true, enum: Object.values(NotificationTargetType) }) type: NotificationTargetType;
  @Prop({ type: String, required: true, match: /^[a-f0-9]{24}$/ }) id: string;
}

const NotificationTargetSchema = SchemaFactory.createForClass(NotificationTargetValue);

/** One immutable inbox item for one account. Only `readAt` is customer-mutable. */
@Schema({ collection: 'notifications', versionKey: false })
export class Notification {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true }) recipientAccountId: Types.ObjectId;
  @Prop({ type: String, required: true, immutable: true, enum: Object.values(NotificationType) }) type: NotificationType;
  @Prop({ type: Number, required: true, immutable: true, min: 1 }) schemaVersion: number;
  @Prop({ type: String, required: true, immutable: true, match: /^[a-f0-9]{24}$/ }) sourceEventId: string;
  @Prop({ type: String, required: true, immutable: true }) aggregateType: string;
  @Prop({ type: String, required: true, immutable: true, match: /^[a-f0-9]{24}$/ }) aggregateId: string;
  @Prop({ type: Boolean, required: true, immutable: true }) required: boolean;
  @Prop({ type: String, required: true, immutable: true, maxlength: 120 }) title: string;
  @Prop({ type: String, required: true, immutable: true, maxlength: 500 }) message: string;
  @Prop({ type: NotificationTargetSchema, required: true, immutable: true }) target: NotificationTargetValue;
  @Prop({ type: Date, required: true, immutable: true }) createdAt: Date;
  @Prop({ type: Date }) readAt?: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
export const NOTIFICATION_DEDUP_INDEX = 'notification_source_recipient_type_unique';
NotificationSchema.index({ sourceEventId: 1, recipientAccountId: 1, type: 1 }, { unique: true, name: NOTIFICATION_DEDUP_INDEX });
NotificationSchema.index({ recipientAccountId: 1, createdAt: -1, _id: -1 }, { name: 'notification_recipient_created' });
NotificationSchema.index({ recipientAccountId: 1, readAt: 1, createdAt: -1 }, { name: 'notification_recipient_read_created' });
