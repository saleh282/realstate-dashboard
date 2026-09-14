import { Controller, Get } from '@nestjs/common';
import { AmenitiesService } from './amenities.service';

@Controller('amenities')
export class AmenitiesController {
  constructor(private readonly service: AmenitiesService) {}
  @Get() list() { return this.service.listPublic(); }
}
