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

@Module({
  imports: [
    MongooseModule.forFeature([{ name: PropertyType.name, schema: PropertyTypeSchema }]),
    PropertyPurposeCategoriesModule,
    AuditModule,
    PassportModule,
  ],
  controllers: [PropertyTypesController, AdminPropertyTypesController],
  providers: [PropertyTypesService, RolesGuard],
  exports: [PropertyTypesService],
})
export class PropertyTypesModule {}
