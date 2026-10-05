'use strict';

const { canonicalize, sha256 } = require('../../services/idempotency.service');
const { MAX_PROPERTY_TYPES } = require('../properties/property-classification');
const {
  LEGACY_ATTRIBUTE_KEYS,
  LEGACY_PROPERTY_ATTRIBUTE_SEED,
} = require('../property-attributes/property-attribute.constants');
/**
 * Dynamic Property Form V1 (DPF-010): FormDefinition heads and immutable,
 * versioned FormDefinitionVersions. One head per property type (subcategory);
 * a revision always pins its PRIMARY type's version (multi-type amendment).
 */
/** The only renderer contract V1 clients understand (`formSchema=1`). */
const CURRENT_RENDERER_VERSION = 1;
const FORM_SCHEMA_VERSION = '1';
const MEDIA_PROFILES = ['residential_rooms', 'land', 'commercial_unit', 'industrial', 'generic'];
/** Profiles whose slot lists have shipped; the others wait for PD-1 (DPF-041). */
const SHIPPED_MEDIA_PROFILES = ['residential_rooms', 'generic'];
const FORM_DEFINITION_STATUSES = ['active', 'archived'];
const FORM_VERSION_STATES = ['draft', 'published', 'superseded'];
/** Publicly readable (immutable) version states. */
const READABLE_FORM_VERSION_STATES = ['published', 'superseded'];
const FORM_OPERATION_TYPES = ['sale', 'rent'];
const FORM_FIELD_WIDGETS = ['stepper', 'input', 'chips', 'dropdown'];
/** Widget hints a field of each data type may carry (DPF-031); boolean and date render one fixed control. */
const FORM_WIDGETS_BY_DATA_TYPE = {
  integer: ['stepper', 'input'],
  decimal: ['input'],
  text: ['input'],
  textarea: ['input'],
  boolean: [],
  singleSelect: ['chips', 'dropdown'],
  multiSelect: ['chips', 'dropdown'],
  date: [],
};
/** FieldDefinition properties reserved for later contract versions; rejected in V1. */
const RESERVED_FIELD_DEFINITION_PROPERTIES = [
  'visibleWhen',
  'sectionKey',
  'regex',
  'pattern',
  'facet',
  'indexed',
  'sortable',
  'filterable',
  'searchable',
  'default',
];
const PROPERTY_FORM_LIMITS = {
  maxFields: 60,
  maxVersionBytes: 64 * 1024,
  /** Serialized size of one field definition (DPF-031). */
  maxFieldBytes: 16 * 1024,
  changeNoteMaxLength: 500,
  archiveReasonMaxLength: 500,
  fieldOrderMin: 0,
  fieldOrderMax: 10_000,
  /** In-process cache of immutable version reads (DPF-015). */
  versionCacheSize: 500,
  /** Multi-type amendment (PD-8), advertised as `limits.maxPropertyTypes`. */
  maxPropertyTypes: MAX_PROPERTY_TYPES,
};
var FormDefinitionErrorCode;
(function (FormDefinitionErrorCode) {
  FormDefinitionErrorCode['NOT_FOUND'] = 'FORM_DEFINITION_NOT_FOUND';
  FormDefinitionErrorCode['EXISTS'] = 'FORM_DEFINITION_EXISTS';
  FormDefinitionErrorCode['VERSION_CONFLICT'] = 'FORM_DEFINITION_VERSION_CONFLICT';
  FormDefinitionErrorCode['DRAFT_EXISTS'] = 'FORM_DEFINITION_DRAFT_EXISTS';
  FormDefinitionErrorCode['NOT_DRAFT'] = 'FORM_DEFINITION_NOT_DRAFT';
  FormDefinitionErrorCode['PUBLISH_INVALID'] = 'FORM_DEFINITION_PUBLISH_INVALID';
  FormDefinitionErrorCode['NO_CHANGES'] = 'FORM_DEFINITION_NO_CHANGES';
  /** DPF-030..032 Admin lifecycle. */
  FormDefinitionErrorCode['DRAFT_NOT_FOUND'] = 'FORM_DEFINITION_DRAFT_NOT_FOUND';
  FormDefinitionErrorCode['DRAFT_INVALID'] = 'FORM_DEFINITION_DRAFT_INVALID';
  FormDefinitionErrorCode['ARCHIVED'] = 'FORM_DEFINITION_ARCHIVED';
  FormDefinitionErrorCode['NOT_ARCHIVED'] = 'FORM_DEFINITION_NOT_ARCHIVED';
  FormDefinitionErrorCode['TYPE_NOT_ELIGIBLE'] = 'FORM_DEFINITION_TYPE_NOT_ELIGIBLE';
  FormDefinitionErrorCode['CURRENT_VERSION_INVALID'] = 'FORM_DEFINITION_CURRENT_VERSION_INVALID';
})(FormDefinitionErrorCode || (FormDefinitionErrorCode = {}));
/**
 * sha256 hex of the canonical content (frozen §A3); identical content always
 * hashes identically. `allowedAmenityCodes` participates in the hash only
 * when present: `canonicalize` drops `undefined` values, so a version that
 * never sets it (every version published before Phase 11) hashes exactly as
 * it always has.
 */
function computeFormContentHash(content) {
  return sha256(
    canonicalize({
      rendererVersion: content.rendererVersion,
      fields: content.fields,
      mediaProfile: content.mediaProfile,
      amenitiesEnabled: content.amenitiesEnabled,
      allowedAmenityCodes: content.allowedAmenityCodes ?? undefined,
    }),
  );
}
/**
 * Frozen §H3: an old (pre-dynamic-form) client can still write this version.
 * A restricted amenity list is a Phase 11 (dynamic-form-only) concept an old
 * client cannot honor, so a version that carries one is never legacy writable.
 */
function computeLegacyWritable(content) {
  return (
    content.mediaProfile === 'residential_rooms' &&
    content.amenitiesEnabled === true &&
    content.allowedAmenityCodes === undefined &&
    content.fields
      .filter((field) => field.required)
      .every((field) => LEGACY_ATTRIBUTE_KEYS.includes(field.key))
  );
}
const seed = (key) => {
  const entry = LEGACY_PROPERTY_ATTRIBUTE_SEED.find((item) => item.key === key);
  if (!entry) throw new Error(`Missing registry seed for ${key}`);
  return entry;
};
const legacyInteger = (key, order, min, max, widget) => ({
  key,
  dataType: seed(key).dataType,
  labelAr: seed(key).labelAr,
  required: true,
  order,
  validation: { min, max },
  ...(widget ? { widget } : {}),
});
const legacyCatalog = (key, order) => ({
  key,
  dataType: seed(key).dataType,
  optionSource: seed(key).optionSource,
  catalogGroup: seed(key).catalogGroup,
  labelAr: seed(key).labelAr,
  required: true,
  order,
  widget: 'chips',
});
/**
 * Frozen §H1: today's fixed residential form. Seeded as published v1 for every
 * existing property type (M-B) and used by the read adapter for revisions that
 * predate FormDefinitions. Bounds equal today's DTO; widget hints mirror the
 * current app (counters for rooms/floors, chips for catalog selects).
 */
const LEGACY_RESIDENTIAL_FIELDS = [
  legacyInteger('bedrooms', 10, 1, 100, 'stepper'),
  legacyInteger('livingRooms', 20, 1, 100, 'stepper'),
  legacyInteger('kitchens', 30, 1, 100, 'stepper'),
  legacyInteger('bathrooms', 40, 1, 100, 'stepper'),
  legacyInteger('floor', 50, -10, 300, 'stepper'),
  legacyInteger('totalFloors', 60, 1, 300, 'stepper'),
  legacyInteger('buildingYear', 70, 1800, 2200),
  legacyCatalog('finishingStatus', 80),
  legacyCatalog('deliveryStatus', 90),
];
const LEGACY_RESIDENTIAL_CONTENT = {
  rendererVersion: CURRENT_RENDERER_VERSION,
  fields: LEGACY_RESIDENTIAL_FIELDS.map((field) => ({ ...field })),
  mediaProfile: 'residential_rooms',
  amenitiesEnabled: true,
};
const LEGACY_RESIDENTIAL_CONTENT_HASH = computeFormContentHash(LEGACY_RESIDENTIAL_CONTENT);

Object.assign(exports, {
  CURRENT_RENDERER_VERSION,
  FORM_SCHEMA_VERSION,
  MEDIA_PROFILES,
  SHIPPED_MEDIA_PROFILES,
  FORM_DEFINITION_STATUSES,
  FORM_VERSION_STATES,
  READABLE_FORM_VERSION_STATES,
  FORM_OPERATION_TYPES,
  FORM_FIELD_WIDGETS,
  FORM_WIDGETS_BY_DATA_TYPE,
  RESERVED_FIELD_DEFINITION_PROPERTIES,
  PROPERTY_FORM_LIMITS,
  FormDefinitionErrorCode,
  computeFormContentHash,
  computeLegacyWritable,
  LEGACY_RESIDENTIAL_FIELDS,
  LEGACY_RESIDENTIAL_CONTENT,
  LEGACY_RESIDENTIAL_CONTENT_HASH,
});
