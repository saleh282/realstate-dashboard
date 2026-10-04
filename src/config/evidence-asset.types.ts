export enum AssetClassification {
  PUBLIC_PROPERTY_MEDIA = 'public_property_media',
  PUBLIC_PROFILE_PHOTO = 'public_profile_photo',
  PRIVATE_PROPERTY_EVIDENCE = 'private_property_evidence',
  PRIVATE_KYC_EVIDENCE = 'private_kyc_evidence',
  PRIVATE_BROKER_EVIDENCE = 'private_broker_evidence',
}

export type EvidenceResourceType = 'image' | 'raw';
export type EvidenceDeliveryType = 'authenticated' | 'upload';

export interface StoredAssetMetadata {
  publicId: string;
  resourceType: EvidenceResourceType;
  deliveryType: EvidenceDeliveryType;
  classification: AssetClassification;
  format?: 'jpg' | 'jpeg' | 'png' | 'webp' | 'pdf';
  bytes?: number;
  /** Legacy compatibility only. New private evidence never stores a delivery URL. */
  secureUrl?: string;
}
