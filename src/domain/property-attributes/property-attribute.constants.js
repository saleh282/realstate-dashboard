'use strict';

/**
 * Dynamic Property Form V1 (DPF-010): the engineering-owned Attribute Registry
 * contract. Keys, data types, units, catalog links and option codes are
 * identity: they are set by seed/migration only and never change afterwards.
 */
const PROPERTY_ATTRIBUTE_DATA_TYPES = [
  'text',
  'textarea',
  'integer',
  'decimal',
  'boolean',
  'singleSelect',
  'multiSelect',
  'date',
];
/** Units are allowed on integer/decimal attributes only. */
const PROPERTY_ATTRIBUTE_UNITS = ['sqm', 'm', 'kw'];
const PROPERTY_ATTRIBUTE_UNIT_LABELS_AR = { sqm: 'م²', m: 'م', kw: 'كيلوواط' };
const PROPERTY_ATTRIBUTE_NUMERIC_TYPES = ['integer', 'decimal'];
const PROPERTY_ATTRIBUTE_SELECT_TYPES = ['singleSelect', 'multiSelect'];
const PROPERTY_ATTRIBUTE_OPTION_SOURCES = ['inline', 'catalog'];
/** Closed list of live `property_options` groups a catalog-backed attribute may reference. */
const PROPERTY_ATTRIBUTE_CATALOG_GROUPS = ['finishing_status', 'delivery_status'];
const PROPERTY_ATTRIBUTE_STATUSES = ['active', 'deprecated'];
const PROPERTY_ATTRIBUTE_OPTION_STATUSES = ['active', 'deprecated'];
const PROPERTY_ATTRIBUTE_ORIGINS = ['system'];
/**
 * Registry keys that may feed `Property.facets`. V1 (DPF-023) promoted only
 * `bedrooms`; Phase 9 (Search & Facets) adds exactly 7 approved non-residential
 * keys. Adding a key here is a deliberate engineering promotion, never
 * automatic — see `030-phase9-facet-promotion.ts`.
 */
const PROPERTY_ATTRIBUTE_FACET_KEYS = [
  'bedrooms',
  'shopFloorLevel',
  'commercialUseTypes',
  'builtAreaSqm',
  'powerSource',
  'industrialUseType',
  'soilType',
  'waterSource',
];
const PROPERTY_ATTRIBUTE_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{1,39}$/;
const PROPERTY_ATTRIBUTE_KEY_DENYLIST = [
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
];
/** First-class DTO/request names; an attribute may never shadow one of them. */
const PROPERTY_ATTRIBUTE_RESERVED_KEYS = [
  'area',
  'title',
  'description',
  'operationType',
  'purposeCategoryId',
  'purposeSubcategoryId',
  'governorateCode',
  'city',
  'district',
  'street',
  'additionalAddressDetails',
  'latitude',
  'longitude',
  'totalPriceMinor',
  'currency',
  'isPriceNegotiable',
  'paymentMethodCodes',
  'marketingMode',
  'amenityCodes',
  'hidePhone',
  'coverImageIndex',
  'imageLabels',
  'imageSlotIds',
  'attributes',
  'formDefinitionVersionId',
  'expectedRevisionVersion',
];
const PROPERTY_ATTRIBUTE_OPTION_CODE_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
/** Hard limits of the V1 contract (registry bounds and transport). */
const PROPERTY_ATTRIBUTE_LIMITS = {
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
};
/** Engineering-owned cross-field rules; Admin can never author rules. */
const PROPERTY_ATTRIBUTE_CROSS_FIELD_RULES = ['floorNotAboveTotalFloors'];
function isAllowedAttributeKey(key) {
  return PROPERTY_ATTRIBUTE_KEY_PATTERN.test(key) && !PROPERTY_ATTRIBUTE_KEY_DENYLIST.includes(key);
}
/**
 * M-A seed (DPF-013). Only the attributes the current legacy property contract
 * actually stores; bounds are the schema bounds of the legacy fields (the
 * legacy definition narrows rooms to the DTO's 1-100). Non-residential
 * attributes arrive with DPF-044 after product input.
 */
const LEGACY_PROPERTY_ATTRIBUTE_SEED = [
  {
    key: 'bedrooms',
    dataType: 'integer',
    labelAr: 'غرف النوم',
    labelEn: 'Bedrooms',
    hardBounds: { min: 0, max: 100 },
    facetKey: 'bedrooms',
  },
  {
    key: 'livingRooms',
    dataType: 'integer',
    labelAr: 'الصالات',
    labelEn: 'Living rooms',
    hardBounds: { min: 0, max: 100 },
  },
  {
    key: 'kitchens',
    dataType: 'integer',
    labelAr: 'المطابخ',
    labelEn: 'Kitchens',
    hardBounds: { min: 0, max: 100 },
  },
  {
    key: 'bathrooms',
    dataType: 'integer',
    labelAr: 'الحمامات',
    labelEn: 'Bathrooms',
    hardBounds: { min: 0, max: 100 },
  },
  {
    key: 'floor',
    dataType: 'integer',
    labelAr: 'الدور',
    labelEn: 'Floor',
    hardBounds: { min: -10, max: 300 },
  },
  {
    key: 'totalFloors',
    dataType: 'integer',
    labelAr: 'إجمالي الأدوار',
    labelEn: 'Total floors',
    hardBounds: { min: 1, max: 300 },
  },
  {
    key: 'buildingYear',
    dataType: 'integer',
    labelAr: 'سنة البناء',
    labelEn: 'Building year',
    hardBounds: { min: 1800, max: 2200 },
  },
  {
    key: 'finishingStatus',
    dataType: 'singleSelect',
    labelAr: 'حالة التشطيب',
    labelEn: 'Finishing',
    hardBounds: {},
    optionSource: 'catalog',
    catalogGroup: 'finishing_status',
  },
  {
    key: 'deliveryStatus',
    dataType: 'singleSelect',
    labelAr: 'جاهزية التسليم',
    labelEn: 'Delivery',
    hardBounds: {},
    optionSource: 'catalog',
    catalogGroup: 'delivery_status',
  },
];
/** Legacy flat revision/aggregate field -> registry key (frozen H2 mapping). */
const LEGACY_SPEC_FIELD_TO_ATTRIBUTE = {
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
const LEGACY_SPEC_FIELDS = Object.keys(LEGACY_SPEC_FIELD_TO_ATTRIBUTE);
const LEGACY_ATTRIBUTE_KEYS = Object.values(LEGACY_SPEC_FIELD_TO_ATTRIBUTE);

Object.assign(exports, {
  PROPERTY_ATTRIBUTE_DATA_TYPES,
  PROPERTY_ATTRIBUTE_UNITS,
  PROPERTY_ATTRIBUTE_UNIT_LABELS_AR,
  PROPERTY_ATTRIBUTE_NUMERIC_TYPES,
  PROPERTY_ATTRIBUTE_SELECT_TYPES,
  PROPERTY_ATTRIBUTE_OPTION_SOURCES,
  PROPERTY_ATTRIBUTE_CATALOG_GROUPS,
  PROPERTY_ATTRIBUTE_STATUSES,
  PROPERTY_ATTRIBUTE_OPTION_STATUSES,
  PROPERTY_ATTRIBUTE_ORIGINS,
  PROPERTY_ATTRIBUTE_FACET_KEYS,
  PROPERTY_ATTRIBUTE_KEY_PATTERN,
  PROPERTY_ATTRIBUTE_KEY_DENYLIST,
  PROPERTY_ATTRIBUTE_RESERVED_KEYS,
  PROPERTY_ATTRIBUTE_OPTION_CODE_PATTERN,
  PROPERTY_ATTRIBUTE_LIMITS,
  PROPERTY_ATTRIBUTE_CROSS_FIELD_RULES,
  isAllowedAttributeKey,
  LEGACY_PROPERTY_ATTRIBUTE_SEED,
  LEGACY_SPEC_FIELD_TO_ATTRIBUTE,
  LEGACY_SPEC_FIELDS,
  LEGACY_ATTRIBUTE_KEYS,
});
