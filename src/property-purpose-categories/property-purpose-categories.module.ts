import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { AuditModule } from '../audit/audit.module';
import { RolesGuard } from '../auth/roles.guard';
import { AdminPropertyPurposeCategoriesController } from './admin-property-purpose-categories.controller';
import { PropertyPurposeCategoriesController } from './property-purpose-categories.controller';
import { PropertyPurposeCategoriesService } from './property-purpose-categories.service';
import { PropertyPurposeCategory, PropertyPurposeCategorySchema } from './schemas/property-purpose-category.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: PropertyPurposeCategory.name, schema: PropertyPurposeCategorySchema }]), AuditModule, PassportModule],
  controllers: [PropertyPurposeCategoriesController, AdminPropertyPurposeCategoriesController],
  providers: [PropertyPurposeCategoriesService, RolesGuard],
  exports: [PropertyPurposeCategoriesService, MongooseModule],
})
export class PropertyPurposeCategoriesModule {}
