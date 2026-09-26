/**
 * Dynamic Property Form V1 (DPF-010): the engineering-owned Attribute Registry
 * contract. Keys, data types, units, catalog links and option codes are
 * identity: they are set by seed/migration only and never change afterwards.
 */

export const PROPERTY_ATTRIBUTE_DATA_TYPES = ['text', 'textarea', 'integer', 'decimal', 'boolean', 'singleSelect', 'multiSelect', 'date'] as const;
export type PropertyAttributeDataType = (typeof PROPERTY_ATTRIBUTE_DATA_TYPES)[number];

/** Units are allowed on integer/decimal attributes only. */
export const PROPERTY_ATTRIBUTE_UNITS = ['sqm', 'm', 'kw'] as const;
export type PropertyAttributeUnit = (typeof PROPERTY_ATTRIBUTE_UNITS)[number];
export const PROPERTY_ATTRIBUTE_UNIT_LABELS_AR: Record<PropertyAttributeUnit, string> = { sqm: 'م²', m: 'م', kw: 'كيلوواط' };
export const PROPERTY_ATTRIBUTE_NUMERIC_TYPES: readonly PropertyAttributeDataType[] = ['integer', 'decimal'];
export const PROPERTY_ATTRIBUTE_SELECT_TYPES: readonly PropertyAttributeDataType[] = ['singleSelect', 'multiSelect'];

export const PROPERTY_ATTRIBUTE_OPTION_SOURCES = ['inline', 'catalog'] as const;
export type PropertyAttributeOptionSource = (typeof PROPERTY_ATTRIBUTE_OPTION_SOURCES)[number];
/** Closed list of live `property_options` groups a catalog-backed attribute may reference. */
export const PROPERTY_ATTRIBUTE_CATALOG_GROUPS = ['finishing_status', 'delivery_status'] as const;
export type PropertyAttributeCatalogGroup = (typeof PROPERTY_ATTRIBUTE_CATALOG_GROUPS)[number];

export const PROPERTY_ATTRIBUTE_STATUSES = ['active', 'deprecated'] as const;
export type PropertyAttributeStatus = (typeof PROPERTY_ATTRIBUTE_STATUSES)[number];
export const PROPERTY_ATTRIBUTE_OPTION_STATUSES = ['active', 'deprecated'] as const;
export const PROPERTY_ATTRIBUTE_ORIGINS = ['system'] as const;
/** Registry keys that may feed `Property.facets`; V1 promotes only bedrooms. */
export const PROPERTY_ATTRIBUTE_FACET_KEYS = ['bedrooms'] as const;

export const PROPERTY_ATTRIBUTE_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{1,39}$/;
export const PROPERTY_ATTRIBUTE_KEY_DENYLIST: readonly string[] = ['constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'];
/** First-class DTO/request names; an attribute may never shadow one of them. */
export const PROPERTY_ATTRIBUTE_RESERVED_KEYS: readonly string[] = [
  'area', 'title', 'description', 'operationType', 'purposeCategoryId', 'purposeSubcategoryId', 'governorateCode', 'city', 'district',
  'street', 'additionalAddressDetails', 'latitude', 'longitude', 'totalPriceMinor', 'currency', 'isPriceNegotiable', 'paymentMethodCodes',
  'marketingMode', 'amenityCodes', 'hidePhone', 'coverImageIndex', 'imageLabels', 'imageSlotIds', 'attributes', 'formDefinitionVersionId',
  'expectedRevisionVersion',
];
export const PROPERTY_ATTRIBUTE_OPTION_CODE_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

/** Hard limits of the V1 contract (registry bounds and transport). */
export const PROPERTY_ATTRIBUTE_LIMITS = {
  labelMaxLength: 80,
  helpMaxLength: 300,
  placeholderMaxLength: 80,
  textMaxLength: 200,
  textareaMaxLength: 2000,
  multiSelectMaxItems: 50,
  optionsMin: 1,
  optionsMax: 100,
  decimalMaxScale: 4,
  dateMin: '1800-01-01',
  dateMax: '2200-12-31',
  /** UTF-8 bytes of the multipart `attributes` JSON string. */
  attributesMaxBytes: 16_384,
  attributesMaxKeys: 60,
} as const;

/** Engineering-owned cross-field rules; Admin can never author rules. */
export const PROPERTY_ATTRIBUTE_CROSS_FIELD_RULES = ['floorNotAboveTotalFloors'] as const;
export type PropertyAttributeCrossFieldRule = (typeof PROPERTY_ATTRIBUTE_CROSS_FIELD_RULES)[number];

export function isAllowedAttributeKey(key: string): boolean {
  return PROPERTY_ATTRIBUTE_KEY_PATTERN.test(key) && !PROPERTY_ATTRIBUTE_KEY_DENYLIST.includes(key);
}

export type PropertyAttributeHardBounds = {
  min?: number;
  max?: number;
  scale?: number;
  maxLength?: number;
  minDate?: string;
  maxDate?: string;
  maxItems?: number;
};

export type PropertyAttributeSeed = {
  key: string;
  dataType: PropertyAttributeDataType;
  unit?: PropertyAttributeUnit;
  labelAr: string;
  labelEn?: string;
  hardBounds: PropertyAttributeHardBounds;
  optionSource?: PropertyAttributeOptionSource;
  catalogGroup?: PropertyAttributeCatalogGroup;
  facetKey?: (typeof PROPERTY_ATTRIBUTE_FACET_KEYS)[number];
};

/**
 * M-A seed (DPF-013). Only the attributes the current legacy property contract
 * actually stores; bounds are the schema bounds of the legacy fields (the
 * legacy definition narrows rooms to the DTO's 1-100). Non-residential
 * attributes arrive with DPF-044 after product input.
 */
export const LEGACY_PROPERTY_ATTRIBUTE_SEED: readonly PropertyAttributeSeed[] = [
  { key: 'bedrooms', dataType: 'integer', labelAr: 'غرف النوم', labelEn: 'Bedrooms', hardBounds: { min: 0, max: 100 }, facetKey: 'bedrooms' },
  { key: 'livingRooms', dataType: 'integer', labelAr: 'الصالات', labelEn: 'Living rooms', hardBounds: { min: 0, max: 100 } },
  { key: 'kitchens', dataType: 'integer', labelAr: 'المطابخ', labelEn: 'Kitchens', hardBounds: { min: 0, max: 100 } },
  { key: 'bathrooms', dataType: 'integer', labelAr: 'الحمامات', labelEn: 'Bathrooms', hardBounds: { min: 0, max: 100 } },
  { key: 'floor', dataType: 'integer', labelAr: 'الدور', labelEn: 'Floor', hardBounds: { min: -10, max: 300 } },
  { key: 'totalFloors', dataType: 'integer', labelAr: 'إجمالي الأدوار', labelEn: 'Total floors', hardBounds: { min: 1, max: 300 } },
  { key: 'buildingYear', dataType: 'integer', labelAr: 'سنة البناء', labelEn: 'Building year', hardBounds: { min: 1800, max: 2200 } },
  { key: 'finishingStatus', dataType: 'singleSelect', labelAr: 'حالة التشطيب', labelEn: 'Finishing', hardBounds: {}, optionSource: 'catalog', catalogGroup: 'finishing_status' },
  { key: 'deliveryStatus', dataType: 'singleSelect', labelAr: 'جاهزية التسليم', labelEn: 'Delivery', hardBounds: {}, optionSource: 'catalog', catalogGroup: 'delivery_status' },
];

/** Legacy flat revision/aggregate field -> registry key (frozen H2 mapping). */
export const LEGACY_SPEC_FIELD_TO_ATTRIBUTE: Readonly<Record<string, string>> = {
  bedrooms: 'bedrooms',
  livingRooms: 'livingRooms',
  kitchens: 'kitchens',
  bathrooms: 'bathrooms',
  floor: 'floor',
  totalFloors: 'totalFloors',
  buildingYear: 'buildingYear',
  finishingStatusCode: 'finishingStatus',
  deliveryStatusCode: 'deliveryStatus',
};
export const LEGACY_SPEC_FIELDS = Object.keys(LEGACY_SPEC_FIELD_TO_ATTRIBUTE);
export const LEGACY_ATTRIBUTE_KEYS = Object.values(LEGACY_SPEC_FIELD_TO_ATTRIBUTE);
