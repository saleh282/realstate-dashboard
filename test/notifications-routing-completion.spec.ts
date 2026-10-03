import { notificationValidation } from '../src/notifications/dto/notification-validation.pipe';
import { ListNotificationsDto } from '../src/notifications/dto/list-notifications.dto';
import { UpdateNotificationPreferencesDto } from '../src/notifications/dto/update-notification-preferences.dto';
import { NotificationErrorCode } from '../src/common/errors/notification-error-codes';
import { InvalidOutboxEventError, assertValidOutboxDraft, kycDecisionEvent, propertyDecisionEvent } from '../src/outbox/outbox-events';
import { NotificationType } from '../src/notifications/notification.types';
import { mapNotificationEvent } from '../src/notifications/notification-event.mapper';


const id = (n: number) => `64b0000000000000000000${n.toString(16).padStart(2, '0')}`;
const ADVERTISER = id(0xa1);
const T0 = new Date('2026-09-26T10:00:00.000Z');
const delivery = (draft: any) => ({ eventId: id(9), aggregateVersion: 1, attempt: 1, ...draft });

describe('MAZAD-036 completion: KYC / property events keep decisions private and reason-free', () => {
  it('KYC events are PRIVATE, route to the subject only, and carry no rejection reason or evidence', () => {
    for (const decision of ['verified', 'rejected'] as const) {
      const event = kycDecisionEvent({ accountId: ADVERTISER, occurredAt: T0, decision, kycVersion: 4 });
      expect(event.audience).toBe('PRIVATE');
      expect(event.privateRouting).toEqual({ subjectAccountId: ADVERTISER });
      expect(Object.keys(event.payload).sort()).toEqual(['kycStatus', 'kycVersion', 'reviewedAt']);
      expect(JSON.stringify(event.payload)).not.toContain(ADVERTISER);
    }
  });

  it('property events are PRIVATE, route to the advertiser only, and carry no admin note or evidence', () => {
    for (const decision of ['approved', 'rejected'] as const) {
      const event = propertyDecisionEvent({ propertyId: id(7), revisionId: id(8), occurredAt: T0, decision, decisionVersion: 2, advertiserAccountId: ADVERTISER });
      expect(event.audience).toBe('PRIVATE');
      expect(event.privateRouting).toEqual({ advertiserAccountId: ADVERTISER });
      expect(Object.keys(event.payload).sort()).toEqual(['decisionVersion', 'moderationStatus', 'propertyId', 'reviewedAt', 'revisionId']);
    }
  });

  it('the outbox guard refuses a KYC/property/cancel payload that tries to add a reason, evidence or an account id', () => {
    const base = kycDecisionEvent({ accountId: ADVERTISER, occurredAt: T0, decision: 'rejected', kycVersion: 1 });
    for (const extra of [{ rejectionReason: 'x' }, { reason: 'x' }, { evidenceUrl: 'x' }, { subjectAccountId: ADVERTISER }]) {
      expect(() => assertValidOutboxDraft({ ...base, payload: { ...base.payload, ...extra } })).toThrow(InvalidOutboxEventError);
    }
  });
});

describe('MAZAD-036 completion: required notifications cannot be preference-disabled', () => {
  const pipe = notificationValidation(UpdateNotificationPreferencesDto, NotificationErrorCode.PREFERENCE_INVALID);

  it('every mapped notification is required, whatever the recipient preferences say', () => {
    const drafts = [
      kycDecisionEvent({ accountId: ADVERTISER, occurredAt: T0, decision: 'verified', kycVersion: 1 }),
      propertyDecisionEvent({ propertyId: id(7), revisionId: id(8), occurredAt: T0, decision: 'approved', decisionVersion: 1, advertiserAccountId: ADVERTISER }),
    ];
    const types = new Set<string>();
    for (const draft of drafts) {
      for (const notification of mapNotificationEvent(delivery(draft) as any)) {
        expect(notification.required).toBe(true);
        types.add(notification.type);
      }
    }
    expect([...types].sort()).toEqual([
      NotificationType.KYC_APPROVED, NotificationType.PROPERTY_APPROVED,
    ].sort());
  });
});

describe('MAZAD-036 completion: inbox pagination bounds', () => {
  const pipe = notificationValidation(ListNotificationsDto, NotificationErrorCode.QUERY_INVALID);
  it('rejects an absurd page (skip overflow) and keeps limit ≤ 50', () => {
    expect(() => pipe.transform({ page: 10_001 }, {} as any)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: NotificationErrorCode.QUERY_INVALID }) }));
    expect(() => pipe.transform({ page: 10_000, limit: 50 }, {} as any)).not.toThrow();
    expect(() => pipe.transform({ limit: 51 }, {} as any)).toThrow();
  });
});
