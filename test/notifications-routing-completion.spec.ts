import { notificationValidation } from '../src/notifications/dto/notification-validation.pipe';
import { ListNotificationsDto } from '../src/notifications/dto/list-notifications.dto';
import { UpdateNotificationPreferencesDto } from '../src/notifications/dto/update-notification-preferences.dto';
import { NotificationErrorCode } from '../src/common/errors/notification-error-codes';
import { InvalidOutboxEventError, assertValidOutboxDraft, auctionActivatedEvent, auctionCancelledEvent, auctionFinalizedEvent, bidAcceptedEvent, kycDecisionEvent, propertyDecisionEvent } from '../src/outbox/outbox-events';
import { toRealtimeEvent } from '../src/realtime/realtime-events';
import { NotificationType } from '../src/notifications/notification.types';
import { mapNotificationEvent, NOTIFICATION_SUBSCRIBED_EVENT_TYPES } from '../src/notifications/notification-event.mapper';
import { OutboxEventType } from '../src/outbox/outbox-events';

const id = (n: number) => `64b0000000000000000000${n.toString(16).padStart(2, '0')}`;
const AUCTION = id(1);
const ADVERTISER = id(0xa1);
const PREV = id(0xb2);
const BIDDER = id(0xc3);
const WINNER = id(0xd4);
const LOSER = id(0xe5);
const T0 = new Date('2026-09-26T10:00:00.000Z');
const later = new Date(T0.getTime() + 60_000);
const delivery = (draft: any) => ({ eventId: id(9), aggregateVersion: 1, attempt: 1, ...draft });

describe('MAZAD-036 completion: realtime independence from notification routing', () => {
  it('no realtime frame carries any recipient id the notification routing needs', () => {
    const drafts = [
      auctionActivatedEvent({ auctionId: AUCTION, occurredAt: T0, currentEndAt: later, advertiserAccountId: ADVERTISER }),
      auctionCancelledEvent({ auctionId: AUCTION, occurredAt: T0, previousStatus: 'active', advertiserAccountId: ADVERTISER }),
      bidAcceptedEvent({ auctionId: AUCTION, occurredAt: T0, sequence: 2, amountMinor: 200, currency: 'EGP', acceptedBidCount: 2, currentEndAt: later, previousEndAt: later, extended: false, nextMinimumBidMinor: 250, bidderAccountId: BIDDER, previousHighestBidderAccountId: PREV }),
      auctionFinalizedEvent({ auctionId: AUCTION, occurredAt: T0, winningBidSequence: 2, winningBidAmountMinor: 200, currency: 'EGP', acceptedBidCount: 2, winnerAccountId: WINNER, losingBidderAccountIds: [LOSER, PREV] }),
    ];
    for (const draft of drafts) {
      const wire = JSON.stringify(toRealtimeEvent(delivery(draft) as any, T0)).toLowerCase();
      for (const secret of [ADVERTISER, PREV, BIDDER, WINNER, LOSER, 'privaterouting', 'previoushighest', 'losingbidder', 'advertiseraccountid', 'subjectaccountid']) {
        expect(wire).not.toContain(secret.toLowerCase());
      }
    }
  });

  it('the public payloads of the routed events are unchanged by private routing (no account ids inside them)', () => {
    const drafts = [
      auctionActivatedEvent({ auctionId: AUCTION, occurredAt: T0, currentEndAt: later, advertiserAccountId: ADVERTISER }),
      auctionCancelledEvent({ auctionId: AUCTION, occurredAt: T0, previousStatus: 'scheduled', advertiserAccountId: ADVERTISER }),
      bidAcceptedEvent({ auctionId: AUCTION, occurredAt: T0, sequence: 2, amountMinor: 200, currency: 'EGP', acceptedBidCount: 2, currentEndAt: later, previousEndAt: later, extended: false, nextMinimumBidMinor: 250, bidderAccountId: BIDDER, previousHighestBidderAccountId: PREV }),
    ];
    for (const draft of drafts) {
      const text = JSON.stringify(draft.payload);
      for (const account of [ADVERTISER, PREV, BIDDER]) expect(text).not.toContain(account);
      expect(() => assertValidOutboxDraft(draft)).not.toThrow();
    }
  });
});

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

  it('there is no preference field for KYC, property, auction start, outbid, won, lost, cancelled or payment notifications', () => {
    for (const field of ['kycDecisions', 'propertyDecisions', 'auctionStarted', 'outbid', 'auctionWon', 'auctionLost', 'auctionCancelled', 'paymentConfirmed', 'required', 'disableRequired', 'AUCTION_WON', 'OUTBID']) {
      expect(() => pipe.transform({ [field]: 'OFF' }, {} as any)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: NotificationErrorCode.PREFERENCE_INVALID }) }));
    }
  });

  it('every mapped notification is required, whatever the recipient preferences say', () => {
    const drafts = [
      auctionActivatedEvent({ auctionId: AUCTION, occurredAt: T0, currentEndAt: later, advertiserAccountId: ADVERTISER }),
      auctionCancelledEvent({ auctionId: AUCTION, occurredAt: T0, previousStatus: 'active', advertiserAccountId: ADVERTISER }),
      bidAcceptedEvent({ auctionId: AUCTION, occurredAt: T0, sequence: 2, amountMinor: 200, currency: 'EGP', acceptedBidCount: 2, currentEndAt: later, previousEndAt: later, extended: false, nextMinimumBidMinor: 250, bidderAccountId: BIDDER, previousHighestBidderAccountId: PREV }),
      auctionFinalizedEvent({ auctionId: AUCTION, occurredAt: T0, winningBidSequence: 2, winningBidAmountMinor: 200, currency: 'EGP', acceptedBidCount: 2, winnerAccountId: WINNER, losingBidderAccountIds: [LOSER] }),
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
      NotificationType.AUCTION_CANCELLED, NotificationType.AUCTION_LOST, NotificationType.AUCTION_STARTED, NotificationType.AUCTION_WON,
      NotificationType.KYC_APPROVED, NotificationType.OUTBID, NotificationType.PROPERTY_APPROVED,
    ].sort());
  });

  it('the notifications consumer never subscribes to end-extension or lifecycle events that have no recipient', () => {
    expect(NOTIFICATION_SUBSCRIBED_EVENT_TYPES).not.toContain(OutboxEventType.AUCTION_END_EXTENDED);
    expect(NOTIFICATION_SUBSCRIBED_EVENT_TYPES).not.toContain(OutboxEventType.AUCTION_ENDED_NO_BIDS);
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
