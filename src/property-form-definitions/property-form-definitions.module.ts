import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { AuditModule } from '../audit/audit.module';
import { RolesGuard } from '../auth/roles.guard';
import { PropertyAttribute, PropertyAttributeSchema } from '../property-attributes/schemas/property-attribute.schema';
import { PropertyType, PropertyTypeSchema } from '../property-types/schemas/property-type.schema';
import { Amenity, AmenitySchema } from '../amenities/schemas/amenity.schema';
import { AdminPropertyAttributesController } from './admin-property-attributes.controller';
import { AdminPropertyFormDefinitionsController } from './admin-property-form-definitions.controller';
import { AdminPropertyFormDefinitionsService } from './admin-property-form-definitions.service';
import { PropertyFormDefinitionsController } from './property-form-definitions.controller';
import { PropertyFormDefinitionsService } from './property-form-definitions.service';
import { PropertyFormDefinition, PropertyFormDefinitionSchema } from './schemas/property-form-definition.schema';
import { PropertyFormDefinitionVersion, PropertyFormDefinitionVersionSchema } from './schemas/property-form-definition-version.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PropertyAttribute.name, schema: PropertyAttributeSchema },
      { name: PropertyFormDefinition.name, schema: PropertyFormDefinitionSchema },
      { name: PropertyFormDefinitionVersion.name, schema: PropertyFormDefinitionVersionSchema },
      // Read-only here (eligibility and names for the Admin builder); registered directly so this
      // module never depends on PropertyTypesModule, which imports it.
      { name: PropertyType.name, schema: PropertyTypeSchema },
      // Read-only here too (allowed-amenity-code validation for the Admin builder).
      { name: Amenity.name, schema: AmenitySchema },
    ]),
    AuditModule,
    PassportModule,
  ],
  controllers: [PropertyFormDefinitionsController, AdminPropertyFormDefinitionsController, AdminPropertyAttributesController],
  providers: [PropertyFormDefinitionsService, AdminPropertyFormDefinitionsService, RolesGuard],
  exports: [PropertyFormDefinitionsService, MongooseModule],
})
export class PropertyFormDefinitionsModule {}
