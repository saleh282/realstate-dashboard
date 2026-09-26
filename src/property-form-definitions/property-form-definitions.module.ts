import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PropertyAttribute, PropertyAttributeSchema } from '../property-attributes/schemas/property-attribute.schema';
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
    ]),
  ],
  controllers: [PropertyFormDefinitionsController],
  providers: [PropertyFormDefinitionsService],
  exports: [PropertyFormDefinitionsService, MongooseModule],
})
export class PropertyFormDefinitionsModule {}
