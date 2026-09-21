import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { GeocodingAddress, GeocodingPlace, GeocodingProvider } from './geocoding.types';

/** Selected with GEOCODING_PROVIDER=disabled: address lookup is switched off. */
@Injectable()
export class DisabledGeocodingProvider implements GeocodingProvider {
  private unavailable(): never {
    throw new ServiceUnavailableException({ message: 'خدمة تحديد العنوان غير مفعلة' });
  }
  async reverse(): Promise<GeocodingAddress> { return this.unavailable(); }
  async search(): Promise<GeocodingPlace[]> { return this.unavailable(); }
}
