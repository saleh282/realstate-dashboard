export type GeocodingAddress = {
  displayName: string;
  district: string;
  street: string;
  additionalDetails: string;
  governorate: string;
  city: string;
};

export type GeocodingPlace = GeocodingAddress & {
  latitude: number;
  longitude: number;
};

export interface GeocodingProvider {
  reverse(latitude: number, longitude: number, language: string): Promise<GeocodingAddress>;
  search(query: string, language: string): Promise<GeocodingPlace[]>;
}

export const GEOCODING_PROVIDER = Symbol('GEOCODING_PROVIDER');
