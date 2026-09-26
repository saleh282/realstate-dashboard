import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { NotificationChannel, NotificationDeliveryStatus } from '../notification.types';

export type NotificationDeliveryDocument = HydratedDocument<NotificationDelivery>;

/** IN_APP delivered means the inbox row exists; it makes no push/email/SMS claim. */
@Schema({ collection: 'notification_deliveries', versionKey: false })
export class NotificationDelivery {
  @Prop({ type: Types.ObjectId, ref: 'Notification', required: true, immutable: true }) notificationId: Types.ObjectId;
  @Prop({ type: String, required: true, immutable: true, enum: Object.values(NotificationChannel) }) channel: NotificationChannel;
  @Prop({ type: String, required: true, enum: Object.values(NotificationDeliveryStatus) }) status: NotificationDeliveryStatus;
  @Prop({ type: Number, required: true, min: 1 }) attempts: number;
  @Prop({ type: Date, required: true }) lastAttemptAt: Date;
  @Prop({ type: Date, required: true }) deliveredAt: Date;
  @Prop({ type: Date, required: true, immutable: true }) createdAt: Date;
}

export const NotificationDeliverySchema = SchemaFactory.createForClass(NotificationDelivery);
export const NOTIFICATION_DELIVERY_UNIQUE_INDEX = 'notification_delivery_channel_unique';
NotificationDeliverySchema.index({ notificationId: 1, channel: 1 }, { unique: true, name: NOTIFICATION_DELIVERY_UNIQUE_INDEX });
