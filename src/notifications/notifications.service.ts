import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { NotificationErrorCode } from '../common/errors/notification-error-codes';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { DEFAULT_NOTIFICATION_PREFERENCES, NotificationPreferenceMode } from './notification.types';
import { NotificationPreference, NotificationPreferenceDocument } from './schemas/notification-preference.schema';
import { Notification, NotificationDocument } from './schemas/notification.schema';

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name) private readonly notifications: Model<NotificationDocument>,
    @InjectModel(NotificationPreference.name) private readonly preferences: Model<NotificationPreferenceDocument>,
  ) {}

  async list(recipientAccountId: string, query: ListNotificationsDto = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const filter: Record<string, unknown> = { recipientAccountId: new Types.ObjectId(recipientAccountId) };
    if (query.unread === true) filter.readAt = { $exists: false };
    if (query.unread === false) filter.readAt = { $exists: true };
    const [rows, total] = await Promise.all([
      this.notifications.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.notifications.countDocuments(filter).exec(),
    ]);
    return { items: rows.map((row) => this.project(row)), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async unreadCount(recipientAccountId: string) {
    const count = await this.notifications.countDocuments({ recipientAccountId: new Types.ObjectId(recipientAccountId), readAt: { $exists: false } }).exec();
    return { count };
  }

  async markRead(recipientAccountId: string, notificationId: string) {
    this.assertId(notificationId);
    const recipient = new Types.ObjectId(recipientAccountId);
    const id = new Types.ObjectId(notificationId);
    let row = await this.notifications.findOneAndUpdate(
      { _id: id, recipientAccountId: recipient, readAt: { $exists: false } },
      { $set: { readAt: new Date() } },
      { new: true },
    ).lean().exec();
    if (!row) row = await this.notifications.findOne({ _id: id, recipientAccountId: recipient }).lean().exec();
    if (!row) this.notFound();
    return { notification: this.project(row!) };
  }

  async markAllRead(recipientAccountId: string) {
    const result = await this.notifications.updateMany(
      { recipientAccountId: new Types.ObjectId(recipientAccountId), readAt: { $exists: false } },
      { $set: { readAt: new Date() } },
    ).exec();
    return { updatedCount: result.modifiedCount };
  }

  async getPreferences(recipientAccountId: string) {
    const row = await this.preferences.findOne({ recipientAccountId: new Types.ObjectId(recipientAccountId) }).lean().exec();
    return row ? this.projectPreferences(row) : { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }

  async updatePreferences(recipientAccountId: string, dto: UpdateNotificationPreferencesDto) {
    const update = Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined));
    if (Object.keys(update).length === 0) throw new BadRequestException({ message: 'يجب إرسال تفضيل واحد على الأقل', code: NotificationErrorCode.PREFERENCE_INVALID });
    const insertDefaults = Object.fromEntries(
      Object.entries(DEFAULT_NOTIFICATION_PREFERENCES).filter(([key]) => !Object.prototype.hasOwnProperty.call(update, key)),
    );
    const row = await this.preferences.findOneAndUpdate(
      { recipientAccountId: new Types.ObjectId(recipientAccountId) },
      { $set: update, $setOnInsert: { recipientAccountId: new Types.ObjectId(recipientAccountId), ...insertDefaults } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean().exec();
    return this.projectPreferences(row!);
  }

  private project(row: any) {
    return { id: row._id.toString(), type: row.type, schemaVersion: row.schemaVersion, required: row.required, title: row.title, message: row.message, target: { type: row.target.type, id: row.target.id }, createdAt: row.createdAt, readAt: row.readAt ?? null, isRead: Boolean(row.readAt) };
  }

  private projectPreferences(row: any): { newPropertyAlerts: NotificationPreferenceMode; auctionOpportunityAlerts: NotificationPreferenceMode } {
    return { newPropertyAlerts: row.newPropertyAlerts, auctionOpportunityAlerts: row.auctionOpportunityAlerts };
  }

  private assertId(value: string): void {
    if (!Types.ObjectId.isValid(value)) throw new BadRequestException({ message: 'معرّف الإشعار غير صالح', code: NotificationErrorCode.ID_INVALID });
  }

  private notFound(): never {
    throw new NotFoundException({ message: 'الإشعار غير موجود', code: NotificationErrorCode.NOT_FOUND });
  }
}
