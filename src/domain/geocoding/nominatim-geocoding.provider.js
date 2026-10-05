'use strict';

const { BadGatewayException, ServiceUnavailableException } = require('../../common/http/errors');
const { Logger } = require('../../common/logging/logger');
const { DEFAULT_PUBLIC_NOMINATIM_URL } = require('./geocoding.config');
/**
 * Speaks the Nominatim HTTP API. It works against a self-hosted Nominatim or
 * any hosted service that exposes the same /search and /reverse contract; the
 * endpoint, User-Agent and optional API key all come from configuration.
 */
class NominatimGeocodingProvider {
  constructor(config) {
    this.config = config;
    this.logger = new Logger(NominatimGeocodingProvider.name);
  }
  async reverse(latitude, longitude, language) {
    const data = await this.request('/reverse', {
      lat: String(latitude),
      lon: String(longitude),
      format: 'jsonv2',
      addressdetails: '1',
      namedetails: '1',
      zoom: '18',
      'accept-language': `${language},${language === 'ar' ? 'en' : 'ar'};q=0.8`,
    });
    return this.address(data);
  }
  async search(query, language) {
    const data = await this.request('/search', {
      q: query,
      format: 'jsonv2',
      addressdetails: '1',
      limit: '5',
      countrycodes: 'eg',
      'accept-language': `${language},${language === 'ar' ? 'en' : 'ar'};q=0.8`,
    });
    if (!Array.isArray(data))
      throw new BadGatewayException('Geocoding provider returned an unexpected response');
    return data
      .map((item) => ({
        ...this.address(item),
        latitude: Number(item.lat),
        longitude: Number(item.lon),
      }))
      .filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
  }
  async request(path, params) {
    const baseUrl =
      this.config.get('GEOCODING_PROVIDER_BASE_URL')?.trim() || DEFAULT_PUBLIC_NOMINATIM_URL;
    const userAgent =
      this.config.get('GEOCODING_USER_AGENT')?.trim() ||
      'MazadakRealEstate/1.0 (backend geocoding proxy)';
    const apiKey = this.config.get('GEOCODING_API_KEY')?.trim();
    const apiKeyParam = this.config.get('GEOCODING_API_KEY_PARAM')?.trim() || 'key';
    const url = new URL(path, baseUrl);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    if (apiKey) url.searchParams.set(apiKeyParam, apiKey);
    // The URL can carry the API key, so it is never logged or put in an error.
    let failure = 'unknown';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': userAgent },
          signal: AbortSignal.timeout(8_000),
        });
        if (response.ok) return await response.json();
        if (response.status !== 429 && response.status < 500) {
          this.logger.warn(
            JSON.stringify({ event: 'geocoding_provider_rejected', status: response.status }),
          );
          throw new BadGatewayException('Geocoding provider rejected the request');
        }
        failure = `http_${response.status}`;
      } catch (error) {
        if (error instanceof BadGatewayException) throw error;
        failure =
          error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'network';
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
    }
    this.logger.error(JSON.stringify({ event: 'geocoding_provider_unavailable', failure }));
    throw new ServiceUnavailableException({ message: 'خدمة تحديد العنوان غير متاحة حاليًا' });
  }
  address(item) {
    const raw = item.address && typeof item.address === 'object' ? item.address : {};
    const first = (...keys) => {
      for (const key of keys) {
        const value = String(raw[key] ?? '').trim();
        if (value) return value;
      }
      return '';
    };
    const details = [first('house_number'), first('building'), first('postcode')]
      .filter(Boolean)
      .join('، ');
    return {
      displayName: String(item.display_name ?? '').trim(),
      district: first(
        'neighbourhood',
        'suburb',
        'quarter',
        'city_district',
        'district',
        'borough',
        'municipality',
        'town',
        'village',
        'city',
      ),
      street: first('road', 'pedestrian', 'footway', 'path', 'residential'),
      additionalDetails: details,
      governorate: first('state', 'governorate', 'state_district'),
      city: first('city', 'town', 'village', 'municipality'),
    };
  }
}

Object.assign(exports, { NominatimGeocodingProvider });
