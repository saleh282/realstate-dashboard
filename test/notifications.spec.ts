import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { NotificationErrorCode } from '../src/common/errors/notification-error-codes';
import { OutboxConsumerRegistry, OutboxPermanentDeliveryError } from '../src/outbox/outbox-consumer.port';
import { OutboxEventDraft, OutboxEventType, kycDecisionEvent, managedMarketingPaymentConfirmedEvent, propertyDecisionEvent } from '../src/outbox/outbox-events';
import { notificationValidation } from '../src/notifications/dto/notification-validation.pipe';
import { ListNotificationsDto } from '../src/notifications/dto/list-notifications.dto';
import { UpdateNotificationPreferencesDto } from '../src/notifications/dto/update-notification-preferences.dto';
import { mapNotificationEvent, NOTIFICATION_SUBSCRIBED_EVENT_TYPES } from '../src/notifications/notification-event.mapper';
import { NotificationsOutboxConsumer } from '../src/notifications/notifications-outbox.consumer';
import { NotificationsService } from '../src/notifications/notifications.service';
import { DEFAULT_NOTIFICATION_PREFERENCES, NotificationChannel, NotificationPreferenceMode, NotificationTargetType, NotificationType } from '../src/notifications/notification.types';

const EVENT = '64b000000000000000000001';
const PROPERTY = '64b000000000000000000002';
const PAYMENT = '64b000000000000000000003';
const REQUEST = '64b000000000000000000004';
const USER_A = '64b0000000000000000000a1';
const USER_B = '64b0000000000000000000b2';
const T0 = new Date('2026-09-26T10:00:00.000Z');

function delivery(draft: OutboxEventDraft, eventId = EVENT): any {
  return { eventId, aggregateVersion: 1, attempt: 1, ...draft };
}

function approved() {
  return delivery(propertyDecisionEvent({ propertyId: PROPERTY, revisionId: REQUEST, occurredAt: T0, decision: 'approved', decisionVersion: 1, advertiserAccountId: USER_A }));
}

function consumerHarness() {
  const notificationRows: any[] = [];
  const deliveryRows: any[] = [];
  let notificationFailure: Error | undefined;
  const notifications = {
    findOneAndUpdate: jest.fn((filter: any, update: any) => ({
      exec: async () => {
        if (notificationFailure) throw notificationFailure;
        let row = notificationRows.find((item) => item.sourceEventId === filter.sourceEventId
          && item.recipientAccountId.toString() === filter.recipientAccountId.toString()
          && item.type === filter.type);
        if (!row) {
          row = { _id: new Types.ObjectId(), ...update.$setOnInsert };
          notificationRows.push(row);
        }
        return row;
      },
    })),
  };
  const deliveries = {
    updateOne: jest.fn((filter: any, update: any) => ({
      exec: async () => {
        const existing = deliveryRows.find((item) => item.notificationId.toString() === filter.notificationId.toString() && item.channel === filter.channel);
        if (!existing) deliveryRows.push({ ...update.$setOnInsert });
        return { acknowledged: true };
      },
    })),
  };
  const session: any = {
    active: false,
    startTransaction() { this.active = true; },
    inTransaction() { return this.active; },
    async commitTransaction() { this.active = false; },
    async abortTransaction() { this.active = false; },
    async endSession() {},
  };
  const connection = { startSession: jest.fn(async () => session) };
  const registry = new OutboxConsumerRegistry();
  const consumer = new NotificationsOutboxConsumer(registry, connection as any, notifications as any, deliveries as any);
  return { consumer, registry, notifications, deliveries, notificationRows, deliveryRows, failWith(error?: Error) { notificationFailure = error; } };
}

describe('notification event mapping and outbox consumer (MAZAD-036)', () => {
  it('registers exactly one independent consumer named notifications with only approved routable event types', () => {
    const ctx = consumerHarness();
    ctx.consumer.onModuleInit();
    expect(ctx.registry.list()).toEqual([ctx.consumer]);
    expect(ctx.consumer.name).toBe('notifications');
    expect(ctx.consumer.subscribedTypes).toEqual([
      OutboxEventType.MANAGED_MARKETING_PAYMENT_CONFIRMED,
      OutboxEventType.KYC_APPROVED,
      OutboxEventType.KYC_REJECTED,
      OutboxEventType.PROPERTY_APPROVED,
      OutboxEventType.PROPERTY_REJECTED,
    ]);
    expect(ctx.consumer.subscribedTypes).toEqual(NOTIFICATION_SUBSCRIBED_EVENT_TYPES);
  });

  it('maps KYC and property decisions to their authoritative private subjects without exposing routing', () => {
    const kycApproved = mapNotificationEvent(delivery(kycDecisionEvent({ accountId: USER_A, occurredAt: T0, decision: 'verified', kycVersion: 2 })));
    const kycRejected = mapNotificationEvent(delivery(kycDecisionEvent({ accountId: USER_A, occurredAt: T0, decision: 'rejected', kycVersion: 3 })));
    const propertyApproved = mapNotificationEvent(delivery(propertyDecisionEvent({ propertyId: PROPERTY, revisionId: REQUEST, occurredAt: T0, decision: 'approved', decisionVersion: 1, advertiserAccountId: USER_B })));
    const propertyRejected = mapNotificationEvent(delivery(propertyDecisionEvent({ propertyId: PROPERTY, revisionId: REQUEST, occurredAt: T0, decision: 'rejected', decisionVersion: 2, advertiserAccountId: USER_B })));
    expect(kycApproved[0]).toMatchObject({ recipientAccountId: USER_A, type: NotificationType.KYC_APPROVED });
    expect(kycRejected[0]).toMatchObject({ recipientAccountId: USER_A, type: NotificationType.KYC_REJECTED });
    expect(propertyApproved[0]).toMatchObject({ recipientAccountId: USER_B, type: NotificationType.PROPERTY_APPROVED });
    expect(propertyRejected[0]).toMatchObject({ recipientAccountId: USER_B, type: NotificationType.PROPERTY_REJECTED });
    expect(JSON.stringify([...kycApproved, ...kycRejected, ...propertyApproved, ...propertyRejected])).not.toMatch(/privateRouting|subjectAccountId|advertiserAccountId|rejectionReason/);
  });

  it('maps managed-marketing payment confirmations to their exact private recipients', () => {
    const marketing = delivery(managedMarketingPaymentConfirmedEvent({ requestId: REQUEST, paymentId: PAYMENT, occurredAt: T0, amountMinor: 10000, currency: 'EGP', advertiserAccountId: USER_B }), '64b000000000000000000005');
    expect(mapNotificationEvent(marketing)[0]).toMatchObject({ recipientAccountId: USER_B, type: NotificationType.MANAGED_MARKETING_PAYMENT_CONFIRMED, target: { type: NotificationTargetType.MANAGED_MARKETING_REQUEST, id: REQUEST } });
  });

  it('permanently rejects missing private routing, unsupported versions and arbitrary target ids', () => {
    expect(() => mapNotificationEvent({ ...approved(), privateRouting: undefined })).toThrow(OutboxPermanentDeliveryError);
    expect(() => mapNotificationEvent({ ...approved(), schemaVersion: 2 })).toThrow(OutboxPermanentDeliveryError);
    expect(() => mapNotificationEvent({ ...approved(), occurredAt: new Date('invalid') })).toThrow(OutboxPermanentDeliveryError);
    expect(() => mapNotificationEvent({ ...approved(), payload: { ...approved().payload, propertyId: 'https://evil.invalid' } })).toThrow(OutboxPermanentDeliveryError);
  });

  it('duplicate and concurrent delivery converge on one inbox row and one IN_APP delivery row', async () => {
    const ctx = consumerHarness();
    await Promise.all([ctx.consumer.deliver(approved()), ctx.consumer.deliver(approved()), ctx.consumer.deliver(approved())]);
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
    await expect(ctx.consumer.deliver({ ...approved(), eventId: '64b000000000000000000006' })).resolves.toBeUndefined();
    expect(ctx.notificationRows).toHaveLength(1);
  });
});

function matches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, expected]: [string, any]) => {
    const actual = row[key];
    if (expected && typeof expected === 'object' && '$in' in expected) return expected.$in.includes(actual);
    if (expected && typeof expected === 'object' && '$exists' in expected) return expected.$exists ? actual !== undefined : actual === undefined;
    return actual?.toString?.() === expected?.toString?.();
  });
}

function query<T>(value: () => T) {
  const chain: any = {
    sort: () => chain,
    skip: (count: number) => { chain.skipCount = count; return chain; },
    limit: (count: number) => { chain.limitCount = count; return chain; },
    lean: () => chain,
    exec: async () => {
      const result: any = value();
      return Array.isArray(result) ? result.slice(chain.skipCount ?? 0, (chain.skipCount ?? 0) + (chain.limitCount ?? result.length)) : result;
    },
  };
  return chain;
}

function serviceHarness() {
  const rows: any[] = [];
  const preferenceRows: any[] = [];
  const notifications: any = {
    find: jest.fn((filter: any) => query(() => rows.filter((row) => matches(row, filter)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()))),
    countDocuments: jest.fn((filter: any) => ({ exec: async () => rows.filter((row) => matches(row, filter)).length })),
    findOneAndUpdate: jest.fn((filter: any, update: any) => query(() => {
      const row = rows.find((item) => matches(item, filter));
      if (row && update.$set) Object.assign(row, update.$set);
      return row ?? null;
    })),
    findOne: jest.fn((filter: any) => query(() => rows.find((row) => matches(row, filter)) ?? null)),
    updateMany: jest.fn((filter: any, update: any) => ({ exec: async () => {
      const found = rows.filter((row) => matches(row, filter));
      found.forEach((row) => Object.assign(row, update.$set));
      return { modifiedCount: found.length };
    } })),
  };
  const preferences: any = {
    findOne: jest.fn((filter: any) => query(() => preferenceRows.find((row) => matches(row, filter)) ?? null)),
    findOneAndUpdate: jest.fn((filter: any, update: any) => query(() => {
      let row = preferenceRows.find((item) => matches(item, filter));
      if (!row) { row = { _id: new Types.ObjectId(), ...update.$setOnInsert }; preferenceRows.push(row); }
      Object.assign(row, update.$set);
      return row;
    })),
  };
  return { service: new NotificationsService(notifications, preferences), rows, preferenceRows };
}

function inboxRow(recipient: string, createdAt: Date, readAt?: Date) {
  return { _id: new Types.ObjectId(), recipientAccountId: new Types.ObjectId(recipient), type: NotificationType.PROPERTY_APPROVED, schemaVersion: 1, required: true, title: 'عنوان', message: 'رسالة', target: { type: NotificationTargetType.PROPERTY, id: PROPERTY }, createdAt, ...(readAt ? { readAt } : {}) };
}

describe('notification inbox, isolation and preferences (MAZAD-036)', () => {
  it('excludes retained records of removed notification types from reads, counts and updates', async () => {
    const ctx = serviceHarness();
    const retired = { ...inboxRow(USER_A, T0), type: 'AUCTION_WON', target: { type: 'AUCTION', id: PROPERTY } };
    const current = inboxRow(USER_A, T0);
    ctx.rows.push(retired, current);
    const result = await ctx.service.list(USER_A);
    expect(result.items.map((item) => item.id)).toEqual([current._id.toString()]);
    expect(result.pagination.total).toBe(1);
    await expect(ctx.service.unreadCount(USER_A)).resolves.toEqual({ count: 1 });
    await expect(ctx.service.markRead(USER_A, retired._id.toString())).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctx.service.markAllRead(USER_A)).resolves.toEqual({ updatedCount: 1 });
    expect(retired.readAt).toBeUndefined();
    expect(() => notificationValidation(UpdateNotificationPreferencesDto, NotificationErrorCode.PREFERENCE_INVALID)
      .transform({ auctionOpportunityAlerts: 'OFF' }, {} as any)).toThrow(BadRequestException);
  });

  it('lists only the actor inbox, newest first, with bounded pagination and no internal routing/dedup fields', async () => {
    const ctx = serviceHarness();
    ctx.rows.push(inboxRow(USER_A, new Date('2026-01-01')), inboxRow(USER_A, new Date('2026-01-03')), inboxRow(USER_B, new Date('2026-01-04')));
    const result = await ctx.service.list(USER_A, { page: 1, limit: 1 });
    expect(result.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(result.items[0].createdAt).toEqual(new Date('2026-01-03'));
    expect(JSON.stringify(result)).not.toMatch(/recipientAccountId|sourceEventId|privateRouting/);
  });

  it('supports unread/read filtering and unread count', async () => {
    const ctx = serviceHarness();
    ctx.rows.push(inboxRow(USER_A, new Date('2026-01-01')), inboxRow(USER_A, new Date('2026-01-02'), T0), inboxRow(USER_B, new Date('2026-01-03')));
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
    await expect(ctx.service.markRead(USER_B, row._id.toString())).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctx.service.markRead(USER_A, 'bad-id')).rejects.toMatchObject({ response: expect.objectContaining({ code: NotificationErrorCode.ID_INVALID }) });
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
    await expect(ctx.service.getPreferences(USER_A)).resolves.toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    await expect(ctx.service.updatePreferences(USER_A, { newPropertyAlerts: NotificationPreferenceMode.OFF })).resolves.toEqual({
      newPropertyAlerts: NotificationPreferenceMode.OFF,
    });
    await expect(ctx.service.updatePreferences(USER_A, {})).rejects.toMatchObject({ response: expect.objectContaining({ code: NotificationErrorCode.PREFERENCE_INVALID }) });
  });

  it('returns stable query/preference validation errors for unsupported values and fields', () => {
    const queryPipe = notificationValidation(ListNotificationsDto, NotificationErrorCode.QUERY_INVALID);
    const preferencePipe = notificationValidation(UpdateNotificationPreferencesDto, NotificationErrorCode.PREFERENCE_INVALID);
    expect(() => queryPipe.transform({ limit: 51 }, {} as any)).toThrow(BadRequestException);
    expect(() => queryPipe.transform({ recipientAccountId: USER_B }, {} as any)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: NotificationErrorCode.QUERY_INVALID }) }));
    expect(() => preferencePipe.transform({ newPropertyAlerts: 'DAILY_DIGEST' }, {} as any)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: NotificationErrorCode.PREFERENCE_INVALID }) }));
  });
});
