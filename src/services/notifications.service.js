'use strict';

const { BadRequestException, NotFoundException } = require('../common/http/errors');
const { Types } = require('mongoose');
const { NotificationErrorCode } = require('../common/errors/notification-error-codes');
const {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationType,
} = require('../domain/notifications/notification.types');
class NotificationsService {
  constructor(notifications, preferences) {
    this.notifications = notifications;
    this.preferences = preferences;
  }
  async list(recipientAccountId, query = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const filter = this.inboxFilter(recipientAccountId);
    if (query.unread === true) filter.readAt = { $exists: false };
    if (query.unread === false) filter.readAt = { $exists: true };
    const [rows, total] = await Promise.all([
      this.notifications
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.notifications.countDocuments(filter).exec(),
    ]);
    return {
      items: rows.map((row) => this.project(row)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
  async unreadCount(recipientAccountId) {
    const count = await this.notifications
      .countDocuments({ ...this.inboxFilter(recipientAccountId), readAt: { $exists: false } })
      .exec();
    return { count };
  }
  async markRead(recipientAccountId, notificationId) {
    this.assertId(notificationId);
    const id = new Types.ObjectId(notificationId);
    let row = await this.notifications
      .findOneAndUpdate(
        { _id: id, ...this.inboxFilter(recipientAccountId), readAt: { $exists: false } },
        { $set: { readAt: new Date() } },
        { new: true },
      )
      .lean()
      .exec();
    if (!row)
      row = await this.notifications
        .findOne({ _id: id, ...this.inboxFilter(recipientAccountId) })
        .lean()
        .exec();
    if (!row) this.notFound();
    return { notification: this.project(row) };
  }
  async markAllRead(recipientAccountId) {
    const result = await this.notifications
      .updateMany(
        { ...this.inboxFilter(recipientAccountId), readAt: { $exists: false } },
        { $set: { readAt: new Date() } },
      )
      .exec();
    return { updatedCount: result.modifiedCount };
  }
  async getPreferences(recipientAccountId) {
    const row = await this.preferences
      .findOne({ recipientAccountId: new Types.ObjectId(recipientAccountId) })
      .lean()
      .exec();
    return row ? this.projectPreferences(row) : { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }
  async updatePreferences(recipientAccountId, dto) {
    const update = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(update).length === 0)
      throw new BadRequestException({
        message: 'يجب إرسال تفضيل واحد على الأقل',
        code: NotificationErrorCode.PREFERENCE_INVALID,
      });
    const insertDefaults = Object.fromEntries(
      Object.entries(DEFAULT_NOTIFICATION_PREFERENCES).filter(
        ([key]) => !Object.prototype.hasOwnProperty.call(update, key),
      ),
    );
    const row = await this.preferences
      .findOneAndUpdate(
        { recipientAccountId: new Types.ObjectId(recipientAccountId) },
        {
          $set: update,
          $setOnInsert: {
            recipientAccountId: new Types.ObjectId(recipientAccountId),
            ...insertDefaults,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .lean()
      .exec();
    return this.projectPreferences(row);
  }
  inboxFilter(recipientAccountId) {
    return {
      recipientAccountId: new Types.ObjectId(recipientAccountId),
      type: { $in: Object.values(NotificationType) },
    };
  }
  project(row) {
    return {
      id: row._id.toString(),
      type: row.type,
      schemaVersion: row.schemaVersion,
      required: row.required,
      title: row.title,
      message: row.message,
      target: { type: row.target.type, id: row.target.id },
      createdAt: row.createdAt,
      readAt: row.readAt ?? null,
      isRead: Boolean(row.readAt),
    };
  }
  projectPreferences(row) {
    return { newPropertyAlerts: row.newPropertyAlerts };
  }
  assertId(value) {
    if (!Types.ObjectId.isValid(value))
      throw new BadRequestException({
        message: 'معرّف الإشعار غير صالح',
        code: NotificationErrorCode.ID_INVALID,
      });
  }
  notFound() {
    throw new NotFoundException({
      message: 'الإشعار غير موجود',
      code: NotificationErrorCode.NOT_FOUND,
    });
  }
}

Object.assign(exports, { NotificationsService });
