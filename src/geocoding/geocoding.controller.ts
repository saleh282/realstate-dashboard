import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Capability } from '../authorization/capability';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { GeocodingService } from './geocoding.service';
import { ReverseGeocodingQueryDto, SearchGeocodingQueryDto } from './geocoding.dto';

@UseGuards(JwtAuthGuard, CapabilityGuard)
@RequireCapabilities(Capability.GEOCODING_USE)
@Controller('geocoding')
export class GeocodingController {
  constructor(private readonly service: GeocodingService) {}

  @Get('reverse')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  reverse(@Query() query: ReverseGeocodingQueryDto) {
    return this.service.reverse(query.latitude, query.longitude, query.language);
  }

  // The map picker searches as the user types (debounced), so allow a few
  // more calls than an explicit search button would need.
  @Get('search')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  search(@Query() query: SearchGeocodingQueryDto) {
    return this.service.search(query.query, query.language);
  }
}
