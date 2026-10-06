'use strict';
const { ConfigService } = require('./config');
const { JwtService } = require('../common/security/jwt');
const { v2: cloudinary } = require('cloudinary');
const { readGeocodingOptions } = require('../domain/geocoding/geocoding.config');
const { GoogleGeocodingProvider } = require('../domain/geocoding/google-geocoding.provider');
const { NominatimGeocodingProvider } = require('../domain/geocoding/nominatim-geocoding.provider');
const { DisabledGeocodingProvider } = require('../domain/geocoding/disabled-geocoding.provider');
const { AuditLogService } = require('./../services/audit-log.service');
const { RefreshTokenService } = require('./../services/refresh-token.service');
const { OutboxService } = require('./../services/outbox.service');
const { CloudinaryAssetService } = require('./../services/cloudinary-asset.service');
const { UsersService } = require('./../services/users.service');
const { OperationalStatusService } = require('./../services/operational-status.service');
const { AccountDeletionService } = require('./../services/account-deletion.service');
const { OtpVerificationService } = require('./../services/otp-verification.service');
const { MailService } = require('./../services/mail.service');
const { LegalDocumentsService } = require('./../services/legal-documents.service');
const { AuthService } = require('./../services/auth.service');
const { BrokerApplicationsService } = require('./../services/broker-applications.service');
const { GeocodingService } = require('./../services/geocoding.service');
const { GovernoratesService } = require('./../services/governorates.service');
const { HealthService } = require('./../services/health.service');
const { KycService } = require('./../services/kyc.service');
const { ClockService } = require('./../services/clock.service');
const { NotificationsService } = require('./../services/notifications.service');
const { IdempotencyService } = require('./../services/idempotency.service');
const { JwtStrategy } = require('./../services/access-token.service');
const { EnvironmentGuardService } = require('./../services/environment-guard.service');
const { EvidenceCleanupWorker } = require('./../services/evidence-cleanup.worker');
const { OutboxConsumerRegistry } = require('./../domain/outbox/outbox-consumer.port');
const { NotificationsOutboxConsumer } = require('./../services/notifications-outbox.consumer');
const { OutboxDispatcherService } = require('./../services/outbox-dispatcher.service');
const { OutboxWakeup } = require('./../domain/outbox/outbox-wakeup');
const { OutboxDispatcherWorker } = require('./../services/outbox-dispatcher.worker');

// Explicit construction keeps dependencies visible without a DI framework.
function createServices(connection, models, env = process.env) {
  const config = new ConfigService(env);
  const services = { ConfigService: config, JwtService: new JwtService() };
  cloudinary.config({
    cloud_name: config.get('CLOUDINARY_CLOUD_NAME'),
    api_key: config.get('CLOUDINARY_API_KEY'),
    api_secret: config.get('CLOUDINARY_API_SECRET'),
  });
  const geocoding = require('./geocoding').createGeocoding(config);
  services.AuditLogService = new AuditLogService(models.AuditLog);
  services.RefreshTokenService = new RefreshTokenService(models.RefreshToken);
  services.OutboxService = new OutboxService(models.OutboxEvent);
  services.CloudinaryAssetService = new CloudinaryAssetService(
    cloudinary,
    models.EvidenceCleanupTask,
  );
  services.UsersService = new UsersService(
    models.User,
    services.RefreshTokenService,
    services.AuditLogService,
    connection,
    services.OutboxService,
    services.CloudinaryAssetService,
  );
  services.OperationalStatusService = new OperationalStatusService(
    connection,
    services.ConfigService,
  );
  services.AccountDeletionService = new AccountDeletionService(
    models.User,
    models.AccountDeletionRequest,
    connection,
    services.RefreshTokenService,
    services.AuditLogService,
    [],
    services.CloudinaryAssetService,
  );
  services.OtpVerificationService = new OtpVerificationService(
    models.OtpVerification,
    services.ConfigService,
  );
  services.MailService = new MailService(services.ConfigService);
  services.LegalDocumentsService = new LegalDocumentsService(
    models.LegalDocument,
    services.AuditLogService,
  );
  services.AuthService = new AuthService(
    services.UsersService,
    services.JwtService,
    services.ConfigService,
    services.OtpVerificationService,
    services.MailService,
    services.RefreshTokenService,
    services.AuditLogService,
    services.AccountDeletionService,
    services.LegalDocumentsService,
  );
  services.BrokerApplicationsService = new BrokerApplicationsService(
    models.BrokerApplication,
    models.BrokerVerificationDocument,
    models.User,
    connection,
    services.CloudinaryAssetService,
    services.AuditLogService,
  );
  services.GeocodingService = geocoding.service;
  services.GovernoratesService = new GovernoratesService(
    models.Governorate,
    models.City,
    services.AuditLogService,
  );
  services.HealthService = new HealthService(connection, services.ConfigService);
  services.KycService = new KycService(services.UsersService, services.CloudinaryAssetService);
  services.ClockService = new ClockService();
  services.NotificationsService = new NotificationsService(
    models.Notification,
    models.NotificationPreference,
  );
  services.IdempotencyService = new IdempotencyService(models.IdempotencyRecord);
  services.JwtStrategy = new JwtStrategy(
    services.ConfigService,
    services.UsersService,
    services.RefreshTokenService,
  );
  services.EnvironmentGuardService = new EnvironmentGuardService(
    services.ConfigService,
    connection,
  );
  services.EvidenceCleanupWorker = new EvidenceCleanupWorker(
    services.CloudinaryAssetService,
    services.ConfigService,
  );
  services.OutboxConsumerRegistry = new OutboxConsumerRegistry();
  services.NotificationsOutboxConsumer = new NotificationsOutboxConsumer(
    services.OutboxConsumerRegistry,
    connection,
    models.Notification,
    models.NotificationDelivery,
  );
  services.OutboxDispatcherService = new OutboxDispatcherService(
    models.OutboxEvent,
    services.OutboxConsumerRegistry,
    services.ClockService,
    services.ConfigService,
  );
  services.OutboxWakeup = new OutboxWakeup();
  services.OutboxDispatcherWorker = new OutboxDispatcherWorker(
    services.OutboxDispatcherService,
    services.OutboxConsumerRegistry,
    services.ConfigService,
    services.OutboxWakeup,
  );
  return services;
}
module.exports = { createServices };
