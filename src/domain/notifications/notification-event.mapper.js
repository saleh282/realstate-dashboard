'use strict';

const { Types } = require('mongoose');
const { OutboxPermanentDeliveryError } = require('../outbox/outbox-consumer.port');
const { OutboxEventType } = require('../outbox/outbox-events');
const {
  NOTIFICATION_SCHEMA_VERSION,
  NotificationTargetType,
  NotificationType,
} = require('./notification.types');
const NOTIFICATION_SUBSCRIBED_EVENT_TYPES = Object.freeze([
  OutboxEventType.MANAGED_MARKETING_PAYMENT_CONFIRMED,
  OutboxEventType.KYC_APPROVED,
  OutboxEventType.KYC_REJECTED,
  OutboxEventType.PROPERTY_APPROVED,
  OutboxEventType.PROPERTY_REJECTED,
]);
function objectId(value, field) {
  if (
    typeof value !== 'string' ||
    !Types.ObjectId.isValid(value) ||
    value.toLowerCase() !== value
  ) {
    throw new OutboxPermanentDeliveryError(`invalid notifications event ${field}`);
  }
  return value;
}
function routing(event, key) {
  return objectId(event.privateRouting?.[key], `privateRouting.${key}`);
}
function target(type, id) {
  return { type, id: objectId(id, 'target id') };
}
function base(event) {
  if (event.schemaVersion !== 1)
    throw new OutboxPermanentDeliveryError(`unsupported ${event.type} schemaVersion`);
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
function mapNotificationEvent(event) {
  const common = base(event);
  switch (event.type) {
    case OutboxEventType.MANAGED_MARKETING_PAYMENT_CONFIRMED:
      return [
        {
          ...common,
          recipientAccountId: routing(event, 'advertiserAccountId'),
          type: NotificationType.MANAGED_MARKETING_PAYMENT_CONFIRMED,
          title: 'تم تأكيد دفع خدمة التسويق',
          message: 'تم تأكيد دفع طلب التسويق المُدار.',
          target: target(NotificationTargetType.MANAGED_MARKETING_REQUEST, event.payload.requestId),
        },
      ];
    case OutboxEventType.KYC_APPROVED:
      return [
        {
          ...common,
          recipientAccountId: routing(event, 'subjectAccountId'),
          type: NotificationType.KYC_APPROVED,
          title: 'تم قبول التحقق',
          message: 'تم قبول طلب التحقق من الهوية.',
          target: target(NotificationTargetType.KYC, event.aggregateId),
        },
      ];
    case OutboxEventType.KYC_REJECTED:
      return [
        {
          ...common,
          recipientAccountId: routing(event, 'subjectAccountId'),
          type: NotificationType.KYC_REJECTED,
          title: 'تم رفض التحقق',
          message: 'تم رفض طلب التحقق من الهوية. راجع حالة الطلب لمزيد من التفاصيل.',
          target: target(NotificationTargetType.KYC, event.aggregateId),
        },
      ];
    case OutboxEventType.PROPERTY_APPROVED:
      return [
        {
          ...common,
          recipientAccountId: routing(event, 'advertiserAccountId'),
          type: NotificationType.PROPERTY_APPROVED,
          title: 'تم قبول العقار',
          message: 'تم قبول نسخة العقار المرسلة للمراجعة.',
          target: target(NotificationTargetType.PROPERTY, event.payload.propertyId),
        },
      ];
    case OutboxEventType.PROPERTY_REJECTED:
      return [
        {
          ...common,
          recipientAccountId: routing(event, 'advertiserAccountId'),
          type: NotificationType.PROPERTY_REJECTED,
          title: 'تم رفض العقار',
          message: 'تم رفض نسخة العقار المرسلة للمراجعة. راجع حالة العقار لمزيد من التفاصيل.',
          target: target(NotificationTargetType.PROPERTY, event.payload.propertyId),
        },
      ];
    default:
      throw new OutboxPermanentDeliveryError(`unsupported notifications event type ${event.type}`);
  }
}

Object.assign(exports, { NOTIFICATION_SUBSCRIBED_EVENT_TYPES, mapNotificationEvent });
