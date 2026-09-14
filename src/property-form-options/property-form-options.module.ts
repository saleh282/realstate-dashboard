import { Module } from '@nestjs/common';
import { GovernoratesModule } from '../governorates/governorates.module';
import { PropertyOptionsModule } from '../property-options/property-options.module';
import { PropertyFormOptionsController } from './property-form-options.controller';
@Module({ imports: [PropertyOptionsModule, GovernoratesModule], controllers: [PropertyFormOptionsController] })
export class PropertyFormOptionsModule {}
