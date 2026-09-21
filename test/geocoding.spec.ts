import { GeocodingService } from '../src/geocoding/geocoding.service';
import { GeocodingProvider } from '../src/geocoding/geocoding.types';

describe('GeocodingService', () => {
  const address = { displayName: 'القاهرة، مصر', district: 'وسط البلد', street: 'طلعت حرب', additionalDetails: '', governorate: 'القاهرة', city: 'القاهرة' };

  it('deduplicates concurrent reverse requests and caches the result', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider: GeocodingProvider = {
      reverse: jest.fn(async () => { calls++; await gate; return address; }),
      search: jest.fn(),
    };
    const service = new GeocodingService(provider);
    const first = service.reverse(30.0444, 31.2357);
    const second = service.reverse(30.0444, 31.2357);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([address, address]);
    await expect(service.reverse(30.0444, 31.2357)).resolves.toEqual(address);
    expect(calls).toBe(1);
  });

  it('keeps search explicit and caches normalized identical searches', async () => {
    const provider: GeocodingProvider = {
      reverse: jest.fn(),
      search: jest.fn(async () => [{ ...address, latitude: 30, longitude: 31 }]),
    };
    const service = new GeocodingService(provider);
    await service.search('  Cairo  ', 'en');
    await service.search('cairo', 'en');
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(provider.search).toHaveBeenCalledWith('cairo', 'en');
  });

  it('does not cache provider failures', async () => {
    const provider: GeocodingProvider = {
      reverse: jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(address),
      search: jest.fn(),
    };
    const service = new GeocodingService(provider);
    await expect(service.reverse(30, 31)).rejects.toThrow('offline');
    await expect(service.reverse(30, 31)).resolves.toEqual(address);
    expect(provider.reverse).toHaveBeenCalledTimes(2);
  });
});
