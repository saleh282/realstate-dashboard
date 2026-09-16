import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { Amenity, AmenitySchema } from '../amenities/schemas/amenity.schema';
import { Governorate, GovernorateSchema } from '../governorates/schemas/governorate.schema';
import { PropertyOption, PropertyOptionSchema } from '../property-options/schemas/property-option.schema';
import { PropertyType, PropertyTypeSchema } from '../property-types/schemas/property-type.schema';
import { PropertiesController } from './properties.controller';
import { AdminPropertiesController } from './admin-properties.controller';
import { PropertiesService } from './properties.service';
import { Property, PropertySchema } from './schemas/property.schema';
import { AuditModule } from '../audit/audit.module';
import { RolesGuard } from '../auth/roles.guard';
import { CloudinaryModule } from '../config/cloudinary.module';

@Module({
  imports: [PassportModule, AuditModule, CloudinaryModule, MongooseModule.forFeature([
    { name: Property.name, schema: PropertySchema }, { name: PropertyType.name, schema: PropertyTypeSchema },
    { name: Amenity.name, schema: AmenitySchema }, { name: PropertyOption.name, schema: PropertyOptionSchema },
    { name: Governorate.name, schema: GovernorateSchema },
  ])],
  controllers: [PropertiesController, AdminPropertiesController],
  providers: [PropertiesService, RolesGuard],
  exports: [PropertiesService],
})
export class PropertiesModule {}
