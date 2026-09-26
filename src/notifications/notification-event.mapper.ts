import { Types } from 'mongoose';
import { OutboxDeliveryEvent, OutboxPermanentDeliveryError } from '../outbox/outbox-consumer.port';
import { OutboxEventType } from '../outbox/outbox-events';
import { NOTIFICATION_SCHEMA_VERSION, NotificationTarget, NotificationTargetType, NotificationType } from './notification.types';

export interface NotificationDraft {
  recipientAccountId: string;
  type: NotificationType;
  schemaVersion: number;
  sourceEventId: string;
  aggregateType: string;
  aggregateId: string;
  required: boolean;
  title: string;
  message: string;
  target: NotificationTarget;
  createdAt: Date;
}

export const NOTIFICATION_SUBSCRIBED_EVENT_TYPES = Object.freeze([
  OutboxEventType.AUCTION_ACTIVATED,
  OutboxEventType.AUCTION_CANCELLED,
  OutboxEventType.BID_ACCEPTED,
  OutboxEventType.AUCTION_FINALIZED,
  OutboxEventType.AUCTION_ENTRY_PAYMENT_CONFIRMED,
  OutboxEventType.MANAGED_MARKETING_PAYMENT_CONFIRMED,
  OutboxEventType.KYC_APPROVED,
  OutboxEventType.KYC_REJECTED,
  OutboxEventType.PROPERTY_APPROVED,
  OutboxEventType.PROPERTY_REJECTED,
] as const);

function objectId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Types.ObjectId.isValid(value) || value.toLowerCase() !== value) {
    throw new OutboxPermanentDeliveryError(`invalid notifications event ${field}`);
  }
  return value;
}

function routing(event: OutboxDeliveryEvent, key: 'bidderAccountId' | 'winnerAccountId' | 'advertiserAccountId' | 'previousHighestBidderAccountId' | 'subjectAccountId'): string {
  return objectId(event.privateRouting?.[key], `privateRouting.${key}`);
}

function optionalRouting(event: OutboxDeliveryEvent, key: 'advertiserAccountId' | 'previousHighestBidderAccountId'): string | undefined {
  const value = event.privateRouting?.[key];
  return value === undefined ? undefined : objectId(value, `privateRouting.${key}`);
}

function losingRecipients(event: OutboxDeliveryEvent, winnerAccountId: string): string[] {
  const values = event.privateRouting?.losingBidderAccountIds;
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new OutboxPermanentDeliveryError('invalid notifications event privateRouting.losingBidderAccountIds');
  return [...new Set(values.map((value, index) => objectId(value, `privateRouting.losingBidderAccountIds[${index}]`)))]
    .filter((accountId) => accountId !== winnerAccountId);
}

function target(type: NotificationTargetType, id: unknown): NotificationTarget {
  return { type, id: objectId(id, 'target id') };
}

function base(event: OutboxDeliveryEvent) {
  if (event.schemaVersion !== 1) throw new OutboxPermanentDeliveryError(`unsupported ${event.type} schemaVersion`);
  if (!(event.occurredAt instanceof Date) || Number.isNaN(event.occurredAt.getTime())) {
    throw new OutboxPermanentDeliveryError(`invalid ${event.type} occurredAt`);
  }
  return {
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    sourceEventId: objectId(event.eventId, 'eventId'),
    aggregateType: event.aggregateType,
    aggregateId: objectId(event.aggregateId, 'aggregateId'),
    required: true,
    createdAt: new Date(event.occurredAt),
  };
}

/** Closed mapping: raw payload/privateRouting is never persisted or projected. */
export function mapNotificationEvent(event: OutboxDeliveryEvent): NotificationDraft[] {
  const common = base(event);
  switch (event.type) {
    case OutboxEventType.AUCTION_ACTIVATED: {
      const recipientAccountId = optionalRouting(event, 'advertiserAccountId');
      return recipientAccountId ? [{ ...common, recipientAccountId, type: NotificationType.AUCTION_STARTED, title: 'بدأ المزاد', message: 'بدأ المزاد الخاص بعقارك.', target: target(NotificationTargetType.AUCTION, event.payload.auctionId) }] : [];
    }
    case OutboxEventType.AUCTION_CANCELLED: {
      const recipientAccountId = optionalRouting(event, 'advertiserAccountId');
      return recipientAccountId ? [{ ...common, recipientAccountId, type: NotificationType.AUCTION_CANCELLED, title: 'تم إلغاء المزاد', message: 'تم إلغاء المزاد.', target: target(NotificationTargetType.AUCTION, event.payload.auctionId) }] : [];
    }
    case OutboxEventType.BID_ACCEPTED: {
      const recipientAccountId = optionalRouting(event, 'previousHighestBidderAccountId');
      if (!recipientAccountId) return [];
      const currentBidderAccountId = routing(event, 'bidderAccountId');
      return recipientAccountId !== currentBidderAccountId
        ? [{ ...common, recipientAccountId, type: NotificationType.OUTBID, title: 'تم تجاوز مزايدتك', message: 'سُجلت مزايدة أعلى في المزاد.', target: target(NotificationTargetType.AUCTION, event.payload.auctionId) }]
        : [];
    }
    case OutboxEventType.AUCTION_FINALIZED: {
      const winnerAccountId = routing(event, 'winnerAccountId');
      const auctionTarget = target(NotificationTargetType.AUCTION, event.payload.auctionId);
      return [
        { ...common, recipientAccountId: winnerAccountId, type: NotificationType.AUCTION_WON, title: 'فزت بالمزاد', message: 'تهانينا، تم اعتمادك فائزاً بالمزاد.', target: auctionTarget },
        ...losingRecipients(event, winnerAccountId).map((recipientAccountId) => ({ ...common, recipientAccountId, type: NotificationType.AUCTION_LOST, title: 'انتهى المزاد', message: 'انتهى المزاد ولم تكن المزايدة الفائزة.', target: auctionTarget })),
      ];
    }
    case OutboxEventType.AUCTION_ENTRY_PAYMENT_CONFIRMED:
      return [{ ...common, recipientAccountId: routing(event, 'bidderAccountId'), type: NotificationType.AUCTION_ENTRY_PAYMENT_CONFIRMED, title: 'تم تأكيد رسوم دخول المزاد', message: 'تم تأكيد الدفع وأصبحت أهلية المشاركة في المزاد متاحة وفق حالته الحالية.', target: target(NotificationTargetType.AUCTION, event.payload.auctionId) }];
    case OutboxEventType.MANAGED_MARKETING_PAYMENT_CONFIRMED:
      return [{ ...common, recipientAccountId: routing(event, 'advertiserAccountId'), type: NotificationType.MANAGED_MARKETING_PAYMENT_CONFIRMED, title: 'تم تأكيد دفع خدمة التسويق', message: 'تم تأكيد دفع طلب التسويق المُدار.', target: target(NotificationTargetType.MANAGED_MARKETING_REQUEST, event.payload.requestId) }];
    case OutboxEventType.KYC_APPROVED:
      return [{ ...common, recipientAccountId: routing(event, 'subjectAccountId'), type: NotificationType.KYC_APPROVED, title: 'تم قبول التحقق', message: 'تم قبول طلب التحقق من الهوية.', target: target(NotificationTargetType.KYC, event.aggregateId) }];
    case OutboxEventType.KYC_REJECTED:
      return [{ ...common, recipientAccountId: routing(event, 'subjectAccountId'), type: NotificationType.KYC_REJECTED, title: 'تم رفض التحقق', message: 'تم رفض طلب التحقق من الهوية. راجع حالة الطلب لمزيد من التفاصيل.', target: target(NotificationTargetType.KYC, event.aggregateId) }];
    case OutboxEventType.PROPERTY_APPROVED:
      return [{ ...common, recipientAccountId: routing(event, 'advertiserAccountId'), type: NotificationType.PROPERTY_APPROVED, title: 'تم قبول العقار', message: 'تم قبول نسخة العقار المرسلة للمراجعة.', target: target(NotificationTargetType.PROPERTY, event.payload.propertyId) }];
    case OutboxEventType.PROPERTY_REJECTED:
      return [{ ...common, recipientAccountId: routing(event, 'advertiserAccountId'), type: NotificationType.PROPERTY_REJECTED, title: 'تم رفض العقار', message: 'تم رفض نسخة العقار المرسلة للمراجعة. راجع حالة العقار لمزيد من التفاصيل.', target: target(NotificationTargetType.PROPERTY, event.payload.propertyId) }];
    default:
      throw new OutboxPermanentDeliveryError(`unsupported notifications event type ${event.type}`);
  }
}
