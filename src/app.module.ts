import { Module } from '@nestjs/common';
import { EnvironmentGuardService } from './config/environment-guard.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { KycModule } from './kyc/kyc.module';
import { APP_GUARD } from '@nestjs/core';
import { AppThrottlerGuard } from './common/security/app-throttler.guard';
import { HealthModule } from './health/health.module';
import { validateEnvironment } from './config/environment.validation';
import { CloudinaryModule } from './config/cloudinary.module';
import { AdminModule } from './admin/admin.module';
import { PropertyTypesModule } from './property-types/property-types.module';
import { AmenitiesModule } from './amenities/amenities.module';
import { PropertyOptionsModule } from './property-options/property-options.module';
import { GovernoratesModule } from './governorates/governorates.module';
import { PropertyFormOptionsModule } from './property-form-options/property-form-options.module';
import { PropertyFormDefinitionsModule } from './property-form-definitions/property-form-definitions.module';
import { PropertiesModule } from './properties/properties.module';
import { BrokerApplicationsModule } from './broker-applications/broker-applications.module';
import { PropertyPurposeCategoriesModule } from './property-purpose-categories/property-purpose-categories.module';
import { ManagedMarketingModule } from './managed-marketing/managed-marketing.module';
import { AuthorizationModule } from './authorization/authorization.module';
import { AccountDeletionModule } from './account-deletion/account-deletion.module';
import { GeocodingModule } from './geocoding/geocoding.module';
import { FavoritesModule } from './favorites/favorites.module';
import { OutboxModule } from './outbox/outbox.module';
import { NotificationsModule } from './notifications/notifications.module';
import { FakePaymentsDevModule } from './payments/dev/fake-payments-dev.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get('MONGO_URI'),
      }),
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 20 }],
      errorMessage: 'محاولات كثيرة جداً، حاول مرة أخرى بعد قليل',
    }),
    AuthModule,
    UsersModule,
    KycModule,
    CloudinaryModule,
    AdminModule,
    PropertyTypesModule,
    AmenitiesModule,
    PropertyOptionsModule,
    GovernoratesModule,
    PropertyFormOptionsModule,
    PropertyFormDefinitionsModule,
    PropertiesModule,
    BrokerApplicationsModule,
    PropertyPurposeCategoriesModule,
    ManagedMarketingModule,
    AuthorizationModule,
    AccountDeletionModule,
    GeocodingModule,
    FavoritesModule,
    OutboxModule,
    NotificationsModule,
    HealthModule,
    // MAZAD-028: development-only fake-payment settle route; its guard answers 404 outside local/development with the fake provider.
    FakePaymentsDevModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }, EnvironmentGuardService],
})
export class AppModule {}
