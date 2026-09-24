import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeocodingAddress, GeocodingPlace, GeocodingProvider } from './geocoding.types';

export const GOOGLE_GEOCODING_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
export const GOOGLE_PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

/** Egypt's bounding box, identical to the limits the reverse DTO accepts. */
const EGYPT_RECTANGLE = {
  low: { latitude: 21.7, longitude: 24.6 },
  high: { latitude: 31.7, longitude: 36.9 },
};

const PLACES_FIELD_MASK = [
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.addressComponents',
].join(',');

/** Geocoding API statuses worth one retry; every other non-OK status is final. */
const TRANSIENT_GEOCODING_STATUSES = new Set(['OVER_QUERY_LIMIT', 'UNKNOWN_ERROR']);

type Component = { name: string; types: string[] };

type GeocodingResult = {
  formatted_address?: string;
  address_components?: { long_name?: string; types?: string[] }[];
};

type PlacesResult = {
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  addressComponents?: { longText?: string; types?: string[] }[];
};

class TransientProviderError extends Error {
  constructor(readonly failure: string) {
    super(failure);
  }
}

/**
 * Google Maps Platform backend: the Geocoding API for reverse lookups and
 * Places API (New) Text Search for place search, both limited to Egypt.
 * Selected with GEOCODING_PROVIDER=google and keyed by
 * GOOGLE_MAPS_SERVER_API_KEY (a server key, never the mobile app's key).
 */
@Injectable()
export class GoogleGeocodingProvider implements GeocodingProvider {
  private readonly logger = new Logger(GoogleGeocodingProvider.name);

  constructor(private readonly config: ConfigService) {}

  async reverse(latitude: number, longitude: number, language: string): Promise<GeocodingAddress> {
    const url = new URL(GOOGLE_GEOCODING_URL);
    url.searchParams.set('latlng', `${latitude},${longitude}`);
    url.searchParams.set('language', language);
    url.searchParams.set('region', 'eg');
    url.searchParams.set('key', this.apiKey());

    const body = await this.withRetry(async () => {
      const response = await this.send(url, { headers: { Accept: 'application/json' } });
      const data = (await response.json()) as { status?: string; results?: unknown };
      const status = String(data?.status ?? '');
      if (status === 'OK' || status === 'ZERO_RESULTS') return data;
      if (TRANSIENT_GEOCODING_STATUSES.has(status)) throw new TransientProviderError(`status_${status}`);
      this.rejected({ status });
    });

    const results = Array.isArray(body.results) ? (body.results as GeocodingResult[]) : [];
    // Google returns several results for one point, from most to least
    // specific. The street-level one often lacks the neighbourhood, so each
    // field is taken from the first result that has it.
    const components = results.flatMap((result) =>
      (result.address_components ?? []).map((item) => ({
        name: String(item.long_name ?? '').trim(),
        types: Array.isArray(item.types) ? item.types : [],
      })),
    );
    return this.address(String(results[0]?.formatted_address ?? '').trim(), components);
  }

  async search(query: string, language: string): Promise<GeocodingPlace[]> {
    const body = await this.withRetry(async () => {
      const response = await this.send(new URL(GOOGLE_PLACES_TEXT_SEARCH_URL), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.apiKey(),
          'X-Goog-FieldMask': PLACES_FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery: query,
          languageCode: language,
          regionCode: 'EG',
          pageSize: 5,
          locationRestriction: { rectangle: EGYPT_RECTANGLE },
        }),
      });
      return (await response.json()) as { places?: unknown };
    });

    if (body === null || typeof body !== 'object') {
      throw new BadGatewayException('Geocoding provider returned an unexpected response');
    }
    // An empty result set comes back as `{}`.
    if (body.places === undefined) return [];
    if (!Array.isArray(body.places)) {
      throw new BadGatewayException('Geocoding provider returned an unexpected response');
    }

    return (body.places as PlacesResult[])
      .map((place) => {
        const name = String(place.displayName?.text ?? '').trim();
        const formatted = String(place.formattedAddress ?? '').trim();
        const displayName = name && formatted && !formatted.startsWith(name)
          ? `${name}، ${formatted}`
          : formatted || name;
        const components = (place.addressComponents ?? []).map((item) => ({
          name: String(item.longText ?? '').trim(),
          types: Array.isArray(item.types) ? item.types : [],
        }));
        return {
          ...this.address(displayName, components),
          latitude: Number(place.location?.latitude),
          longitude: Number(place.location?.longitude),
        };
      })
      .filter((item) => item.displayName && Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
  }

  private apiKey(): string {
    const key = this.config.get<string>('GOOGLE_MAPS_SERVER_API_KEY')?.trim();
    if (!key) {
      this.logger.error(JSON.stringify({ event: 'geocoding_provider_misconfigured', provider: 'google' }));
      throw new ServiceUnavailableException({ message: 'خدمة تحديد العنوان غير متاحة حاليًا' });
    }
    return key;
  }

  /**
   * One HTTP call. 429/5xx and network failures are transient; any other
   * non-2xx answer (bad key, API not enabled, invalid request) is final.
   * The URL can carry the API key, so it is never logged or put in an error.
   */
  private async send(url: URL, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
    } catch (error) {
      throw new TransientProviderError(
        error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'network',
      );
    }
    if (response.ok) return response;
    if (response.status === 429 || response.status >= 500) {
      throw new TransientProviderError(`http_${response.status}`);
    }
    this.rejected({ status: response.status });
  }

  private rejected(detail: { status: string | number }): never {
    this.logger.warn(JSON.stringify({ event: 'geocoding_provider_rejected', provider: 'google', ...detail }));
    throw new BadGatewayException('Geocoding provider rejected the request');
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let failure = 'unknown';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof TransientProviderError)) throw error;
        failure = error.failure;
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
    }
    this.logger.error(JSON.stringify({ event: 'geocoding_provider_unavailable', provider: 'google', failure }));
    throw new ServiceUnavailableException({ message: 'خدمة تحديد العنوان غير متاحة حاليًا' });
  }

  /**
   * Maps Google address components onto the app's address shape. In Egypt
   * `administrative_area_level_1` is the governorate and
   * `administrative_area_level_2` the markaz/qism (district-level area).
   */
  private address(displayName: string, components: Component[]): GeocodingAddress {
    const first = (...types: string[]) => {
      for (const type of types) {
        const match = components.find((item) => item.name && item.types.includes(type));
        if (match) return match.name;
      }
      return '';
    };
    const details = [first('street_number'), first('premise', 'subpremise'), first('postal_code')]
      .filter(Boolean)
      .join('، ');
    return {
      displayName,
      district: first(
        'neighborhood',
        'sublocality_level_1',
        'sublocality',
        'administrative_area_level_3',
        'administrative_area_level_2',
        'locality',
      ),
      street: first('route'),
      additionalDetails: details,
      governorate: first('administrative_area_level_1'),
      city: first('locality', 'administrative_area_level_2', 'postal_town'),
    };
  }
}
