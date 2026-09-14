import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { KycModule } from './kyc/kyc.module';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { validateEnvironment } from './config/environment.validation';
import { CloudinaryModule } from './config/cloudinary.module';
import { AdminModule } from './admin/admin.module';
import { PropertyTypesModule } from './property-types/property-types.module';
import { AmenitiesModule } from './amenities/amenities.module';
import { PropertyOptionsModule } from './property-options/property-options.module';
import { GovernoratesModule } from './governorates/governorates.module';
import { PropertyFormOptionsModule } from './property-form-options/property-form-options.module';
import { PropertiesModule } from './properties/properties.module';

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
    PropertiesModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
