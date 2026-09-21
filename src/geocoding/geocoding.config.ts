export const PUBLIC_OSM_NOMINATIM_HOST = 'nominatim.openstreetmap.org';
export const DEFAULT_PUBLIC_NOMINATIM_URL = `https://${PUBLIC_OSM_NOMINATIM_HOST}`;

export const GEOCODING_OPTIONS = Symbol('GEOCODING_OPTIONS');

export type GeocodingOptions = {
  /** Minimum gap between the start of two provider calls. */
  minIntervalMs: number;
  /** Provider calls allowed to run at once. */
  maxConcurrency: number;
  /** Provider calls allowed to wait; more are rejected immediately. */
  maxQueue: number;
  /** How long a call may wait for a slot before it is rejected. */
  queueTimeoutMs: number;
  /** Upper bound on cached responses (least recently used are evicted). */
  cacheMaxEntries: number;
};

export function isPublicOsmNominatim(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return true; // the provider default is the public service
  try {
    return new URL(baseUrl).hostname.toLowerCase() === PUBLIC_OSM_NOMINATIM_HOST;
  } catch {
    return false;
  }
}

function integer(raw: string | undefined, fallback: number, min = 0): number {
  const parsed = raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : fallback;
}

/**
 * The public OpenStreetMap service allows about one request per second with no
 * parallelism, so it keeps the strict serial defaults. A self-hosted or
 * commercial endpoint gets parallelism instead; every value is overridable.
 */
export function readGeocodingOptions(get: (key: string) => string | undefined): GeocodingOptions {
  const publicOsm = isPublicOsmNominatim(get('GEOCODING_PROVIDER_BASE_URL'));
  return {
    minIntervalMs: integer(get('GEOCODING_MIN_INTERVAL_MS'), publicOsm ? 1_100 : 0),
    maxConcurrency: integer(get('GEOCODING_MAX_CONCURRENCY'), publicOsm ? 1 : 4, 1),
    maxQueue: integer(get('GEOCODING_MAX_QUEUE'), 25, 1),
    queueTimeoutMs: integer(get('GEOCODING_QUEUE_TIMEOUT_MS'), 10_000, 1),
    cacheMaxEntries: integer(get('GEOCODING_CACHE_MAX_ENTRIES'), 2_000, 1),
  };
}
