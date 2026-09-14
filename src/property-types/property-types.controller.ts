import { Controller, Get } from '@nestjs/common';
import { PropertyTypesService } from './property-types.service';

@Controller('property-types')
export class PropertyTypesController {
  constructor(private readonly service: PropertyTypesService) {}

  @Get()
  list() {
    return this.service.listPublic();
  }
}
