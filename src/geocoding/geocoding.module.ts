import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeocodingController } from './geocoding.controller';
import { GEOCODING_OPTIONS, isPublicOsmNominatim, readGeocodingOptions } from './geocoding.config';
import { GeocodingService } from './geocoding.service';
import { GEOCODING_PROVIDER, GeocodingProvider } from './geocoding.types';
import { DisabledGeocodingProvider } from './disabled-geocoding.provider';
import { NominatimGeocodingProvider } from './nominatim-geocoding.provider';

// Add a new backend by registering it here; the service and API never change.
const PROVIDERS: Record<string, 'nominatim' | 'disabled'> = {
  nominatim: 'nominatim',
  disabled: 'disabled',
};

@Module({
  controllers: [GeocodingController],
  providers: [
    GeocodingService,
    NominatimGeocodingProvider,
    DisabledGeocodingProvider,
    {
      provide: GEOCODING_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => readGeocodingOptions((key) => config.get<string>(key)),
    },
    {
      provide: GEOCODING_PROVIDER,
      inject: [ConfigService, NominatimGeocodingProvider, DisabledGeocodingProvider],
      useFactory: (
        config: ConfigService,
        nominatim: NominatimGeocodingProvider,
        disabled: DisabledGeocodingProvider,
      ): GeocodingProvider => {
        const name = PROVIDERS[(config.get<string>('GEOCODING_PROVIDER') ?? 'nominatim').trim().toLowerCase()] ?? 'nominatim';
        if (name === 'nominatim' && isPublicOsmNominatim(config.get<string>('GEOCODING_PROVIDER_BASE_URL'))) {
          new Logger('Geocoding').warn(
            'Using the public OpenStreetMap Nominatim service. Its usage policy forbids production-scale use; configure GEOCODING_PROVIDER_BASE_URL for a self-hosted or commercial endpoint.',
          );
        }
        return name === 'disabled' ? disabled : nominatim;
      },
    },
  ],
  exports: [GeocodingService],
})
export class GeocodingModule {}
