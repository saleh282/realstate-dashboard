import { Controller, Get } from '@nestjs/common';
import { PropertyPurposeCategoriesService } from './property-purpose-categories.service';

@Controller('property-purpose-categories')
export class PropertyPurposeCategoriesController {
  constructor(private readonly service: PropertyPurposeCategoriesService) {}
  @Get() list() { return this.service.listPublic(); }
}
