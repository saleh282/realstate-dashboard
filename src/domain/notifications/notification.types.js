'use strict';

var NotificationType;
(function (NotificationType) {
  NotificationType['KYC_APPROVED'] = 'KYC_APPROVED';
  NotificationType['KYC_REJECTED'] = 'KYC_REJECTED';
})(NotificationType || (NotificationType = {}));
var NotificationTargetType;
(function (NotificationTargetType) {
  NotificationTargetType['KYC'] = 'KYC';
})(NotificationTargetType || (NotificationTargetType = {}));
var NotificationPreferenceMode;
(function (NotificationPreferenceMode) {
  NotificationPreferenceMode['IMMEDIATE'] = 'IMMEDIATE';
  NotificationPreferenceMode['OFF'] = 'OFF';
})(NotificationPreferenceMode || (NotificationPreferenceMode = {}));
var NotificationChannel;
(function (NotificationChannel) {
  NotificationChannel['IN_APP'] = 'IN_APP';
})(NotificationChannel || (NotificationChannel = {}));
var NotificationDeliveryStatus;
(function (NotificationDeliveryStatus) {
  NotificationDeliveryStatus['DELIVERED'] = 'DELIVERED';
})(NotificationDeliveryStatus || (NotificationDeliveryStatus = {}));
const NOTIFICATION_SCHEMA_VERSION = 1;
const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  newPropertyAlerts: NotificationPreferenceMode.IMMEDIATE,
});

Object.assign(exports, {
  NotificationType,
  NotificationTargetType,
  NotificationPreferenceMode,
  NotificationChannel,
  NotificationDeliveryStatus,
  NOTIFICATION_SCHEMA_VERSION,
  DEFAULT_NOTIFICATION_PREFERENCES,
});
