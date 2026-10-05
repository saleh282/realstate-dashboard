'use strict';

const { ServiceUnavailableException } = require('../common/http/errors');
const GEOCODING_BUSY_CODE = 'GEOCODING_BUSY';
const DEFAULT_OPTIONS = {
  minIntervalMs: 1_100,
  maxConcurrency: 1,
  maxQueue: 25,
  queueTimeoutMs: 10_000,
  cacheMaxEntries: 2_000,
};
function busy() {
  return new ServiceUnavailableException({
    message: 'خدمة تحديد العنوان مشغولة حاليًا، حاول مرة أخرى بعد قليل',
    code: GEOCODING_BUSY_CODE,
    retryAfterSeconds: 5,
  });
}
class GeocodingService {
  constructor(provider, options) {
    this.provider = provider;
    // Map iteration order is insertion order, so re-inserting on read makes the
    // first key the least recently used.
    this.cache = new Map();
    this.inFlight = new Map();
    this.waiting = [];
    this.active = 0;
    this.nextStartAt = 0;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }
  get cacheSize() {
    return this.cache.size;
  }
  get queueLength() {
    return this.waiting.length;
  }
  reverse(latitude, longitude, language = 'ar') {
    const key = `reverse:${language}:${latitude.toFixed(5)},${longitude.toFixed(5)}`;
    return this.cached(key, 24 * 60 * 60_000, () =>
      this.provider.reverse(latitude, longitude, language),
    );
  }
  search(query, language = 'ar') {
    const normalized = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase(language);
    return this.cached(`search:${language}:${normalized}`, 10 * 60_000, () =>
      this.provider.search(normalized, language),
    );
  }
  cached(key, ttlMs, operation) {
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      if (cached.expiresAt > now) {
        this.cache.set(key, cached);
        return Promise.resolve(cached.value);
      }
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    let request;
    try {
      request = this.schedule(operation)
        .then((value) => {
          this.remember(key, { value, expiresAt: Date.now() + ttlMs });
          return value;
        })
        .finally(() => this.inFlight.delete(key));
    } catch (error) {
      return Promise.reject(error);
    }
    this.inFlight.set(key, request);
    return request;
  }
  remember(key, entry) {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.options.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
  /** Runs provider calls under the concurrency, spacing and queue-length limits. */
  schedule(operation) {
    if (this.waiting.length >= this.options.maxQueue) throw busy();
    return new Promise((resolve, reject) => {
      const job = {
        reject,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(job);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(busy());
        }, this.options.queueTimeoutMs),
        start: () => {
          clearTimeout(job.timer);
          this.active += 1;
          Promise.resolve()
            .then(operation)
            .then(resolve, reject)
            .finally(() => {
              this.active -= 1;
              this.pump();
            });
        },
      };
      job.timer.unref?.();
      this.waiting.push(job);
      this.pump();
    });
  }
  pump() {
    if (this.pumpTimer) return;
    while (this.active < this.options.maxConcurrency && this.waiting.length) {
      const wait = this.nextStartAt - Date.now();
      if (wait > 0) {
        this.pumpTimer = setTimeout(() => {
          this.pumpTimer = undefined;
          this.pump();
        }, wait);
        this.pumpTimer.unref?.();
        return;
      }
      this.nextStartAt = Date.now() + this.options.minIntervalMs;
      this.waiting.shift().start();
    }
  }
}

Object.assign(exports, { GEOCODING_BUSY_CODE, GeocodingService });
