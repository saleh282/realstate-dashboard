import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { AuditModule } from '../audit/audit.module';
import { RolesGuard } from '../auth/roles.guard';
import { AdminPropertyTypesController } from './admin-property-types.controller';
import { PropertyTypesController } from './property-types.controller';
import { PropertyTypesService } from './property-types.service';
import { PropertyType, PropertyTypeSchema } from './schemas/property-type.schema';
import { PropertyPurposeCategoriesModule } from '../property-purpose-categories/property-purpose-categories.module';
import { Property, PropertySchema } from '../properties/schemas/property.schema';
import { PropertyRevision, PropertyRevisionSchema } from '../properties/schemas/property-revision.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PropertyType.name, schema: PropertyTypeSchema },
      // Read-only boundary for the reparent usage guard: registered here (not by importing
      // PropertiesModule) so PropertyTypesModule never depends on PropertiesModule.
      { name: Property.name, schema: PropertySchema },
      { name: PropertyRevision.name, schema: PropertyRevisionSchema },
    ]),
    PropertyPurposeCategoriesModule,
    AuditModule,
    PassportModule,
  ],
  controllers: [PropertyTypesController, AdminPropertyTypesController],
  providers: [PropertyTypesService, RolesGuard],
  exports: [PropertyTypesService],
})
export class PropertyTypesModule {}
