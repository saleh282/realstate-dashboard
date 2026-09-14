import { Controller, Get } from '@nestjs/common'; import { PropertyOptionsService } from './property-options.service';
@Controller('property-options') export class PropertyOptionsController { constructor(private readonly service: PropertyOptionsService) {} @Get() list() { return this.service.listPublic(); } }
