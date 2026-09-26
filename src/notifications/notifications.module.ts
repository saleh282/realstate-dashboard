import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { OutboxModule } from '../outbox/outbox.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsOutboxConsumer } from './notifications-outbox.consumer';
import { NotificationsService } from './notifications.service';
import { NotificationDelivery, NotificationDeliverySchema } from './schemas/notification-delivery.schema';
import { NotificationPreference, NotificationPreferenceSchema } from './schemas/notification-preference.schema';
import { Notification, NotificationSchema } from './schemas/notification.schema';

@Module({
  imports: [PassportModule, OutboxModule, MongooseModule.forFeature([
    { name: Notification.name, schema: NotificationSchema },
    { name: NotificationDelivery.name, schema: NotificationDeliverySchema },
    { name: NotificationPreference.name, schema: NotificationPreferenceSchema },
  ])],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsOutboxConsumer],
  exports: [NotificationsService],
})
export class NotificationsModule {}
