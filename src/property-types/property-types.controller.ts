import { Controller, Get, Query } from '@nestjs/common';
import { creatableTypesForClient } from '../property-form-definitions/creatable-types';
import { supportsFormSchema } from '../property-form-definitions/form-schema';
import { PropertyFormDefinitionsService } from '../property-form-definitions/property-form-definitions.service';
import { PropertyTypesService } from './property-types.service';

@Controller('property-types')
export class PropertyTypesController {
  constructor(private readonly service: PropertyTypesService, private readonly formDefinitions: PropertyFormDefinitionsService) {}

  @Get()
  async list(@Query('formSchema') formSchema?: string) {
    const [result, pointers] = await Promise.all([this.service.listPublic(), this.formDefinitions.creationPointers()]);
    return { ...result, items: creatableTypesForClient(result.items, pointers, supportsFormSchema(formSchema)) };
  }
}
