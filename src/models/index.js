'use strict';
const { AccountDeletionRequestSchema } = require('./account-deletion-request.model');
const { AmenitySchema } = require('./amenity.model');
const { AuditLogSchema } = require('./audit-log.model');
const { BrokerApplicationSchema } = require('./broker-application.model');
const { BrokerVerificationDocumentSchema } = require('./broker-verification-document.model');
const { IdempotencyRecordSchema } = require('./idempotency-record.model');
const { EvidenceCleanupTaskSchema } = require('./evidence-cleanup-task.model');
const { CitySchema } = require('./city.model');
const { GovernorateSchema } = require('./governorate.model');
const { LegalDocumentSchema } = require('./legal-document.model');
const { ManagedMarketingPackageSchema } = require('./managed-marketing-package.model');
const { ManagedMarketingRequestSchema } = require('./managed-marketing-request.model');
const { NotificationDeliverySchema } = require('./notification-delivery.model');
const { NotificationPreferenceSchema } = require('./notification-preference.model');
const { NotificationSchema } = require('./notification.model');
const { OtpVerificationSchema } = require('./otp-verification.model');
const { OutboxEventSchema } = require('./outbox-event.model');
const { ManagedMarketingPaymentSchema } = require('./managed-marketing-payment.model');
const { PropertyRevisionSchema } = require('./property-revision.model');
const { PropertySchema } = require('./property.model');
const { PropertyAttributeSchema } = require('./property-attribute.model');
const { PropertyFormDefinitionVersionSchema } = require('./property-form-definition-version.model');
const { PropertyFormDefinitionSchema } = require('./property-form-definition.model');
const { PropertyOptionSchema } = require('./property-option.model');
const { PropertyPurposeCategorySchema } = require('./property-purpose-category.model');
const { PropertyTypeSchema } = require('./property-type.model');
const { RefreshTokenSchema } = require('./refresh-token.model');
const { UserSchema } = require('./user.model');

function createModels(connection) {
  return {
    AccountDeletionRequest:
      connection.models.AccountDeletionRequest ||
      connection.model('AccountDeletionRequest', AccountDeletionRequestSchema),
    Amenity: connection.models.Amenity || connection.model('Amenity', AmenitySchema),
    AuditLog: connection.models.AuditLog || connection.model('AuditLog', AuditLogSchema),
    BrokerApplication:
      connection.models.BrokerApplication ||
      connection.model('BrokerApplication', BrokerApplicationSchema),
    BrokerVerificationDocument:
      connection.models.BrokerVerificationDocument ||
      connection.model('BrokerVerificationDocument', BrokerVerificationDocumentSchema),
    IdempotencyRecord:
      connection.models.IdempotencyRecord ||
      connection.model('IdempotencyRecord', IdempotencyRecordSchema),
    EvidenceCleanupTask:
      connection.models.EvidenceCleanupTask ||
      connection.model('EvidenceCleanupTask', EvidenceCleanupTaskSchema),
    City: connection.models.City || connection.model('City', CitySchema),
    Governorate:
      connection.models.Governorate || connection.model('Governorate', GovernorateSchema),
    LegalDocument:
      connection.models.LegalDocument || connection.model('LegalDocument', LegalDocumentSchema),
    ManagedMarketingPackage:
      connection.models.ManagedMarketingPackage ||
      connection.model('ManagedMarketingPackage', ManagedMarketingPackageSchema),
    ManagedMarketingRequest:
      connection.models.ManagedMarketingRequest ||
      connection.model('ManagedMarketingRequest', ManagedMarketingRequestSchema),
    NotificationDelivery:
      connection.models.NotificationDelivery ||
      connection.model('NotificationDelivery', NotificationDeliverySchema),
    NotificationPreference:
      connection.models.NotificationPreference ||
      connection.model('NotificationPreference', NotificationPreferenceSchema),
    Notification:
      connection.models.Notification || connection.model('Notification', NotificationSchema),
    OtpVerification:
      connection.models.OtpVerification ||
      connection.model('OtpVerification', OtpVerificationSchema),
    OutboxEvent:
      connection.models.OutboxEvent || connection.model('OutboxEvent', OutboxEventSchema),
    ManagedMarketingPayment:
      connection.models.ManagedMarketingPayment ||
      connection.model('ManagedMarketingPayment', ManagedMarketingPaymentSchema),
    PropertyRevision:
      connection.models.PropertyRevision ||
      connection.model('PropertyRevision', PropertyRevisionSchema),
    Property: connection.models.Property || connection.model('Property', PropertySchema),
    PropertyAttribute:
      connection.models.PropertyAttribute ||
      connection.model('PropertyAttribute', PropertyAttributeSchema),
    PropertyFormDefinitionVersion:
      connection.models.PropertyFormDefinitionVersion ||
      connection.model('PropertyFormDefinitionVersion', PropertyFormDefinitionVersionSchema),
    PropertyFormDefinition:
      connection.models.PropertyFormDefinition ||
      connection.model('PropertyFormDefinition', PropertyFormDefinitionSchema),
    PropertyOption:
      connection.models.PropertyOption || connection.model('PropertyOption', PropertyOptionSchema),
    PropertyPurposeCategory:
      connection.models.PropertyPurposeCategory ||
      connection.model('PropertyPurposeCategory', PropertyPurposeCategorySchema),
    PropertyType:
      connection.models.PropertyType || connection.model('PropertyType', PropertyTypeSchema),
    RefreshToken:
      connection.models.RefreshToken || connection.model('RefreshToken', RefreshTokenSchema),
    User: connection.models.User || connection.model('User', UserSchema),
  };
}
module.exports = { createModels };
