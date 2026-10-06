'use strict';
const { AccountDeletionRequestSchema } = require('./account-deletion-request.model');
const { AuditLogSchema } = require('./audit-log.model');
const { BrokerApplicationSchema } = require('./broker-application.model');
const { BrokerVerificationDocumentSchema } = require('./broker-verification-document.model');
const { IdempotencyRecordSchema } = require('./idempotency-record.model');
const { EvidenceCleanupTaskSchema } = require('./evidence-cleanup-task.model');
const { LegalDocumentSchema } = require('./legal-document.model');
const { ListingSchema } = require('./listing.model');
const { ListingReportSchema } = require('./listing-report.model');
const { NotificationDeliverySchema } = require('./notification-delivery.model');
const { NotificationPreferenceSchema } = require('./notification-preference.model');
const { NotificationSchema } = require('./notification.model');
const { OtpVerificationSchema } = require('./otp-verification.model');
const { OutboxEventSchema } = require('./outbox-event.model');
const { RefreshTokenSchema } = require('./refresh-token.model');
const { UserSchema } = require('./user.model');

function createModels(connection) {
  return {
    AccountDeletionRequest:
      connection.models.AccountDeletionRequest ||
      connection.model('AccountDeletionRequest', AccountDeletionRequestSchema),
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
    LegalDocument:
      connection.models.LegalDocument || connection.model('LegalDocument', LegalDocumentSchema),
    Listing: connection.models.Listing || connection.model('Listing', ListingSchema),
    ListingReport:
      connection.models.ListingReport || connection.model('ListingReport', ListingReportSchema),
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
    RefreshToken:
      connection.models.RefreshToken || connection.model('RefreshToken', RefreshTokenSchema),
    User: connection.models.User || connection.model('User', UserSchema),
  };
}
module.exports = { createModels };
