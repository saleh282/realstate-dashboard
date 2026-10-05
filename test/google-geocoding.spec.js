'use strict';
const { createGeocoding } = require('../src/config/geocoding');
const { Logger } = require('../src/common/logging/logger');
const { validateEnvironment } = require('../src/config/environment.validation');
const { readGeocodingOptions } = require('../src/domain/geocoding/geocoding.config');
const { GEOCODING_PROVIDER } = require('../src/domain/geocoding/geocoding.types');
const {
  GOOGLE_GEOCODING_URL,
  GOOGLE_PLACES_TEXT_SEARCH_URL,
  GoogleGeocodingProvider,
} = require('../src/domain/geocoding/google-geocoding.provider');
const KEY = 'SERVERKEY123';
const config = (values) => ({ get: (key) => values[key] });
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const status = (code) => ({ ok: false, status: code, json: async () => ({}) });
const google = () => new GoogleGeocodingProvider(config({ GOOGLE_MAPS_SERVER_API_KEY: KEY }));
describe('GoogleGeocodingProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });
  describe('reverse', () => {
    it('asks the Geocoding API in the requested language and merges fields across results', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        ok({
          status: 'OK',
          results: [
            {
              formatted_address: '25 شارع التحرير، الدقي، الجيزة، مصر',
              address_components: [
                { long_name: '25', types: ['street_number'] },
                { long_name: 'شارع التحرير', types: ['route'] },
                { long_name: 'قسم الدقي', types: ['administrative_area_level_2', 'political'] },
                { long_name: 'محافظة الجيزة', types: ['administrative_area_level_1', 'political'] },
              ],
            },
            {
              formatted_address: 'الدقي، الجيزة، مصر',
              address_components: [
                { long_name: 'الدقي', types: ['sublocality_level_1', 'sublocality', 'political'] },
                { long_name: 'الجيزة', types: ['locality', 'political'] },
                { long_name: '12611', types: ['postal_code'] },
              ],
            },
          ],
        }),
      );
      global.fetch = fetchMock;
      const address = await google().reverse(30.0384, 31.2122, 'ar');
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_GEOCODING_URL);
      expect(url.searchParams.get('latlng')).toBe('30.0384,31.2122');
      expect(url.searchParams.get('language')).toBe('ar');
      expect(url.searchParams.get('key')).toBe(KEY);
      expect(address).toEqual({
        displayName: '25 شارع التحرير، الدقي، الجيزة، مصر',
        district: 'الدقي',
        street: 'شارع التحرير',
        additionalDetails: '25، 12611',
        governorate: 'محافظة الجيزة',
        city: 'الجيزة',
      });
    });
    it('returns an empty address when Google knows nothing about the point', async () => {
      global.fetch = jest.fn().mockResolvedValue(ok({ status: 'ZERO_RESULTS', results: [] }));
      await expect(google().reverse(25, 30, 'ar')).resolves.toMatchObject({
        displayName: '',
        district: '',
        governorate: '',
      });
    });
    it('does not retry a rejected key and never logs the key', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const fetchMock = jest
        .fn()
        .mockResolvedValue(ok({ status: 'REQUEST_DENIED', error_message: 'bad key' }));
      global.fetch = fetchMock;
      await expect(google().reverse(30, 31, 'ar')).rejects.toMatchObject({ status: 502 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain(KEY);
    });
    it('retries a quota or server hiccup once, then fails without leaking the key', async () => {
      const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(ok({ status: 'OVER_QUERY_LIMIT' }))
        .mockResolvedValueOnce(status(503));
      global.fetch = fetchMock;
      const failure = await google()
        .reverse(30, 31, 'ar')
        .catch((error) => error);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(failure.status).toBe(503);
      expect(JSON.stringify(failure.getResponse())).not.toContain(KEY);
      expect(JSON.parse(String(errorLog.mock.calls[0][0]))).toEqual({
        event: 'geocoding_provider_unavailable',
        provider: 'google',
        failure: 'http_503',
      });
    });
    it('recovers when the retry succeeds', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce(
          ok({ status: 'OK', results: [{ formatted_address: 'x', address_components: [] }] }),
        );
      await expect(google().reverse(30, 31, 'ar')).resolves.toMatchObject({ displayName: 'x' });
    });
    it('fails closed when no server key is configured', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const fetchMock = jest.fn();
      global.fetch = fetchMock;
      await expect(
        new GoogleGeocodingProvider(config({})).reverse(30, 31, 'ar'),
      ).rejects.toMatchObject({ status: 503 });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
  describe('search', () => {
    it('uses Places Text Search limited to Egypt and maps the results', async () => {
      const fetchMock = jest.fn().mockResolvedValue(
        ok({
          places: [
            {
              displayName: { text: 'نادي الصيد' },
              formattedAddress: 'شارع نادي الصيد، الدقي، الجيزة، مصر',
              location: { latitude: 30.0435, longitude: 31.2069 },
              addressComponents: [
                { longText: 'الدقي', types: ['sublocality_level_1', 'sublocality'] },
                { longText: 'محافظة الجيزة', types: ['administrative_area_level_1'] },
              ],
            },
            { displayName: { text: 'بلا موقع' }, formattedAddress: 'x' },
          ],
        }),
      );
      global.fetch = fetchMock;
      const places = await google().search('نادي الصيد', 'ar');
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(GOOGLE_PLACES_TEXT_SEARCH_URL);
      expect(init.method).toBe('POST');
      expect(init.headers['X-Goog-Api-Key']).toBe(KEY);
      expect(init.headers['X-Goog-FieldMask']).toContain('places.location');
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        textQuery: 'نادي الصيد',
        languageCode: 'ar',
        regionCode: 'EG',
        pageSize: 5,
      });
      expect(body.locationRestriction.rectangle).toEqual({
        low: { latitude: 21.7, longitude: 24.6 },
        high: { latitude: 31.7, longitude: 36.9 },
      });
      expect(places).toEqual([
        {
          displayName: 'نادي الصيد، شارع نادي الصيد، الدقي، الجيزة، مصر',
          latitude: 30.0435,
          longitude: 31.2069,
          district: 'الدقي',
          street: '',
          additionalDetails: '',
          governorate: 'محافظة الجيزة',
          city: '',
        },
      ]);
    });
    it('treats an empty response as no matches', async () => {
      global.fetch = jest.fn().mockResolvedValue(ok({}));
      await expect(google().search('zzzz', 'ar')).resolves.toEqual([]);
    });
    it('rejects a malformed response', async () => {
      global.fetch = jest.fn().mockResolvedValue(ok({ places: 'nope' }));
      await expect(google().search('cairo', 'en')).rejects.toMatchObject({ status: 502 });
    });
    it('does not retry an invalid request', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const fetchMock = jest.fn().mockResolvedValue(status(400));
      global.fetch = fetchMock;
      await expect(google().search('cairo', 'en')).rejects.toMatchObject({ status: 502 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
describe('Google provider configuration', () => {
  it('is selected with GEOCODING_PROVIDER=google and does not warn about OpenStreetMap', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = createGeocoding({
      get: (key) => ({ GEOCODING_PROVIDER: 'google', GOOGLE_MAPS_SERVER_API_KEY: KEY })[key],
    });
    expect(moduleRef.provider).toBeInstanceOf(GoogleGeocodingProvider);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it('gets parallel defaults instead of the public OpenStreetMap limits', () => {
    const options = readGeocodingOptions((key) => ({ GEOCODING_PROVIDER: 'google' })[key]);
    expect(options.minIntervalMs).toBe(0);
    expect(options.maxConcurrency).toBe(4);
  });
  const dev = {
    NODE_ENV: 'development',
    MONGO_URI: 'mongodb://x',
    JWT_ACCESS_SECRET: 'a',
    JWT_REFRESH_SECRET: 'b',
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
  };
  const production = {
    NODE_ENV: 'production',
    MONGO_URI: 'mongodb://db/x',
    DEPLOYMENT_ENV: 'production',
    DB_ENV_ALLOWLIST: 'db/x',
    REALTIME_ENABLED: 'false',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
    MAIL_HOST: 'smtp.example.com',
    MAIL_PORT: '587',
    MAIL_SECURE: 'false',
    MAIL_USER: 'u',
    MAIL_PASS: 'p',
    MAIL_FROM: 'no-reply@example.com',
    MAIL_TLS_REJECT_UNAUTHORIZED: 'true',
    CLOUDINARY_CLOUD_NAME: 'c',
    CLOUDINARY_API_KEY: 'k',
    CLOUDINARY_API_SECRET: 's',
    CORS_ORIGINS: 'https://admin.example.com',
    TRUST_PROXY: '10.0.0.0/8',
  };
  it('requires the server key', () => {
    expect(() => validateEnvironment({ ...dev, GEOCODING_PROVIDER: 'google' })).toThrow(
      'GOOGLE_MAPS_SERVER_API_KEY is required',
    );
    expect(() =>
      validateEnvironment({
        ...dev,
        GEOCODING_PROVIDER: 'google',
        GOOGLE_MAPS_SERVER_API_KEY: KEY,
      }),
    ).not.toThrow();
  });
  it('is production-ready without any Nominatim settings', () => {
    expect(() =>
      validateEnvironment({
        ...production,
        GEOCODING_PROVIDER: 'google',
        GOOGLE_MAPS_SERVER_API_KEY: KEY,
      }),
    ).not.toThrow();
  });
});
