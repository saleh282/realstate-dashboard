'use strict';

const {
  notificationValidation,
} = require('../src/validators/notifications/notification-validation.pipe');
const { ListNotificationsDto } = require('../src/validators/notifications/list-notifications.dto');
const {
  UpdateNotificationPreferencesDto,
} = require('../src/validators/notifications/update-notification-preferences.dto');
const { NotificationErrorCode } = require('../src/common/errors/notification-error-codes');
const {
  InvalidOutboxEventError,
  assertValidOutboxDraft,
  kycDecisionEvent,
} = require('../src/domain/outbox/outbox-events');
const { NotificationType } = require('../src/domain/notifications/notification.types');
const { mapNotificationEvent } = require('../src/domain/notifications/notification-event.mapper');
const id = (n) => `64b0000000000000000000${n.toString(16).padStart(2, '0')}`;
const ADVERTISER = id(0xa1);
const T0 = new Date('2026-09-26T10:00:00.000Z');
const delivery = (draft) => ({ eventId: id(9), aggregateVersion: 1, attempt: 1, ...draft });
describe('MAZAD-036 completion: KYC events keep decisions private and reason-free', () => {
  it('KYC events are PRIVATE, route to the subject only, and carry no rejection reason or evidence', () => {
    for (const decision of ['verified', 'rejected']) {
      const event = kycDecisionEvent({
        accountId: ADVERTISER,
        occurredAt: T0,
        decision,
        kycVersion: 4,
      });
      expect(event.audience).toBe('PRIVATE');
      expect(event.privateRouting).toEqual({ subjectAccountId: ADVERTISER });
      expect(Object.keys(event.payload).sort()).toEqual(['kycStatus', 'kycVersion', 'reviewedAt']);
      expect(JSON.stringify(event.payload)).not.toContain(ADVERTISER);
    }
  });
  it('the outbox guard refuses a KYC payload that tries to add a reason, evidence or an account id', () => {
    const base = kycDecisionEvent({
      accountId: ADVERTISER,
      occurredAt: T0,
      decision: 'rejected',
      kycVersion: 1,
    });
    for (const extra of [
      { rejectionReason: 'x' },
      { reason: 'x' },
      { evidenceUrl: 'x' },
      { subjectAccountId: ADVERTISER },
    ]) {
      expect(() =>
        assertValidOutboxDraft({ ...base, payload: { ...base.payload, ...extra } }),
      ).toThrow(InvalidOutboxEventError);
    }
  });
});
describe('MAZAD-036 completion: required notifications cannot be preference-disabled', () => {
  const pipe = notificationValidation(
    UpdateNotificationPreferencesDto,
    NotificationErrorCode.PREFERENCE_INVALID,
  );
  it('every mapped notification is required, whatever the recipient preferences say', () => {
    const drafts = [
      kycDecisionEvent({
        accountId: ADVERTISER,
        occurredAt: T0,
        decision: 'verified',
        kycVersion: 1,
      }),
    ];
    const types = new Set();
    for (const draft of drafts) {
      for (const notification of mapNotificationEvent(delivery(draft))) {
        expect(notification.required).toBe(true);
        types.add(notification.type);
      }
    }
    expect([...types]).toEqual([NotificationType.KYC_APPROVED]);
  });
});
describe('MAZAD-036 completion: inbox pagination bounds', () => {
  const pipe = notificationValidation(ListNotificationsDto, NotificationErrorCode.QUERY_INVALID);
  it('rejects an absurd page (skip overflow) and keeps limit ≤ 50', () => {
    expect(() => pipe.transform({ page: 10_001 }, {})).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: NotificationErrorCode.QUERY_INVALID }),
      }),
    );
    expect(() => pipe.transform({ page: 10_000, limit: 50 }, {})).not.toThrow();
    expect(() => pipe.transform({ limit: 51 }, {})).toThrow();
  });
});
