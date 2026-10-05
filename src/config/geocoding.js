'use strict';
const {
  readGeocodingOptions,
  isPublicOsmNominatim,
} = require('../domain/geocoding/geocoding.config');
const { GoogleGeocodingProvider } = require('../domain/geocoding/google-geocoding.provider');
const { NominatimGeocodingProvider } = require('../domain/geocoding/nominatim-geocoding.provider');
const { DisabledGeocodingProvider } = require('../domain/geocoding/disabled-geocoding.provider');
const { GeocodingService } = require('../services/geocoding.service');
const { Logger } = require('../common/logging/logger');
function createGeocoding(config) {
  const name = String(config.get('GEOCODING_PROVIDER', 'nominatim')).trim().toLowerCase();
  const provider =
    name === 'google'
      ? new GoogleGeocodingProvider(config)
      : name === 'disabled'
        ? new DisabledGeocodingProvider()
        : new NominatimGeocodingProvider(config);
  if (
    provider instanceof NominatimGeocodingProvider &&
    isPublicOsmNominatim(config.get('GEOCODING_PROVIDER_BASE_URL'))
  ) {
    new Logger('Geocoding').warn(
      'Using the public OpenStreetMap Nominatim service. Configure a private or commercial endpoint for production.',
    );
  }
  return {
    provider,
    service: new GeocodingService(
      provider,
      readGeocodingOptions((key) => config.get(key)),
    ),
  };
}
module.exports = { createGeocoding };
