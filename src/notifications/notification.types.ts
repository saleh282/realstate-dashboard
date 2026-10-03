export enum NotificationType {
  KYC_APPROVED = 'KYC_APPROVED',
  KYC_REJECTED = 'KYC_REJECTED',
  PROPERTY_APPROVED = 'PROPERTY_APPROVED',
  PROPERTY_REJECTED = 'PROPERTY_REJECTED',
  MANAGED_MARKETING_PAYMENT_CONFIRMED = 'MANAGED_MARKETING_PAYMENT_CONFIRMED'
}

export enum NotificationTargetType {
  KYC = 'KYC',
  PROPERTY = 'PROPERTY',
  MANAGED_MARKETING_REQUEST = 'MANAGED_MARKETING_REQUEST'
}

export enum NotificationPreferenceMode {
  IMMEDIATE = 'IMMEDIATE',
  OFF = 'OFF'
}

export enum NotificationChannel {
  IN_APP = 'IN_APP'
}

export enum NotificationDeliveryStatus {
  DELIVERED = 'DELIVERED'
}

export interface NotificationTarget {
  type: NotificationTargetType;
  id: string;
}

export const NOTIFICATION_SCHEMA_VERSION = 1;
export const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  newPropertyAlerts: NotificationPreferenceMode.IMMEDIATE,
});
