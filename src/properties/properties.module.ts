import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { Amenity, AmenitySchema } from '../amenities/schemas/amenity.schema';
import { Auction, AuctionSchema } from '../auctions/schemas/auction.schema';
import { Governorate, GovernorateSchema } from '../governorates/schemas/governorate.schema';
import { City, CitySchema } from '../governorates/schemas/city.schema';
import { PropertyOption, PropertyOptionSchema } from '../property-options/schemas/property-option.schema';
import { PropertyType, PropertyTypeSchema } from '../property-types/schemas/property-type.schema';
import { PropertiesController } from './properties.controller';
import { AdminPropertiesController } from './admin-properties.controller';
import { PropertiesService } from './properties.service';
import { Property, PropertySchema } from './schemas/property.schema';
import { AuditModule } from '../audit/audit.module';
import { RolesGuard } from '../auth/roles.guard';
import { CloudinaryModule } from '../config/cloudinary.module';
import { PropertyRevision, PropertyRevisionSchema } from './schemas/property-revision.schema';
import { PropertyPurposeCategoriesModule } from '../property-purpose-categories/property-purpose-categories.module';
import { UsersModule } from '../users/users.module';
import { PropertyAuctionLockService } from './property-auction-lock.service';
import { IdempotencyModule } from '../common/idempotency/idempotency.module';

@Module({
  imports: [PassportModule, AuditModule, IdempotencyModule, CloudinaryModule, PropertyPurposeCategoriesModule, UsersModule, MongooseModule.forFeature([
    { name: Property.name, schema: PropertySchema }, { name: PropertyType.name, schema: PropertyTypeSchema },
    { name: PropertyRevision.name, schema: PropertyRevisionSchema },
    { name: Amenity.name, schema: AmenitySchema }, { name: PropertyOption.name, schema: PropertyOptionSchema },
    { name: Governorate.name, schema: GovernorateSchema },
    { name: City.name, schema: CitySchema },
    // Read-only boundary for PropertyAuctionLockService (MAZAD-024): registered
    // here (not by importing AuctionsModule) so PropertiesModule never depends
    // on AuctionsModule, which already depends on PropertiesModule.
    { name: Auction.name, schema: AuctionSchema },
  ])],
  controllers: [PropertiesController, AdminPropertiesController],
  providers: [PropertiesService, RolesGuard, PropertyAuctionLockService],
  exports: [PropertiesService],
})
export class PropertiesModule {}
