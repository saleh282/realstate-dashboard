import { Module } from '@nestjs/common';
import { GovernoratesModule } from '../governorates/governorates.module';
import { PropertyOptionsModule } from '../property-options/property-options.module';
import { PropertyFormOptionsController } from './property-form-options.controller';
import { PropertyPurposeCategoriesModule } from '../property-purpose-categories/property-purpose-categories.module';
import { PropertyTypesModule } from '../property-types/property-types.module';
@Module({ imports: [PropertyOptionsModule, GovernoratesModule, PropertyPurposeCategoriesModule, PropertyTypesModule], controllers: [PropertyFormOptionsController] })
export class PropertyFormOptionsModule {}
