import { Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { GEOCODING_OPTIONS, GeocodingOptions } from './geocoding.config';
import { GEOCODING_PROVIDER, GeocodingAddress, GeocodingPlace, GeocodingProvider } from './geocoding.types';

type CacheEntry<T> = { expiresAt: number; value: T };
type Job = { start: () => void; reject: (error: unknown) => void; timer: NodeJS.Timeout };

export const GEOCODING_BUSY_CODE = 'GEOCODING_BUSY';

const DEFAULT_OPTIONS: GeocodingOptions = {
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

@Injectable()
export class GeocodingService {
  private readonly options: GeocodingOptions;
  // Map iteration order is insertion order, so re-inserting on read makes the
  // first key the least recently used.
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly waiting: Job[] = [];
  private active = 0;
  private nextStartAt = 0;
  private pumpTimer?: NodeJS.Timeout;

  constructor(
    @Inject(GEOCODING_PROVIDER) private readonly provider: GeocodingProvider,
    @Optional() @Inject(GEOCODING_OPTIONS) options?: GeocodingOptions,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  get queueLength(): number {
    return this.waiting.length;
  }

  reverse(latitude: number, longitude: number, language = 'ar'): Promise<GeocodingAddress> {
    const key = `reverse:${language}:${latitude.toFixed(5)},${longitude.toFixed(5)}`;
    return this.cached(key, 24 * 60 * 60_000, () => this.provider.reverse(latitude, longitude, language));
  }

  search(query: string, language = 'ar'): Promise<GeocodingPlace[]> {
    const normalized = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase(language);
    return this.cached(`search:${language}:${normalized}`, 10 * 60_000, () => this.provider.search(normalized, language));
  }

  private cached<T>(key: string, ttlMs: number, operation: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.cache.get(key) as CacheEntry<T> | undefined;
    if (cached) {
      this.cache.delete(key);
      if (cached.expiresAt > now) {
        this.cache.set(key, cached);
        return Promise.resolve(cached.value);
      }
    }
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    let request: Promise<T>;
    try {
      request = this.schedule(operation).then((value) => {
        this.remember(key, { value, expiresAt: Date.now() + ttlMs });
        return value;
      }).finally(() => this.inFlight.delete(key));
    } catch (error) {
      return Promise.reject(error);
    }
    this.inFlight.set(key, request);
    return request;
  }

  private remember(key: string, entry: CacheEntry<unknown>): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.options.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Runs provider calls under the concurrency, spacing and queue-length limits. */
  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (this.waiting.length >= this.options.maxQueue) throw busy();
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
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

  private pump(): void {
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
      this.waiting.shift()!.start();
    }
  }
}
