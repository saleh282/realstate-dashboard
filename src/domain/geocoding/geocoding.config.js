'use strict';

const PUBLIC_OSM_NOMINATIM_HOST = 'nominatim.openstreetmap.org';
const DEFAULT_PUBLIC_NOMINATIM_URL = `https://${PUBLIC_OSM_NOMINATIM_HOST}`;
const GEOCODING_OPTIONS = Symbol('GEOCODING_OPTIONS');
function isPublicOsmNominatim(baseUrl) {
  if (!baseUrl?.trim()) return true; // the provider default is the public service
  try {
    return new URL(baseUrl).hostname.toLowerCase() === PUBLIC_OSM_NOMINATIM_HOST;
  } catch {
    return false;
  }
}
function integer(raw, fallback, min = 0) {
  const parsed = raw && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : fallback;
}
/**
 * The public OpenStreetMap service allows about one request per second with no
 * parallelism, so it keeps the strict serial defaults. A self-hosted or
 * commercial endpoint (including Google) gets parallelism instead; every value
 * is overridable.
 */
function readGeocodingOptions(get) {
  const provider = (get('GEOCODING_PROVIDER') ?? 'nominatim').trim().toLowerCase() || 'nominatim';
  const publicOsm =
    provider === 'nominatim' && isPublicOsmNominatim(get('GEOCODING_PROVIDER_BASE_URL'));
  return {
    minIntervalMs: integer(get('GEOCODING_MIN_INTERVAL_MS'), publicOsm ? 1_100 : 0),
    maxConcurrency: integer(get('GEOCODING_MAX_CONCURRENCY'), publicOsm ? 1 : 4, 1),
    maxQueue: integer(get('GEOCODING_MAX_QUEUE'), 25, 1),
    queueTimeoutMs: integer(get('GEOCODING_QUEUE_TIMEOUT_MS'), 10_000, 1),
    cacheMaxEntries: integer(get('GEOCODING_CACHE_MAX_ENTRIES'), 2_000, 1),
  };
}

Object.assign(exports, {
  PUBLIC_OSM_NOMINATIM_HOST,
  DEFAULT_PUBLIC_NOMINATIM_URL,
  GEOCODING_OPTIONS,
  isPublicOsmNominatim,
  readGeocodingOptions,
});
