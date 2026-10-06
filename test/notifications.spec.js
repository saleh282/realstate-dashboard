'use strict';

const { BadRequestException, NotFoundException } = require('../src/common/http/errors');
const { Types } = require('mongoose');
const { NotificationErrorCode } = require('../src/common/errors/notification-error-codes');
const {
  OutboxConsumerRegistry,
  OutboxPermanentDeliveryError,
} = require('../src/domain/outbox/outbox-consumer.port');
const { OutboxEventType, kycDecisionEvent } = require('../src/domain/outbox/outbox-events');
const {
  notificationValidation,
} = require('../src/validators/notifications/notification-validation.pipe');
const { ListNotificationsDto } = require('../src/validators/notifications/list-notifications.dto');
const {
  UpdateNotificationPreferencesDto,
} = require('../src/validators/notifications/update-notification-preferences.dto');
const {
  mapNotificationEvent,
  NOTIFICATION_SUBSCRIBED_EVENT_TYPES,
} = require('../src/domain/notifications/notification-event.mapper');
const { NotificationsOutboxConsumer } = require('../src/services/notifications-outbox.consumer');
const { NotificationsService } = require('../src/services/notifications.service');
const {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationChannel,
  NotificationPreferenceMode,
  NotificationTargetType,
  NotificationType,
} = require('../src/domain/notifications/notification.types');
const EVENT = '64b000000000000000000001';
const PROPERTY = '64b000000000000000000002';
const USER_A = '64b0000000000000000000a1';
const USER_B = '64b0000000000000000000b2';
const T0 = new Date('2026-09-26T10:00:00.000Z');
function delivery(draft, eventId = EVENT) {
  return { eventId, aggregateVersion: 1, attempt: 1, ...draft };
}
function approved() {
  return delivery(
    kycDecisionEvent({ accountId: USER_A, occurredAt: T0, decision: 'verified', kycVersion: 1 }),
  );
}
function consumerHarness() {
  const notificationRows = [];
  const deliveryRows = [];
  let notificationFailure;
  const notifications = {
    findOneAndUpdate: jest.fn((filter, update) => ({
      exec: async () => {
        if (notificationFailure) throw notificationFailure;
        let row = notificationRows.find(
          (item) =>
            item.sourceEventId === filter.sourceEventId &&
            item.recipientAccountId.toString() === filter.recipientAccountId.toString() &&
            item.type === filter.type,
        );
        if (!row) {
          row = { _id: new Types.ObjectId(), ...update.$setOnInsert };
          notificationRows.push(row);
        }
        return row;
      },
    })),
  };
  const deliveries = {
    updateOne: jest.fn((filter, update) => ({
      exec: async () => {
        const existing = deliveryRows.find(
          (item) =>
            item.notificationId.toString() === filter.notificationId.toString() &&
            item.channel === filter.channel,
        );
        if (!existing) deliveryRows.push({ ...update.$setOnInsert });
        return { acknowledged: true };
      },
    })),
  };
  const session = {
    active: false,
    startTransaction() {
      this.active = true;
    },
    inTransaction() {
      return this.active;
    },
    async commitTransaction() {
      this.active = false;
    },
    async abortTransaction() {
      this.active = false;
    },
    async endSession() {},
  };
  const connection = { startSession: jest.fn(async () => session) };
  const registry = new OutboxConsumerRegistry();
  const consumer = new NotificationsOutboxConsumer(registry, connection, notifications, deliveries);
  return {
    consumer,
    registry,
    notifications,
    deliveries,
    notificationRows,
    deliveryRows,
    failWith(error) {
      notificationFailure = error;
    },
  };
}
describe('notification event mapping and outbox consumer (MAZAD-036)', () => {
  it('registers exactly one independent consumer named notifications with only approved routable event types', () => {
    const ctx = consumerHarness();
    ctx.consumer.onModuleInit();
    expect(ctx.registry.list()).toEqual([ctx.consumer]);
    expect(ctx.consumer.name).toBe('notifications');
    expect(ctx.consumer.subscribedTypes).toEqual([
      OutboxEventType.KYC_APPROVED,
      OutboxEventType.KYC_REJECTED,
      OutboxEventType.LISTING_APPROVED,
      OutboxEventType.LISTING_REJECTED,
    ]);
    expect(ctx.consumer.subscribedTypes).toEqual(NOTIFICATION_SUBSCRIBED_EVENT_TYPES);
  });
  it('maps KYC decisions to their authoritative private subjects without exposing routing', () => {
    const kycApproved = mapNotificationEvent(
      delivery(
        kycDecisionEvent({
          accountId: USER_A,
          occurredAt: T0,
          decision: 'verified',
          kycVersion: 2,
        }),
      ),
    );
    const kycRejected = mapNotificationEvent(
      delivery(
        kycDecisionEvent({
          accountId: USER_A,
          occurredAt: T0,
          decision: 'rejected',
          kycVersion: 3,
        }),
      ),
    );
    expect(kycApproved[0]).toMatchObject({
      recipientAccountId: USER_A,
      type: NotificationType.KYC_APPROVED,
    });
    expect(kycRejected[0]).toMatchObject({
      recipientAccountId: USER_A,
      type: NotificationType.KYC_REJECTED,
    });
    expect(JSON.stringify([...kycApproved, ...kycRejected])).not.toMatch(
      /privateRouting|subjectAccountId|advertiserAccountId|rejectionReason/,
    );
  });
  it('permanently rejects missing private routing, unsupported versions and arbitrary target ids', () => {
    expect(() => mapNotificationEvent({ ...approved(), privateRouting: undefined })).toThrow(
      OutboxPermanentDeliveryError,
    );
    expect(() => mapNotificationEvent({ ...approved(), schemaVersion: 2 })).toThrow(
      OutboxPermanentDeliveryError,
    );
    expect(() => mapNotificationEvent({ ...approved(), occurredAt: new Date('invalid') })).toThrow(
      OutboxPermanentDeliveryError,
    );
    expect(() =>
      mapNotificationEvent({ ...approved(), aggregateId: 'https://evil.invalid' }),
    ).toThrow(OutboxPermanentDeliveryError);
  });
  it('duplicate and concurrent delivery converge on one inbox row and one IN_APP delivery row', async () => {
    const ctx = consumerHarness();
    await Promise.all([
      ctx.consumer.deliver(approved()),
      ctx.consumer.deliver(approved()),
      ctx.consumer.deliver(approved()),
    ]);
    expect(ctx.notificationRows).toHaveLength(1);
    expect(ctx.deliveryRows).toHaveLength(1);
    expect(ctx.deliveryRows[0].channel).toBe(NotificationChannel.IN_APP);
  });
  it('a storage failure rejects delivery for outbox retry, while a later unrelated event remains processable', async () => {
    const ctx = consumerHarness();
    ctx.failWith(new Error('database unavailable'));
    await expect(ctx.consumer.deliver(approved())).rejects.toThrow('database unavailable');
    expect(ctx.notificationRows).toHaveLength(0);
    ctx.failWith();
    await expect(
      ctx.consumer.deliver({ ...approved(), eventId: '64b000000000000000000006' }),
    ).resolves.toBeUndefined();
    expect(ctx.notificationRows).toHaveLength(1);
  });
});
function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = row[key];
    if (expected && typeof expected === 'object' && '$in' in expected)
      return expected.$in.includes(actual);
    if (expected && typeof expected === 'object' && '$exists' in expected)
      return expected.$exists ? actual !== undefined : actual === undefined;
    return actual?.toString?.() === expected?.toString?.();
  });
}
function query(value) {
  const chain = {
    sort: () => chain,
    skip: (count) => {
      chain.skipCount = count;
      return chain;
    },
    limit: (count) => {
      chain.limitCount = count;
      return chain;
    },
    lean: () => chain,
    exec: async () => {
      const result = value();
      return Array.isArray(result)
        ? result.slice(
            chain.skipCount ?? 0,
            (chain.skipCount ?? 0) + (chain.limitCount ?? result.length),
          )
        : result;
    },
  };
  return chain;
}
function serviceHarness() {
  const rows = [];
  const preferenceRows = [];
  const notifications = {
    find: jest.fn((filter) =>
      query(() =>
        rows
          .filter((row) => matches(row, filter))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      ),
    ),
    countDocuments: jest.fn((filter) => ({
      exec: async () => rows.filter((row) => matches(row, filter)).length,
    })),
    findOneAndUpdate: jest.fn((filter, update) =>
      query(() => {
        const row = rows.find((item) => matches(item, filter));
        if (row && update.$set) Object.assign(row, update.$set);
        return row ?? null;
      }),
    ),
    findOne: jest.fn((filter) => query(() => rows.find((row) => matches(row, filter)) ?? null)),
    updateMany: jest.fn((filter, update) => ({
      exec: async () => {
        const found = rows.filter((row) => matches(row, filter));
        found.forEach((row) => Object.assign(row, update.$set));
        return { modifiedCount: found.length };
      },
    })),
  };
  const preferences = {
    findOne: jest.fn((filter) =>
      query(() => preferenceRows.find((row) => matches(row, filter)) ?? null),
    ),
    findOneAndUpdate: jest.fn((filter, update) =>
      query(() => {
        let row = preferenceRows.find((item) => matches(item, filter));
        if (!row) {
          row = { _id: new Types.ObjectId(), ...update.$setOnInsert };
          preferenceRows.push(row);
        }
        Object.assign(row, update.$set);
        return row;
      }),
    ),
  };
  return { service: new NotificationsService(notifications, preferences), rows, preferenceRows };
}
function inboxRow(recipient, createdAt, readAt) {
  return {
    _id: new Types.ObjectId(),
    recipientAccountId: new Types.ObjectId(recipient),
    type: NotificationType.KYC_APPROVED,
    schemaVersion: 1,
    required: true,
    title: 'عنوان',
    message: 'رسالة',
    target: { type: NotificationTargetType.KYC, id: PROPERTY },
    createdAt,
    ...(readAt ? { readAt } : {}),
  };
}
describe('notification inbox, isolation and preferences (MAZAD-036)', () => {
  it('excludes retained records of removed notification types from reads, counts and updates', async () => {
    const ctx = serviceHarness();
    const retired = {
      ...inboxRow(USER_A, T0),
      type: 'AUCTION_WON',
      target: { type: 'AUCTION', id: PROPERTY },
    };
    const current = inboxRow(USER_A, T0);
    ctx.rows.push(retired, current);
    const result = await ctx.service.list(USER_A);
    expect(result.items.map((item) => item.id)).toEqual([current._id.toString()]);
    expect(result.pagination.total).toBe(1);
    await expect(ctx.service.unreadCount(USER_A)).resolves.toEqual({ count: 1 });
    await expect(ctx.service.markRead(USER_A, retired._id.toString())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(ctx.service.markAllRead(USER_A)).resolves.toEqual({ updatedCount: 1 });
    expect(retired.readAt).toBeUndefined();
    expect(() =>
      notificationValidation(
        UpdateNotificationPreferencesDto,
        NotificationErrorCode.PREFERENCE_INVALID,
      ).transform({ auctionOpportunityAlerts: 'OFF' }, {}),
    ).toThrow(BadRequestException);
  });
  it('lists only the actor inbox, newest first, with bounded pagination and no internal routing/dedup fields', async () => {
    const ctx = serviceHarness();
    ctx.rows.push(
      inboxRow(USER_A, new Date('2026-01-01')),
      inboxRow(USER_A, new Date('2026-01-03')),
      inboxRow(USER_B, new Date('2026-01-04')),
    );
    const result = await ctx.service.list(USER_A, { page: 1, limit: 1 });
    expect(result.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(result.items[0].createdAt).toEqual(new Date('2026-01-03'));
    expect(JSON.stringify(result)).not.toMatch(/recipientAccountId|sourceEventId|privateRouting/);
  });
  it('supports unread/read filtering and unread count', async () => {
    const ctx = serviceHarness();
    ctx.rows.push(
      inboxRow(USER_A, new Date('2026-01-01')),
      inboxRow(USER_A, new Date('2026-01-02'), T0),
      inboxRow(USER_B, new Date('2026-01-03')),
    );
    expect((await ctx.service.list(USER_A, { unread: true })).items).toHaveLength(1);
    expect((await ctx.service.list(USER_A, { unread: false })).items).toHaveLength(1);
    await expect(ctx.service.unreadCount(USER_A)).resolves.toEqual({ count: 1 });
  });
  it('marks one read idempotently and preserves the first read timestamp', async () => {
    const ctx = serviceHarness();
    const row = inboxRow(USER_A, T0);
    ctx.rows.push(row);
    const first = await ctx.service.markRead(USER_A, row._id.toString());
    const firstReadAt = first.notification.readAt;
    const second = await ctx.service.markRead(USER_A, row._id.toString());
    expect(second.notification.readAt).toEqual(firstReadAt);
  });
  it('hides cross-account reads/updates as not found and rejects malformed ids deterministically', async () => {
    const ctx = serviceHarness();
    const row = inboxRow(USER_A, T0);
    ctx.rows.push(row);
    await expect(ctx.service.markRead(USER_B, row._id.toString())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(ctx.service.markRead(USER_A, 'bad-id')).rejects.toMatchObject({
      response: expect.objectContaining({ code: NotificationErrorCode.ID_INVALID }),
    });
    expect(row.readAt).toBeUndefined();
  });
  it('marks all of only the actor unread rows and never mutates notification content', async () => {
    const ctx = serviceHarness();
    const mine = inboxRow(USER_A, T0);
    const other = inboxRow(USER_B, T0);
    ctx.rows.push(mine, other);
    await expect(ctx.service.markAllRead(USER_A)).resolves.toEqual({ updatedCount: 1 });
    expect(mine.readAt).toBeInstanceOf(Date);
    expect(mine.title).toBe('عنوان');
    expect(other.readAt).toBeUndefined();
  });
  it('returns frozen IMMEDIATE defaults and only accepts IMMEDIATE/OFF optional broker-alert modes', async () => {
    const ctx = serviceHarness();
    await expect(ctx.service.getPreferences(USER_A)).resolves.toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES,
    );
    await expect(
      ctx.service.updatePreferences(USER_A, { newPropertyAlerts: NotificationPreferenceMode.OFF }),
    ).resolves.toEqual({
      newPropertyAlerts: NotificationPreferenceMode.OFF,
    });
    await expect(ctx.service.updatePreferences(USER_A, {})).rejects.toMatchObject({
      response: expect.objectContaining({ code: NotificationErrorCode.PREFERENCE_INVALID }),
    });
  });
  it('returns stable query/preference validation errors for unsupported values and fields', () => {
    const queryPipe = notificationValidation(
      ListNotificationsDto,
      NotificationErrorCode.QUERY_INVALID,
    );
    const preferencePipe = notificationValidation(
      UpdateNotificationPreferencesDto,
      NotificationErrorCode.PREFERENCE_INVALID,
    );
    expect(() => queryPipe.transform({ limit: 51 }, {})).toThrow(BadRequestException);
    expect(() => queryPipe.transform({ recipientAccountId: USER_B }, {})).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: NotificationErrorCode.QUERY_INVALID }),
      }),
    );
    expect(() => preferencePipe.transform({ newPropertyAlerts: 'DAILY_DIGEST' }, {})).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: NotificationErrorCode.PREFERENCE_INVALID }),
      }),
    );
  });
});
