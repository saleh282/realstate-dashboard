import { canonicalize, sha256 } from '../common/idempotency/idempotency.service';
import { MAX_PROPERTY_TYPES } from '../properties/property-classification';
import {
  LEGACY_ATTRIBUTE_KEYS,
  LEGACY_PROPERTY_ATTRIBUTE_SEED,
  type PropertyAttributeCatalogGroup,
  type PropertyAttributeDataType,
  type PropertyAttributeOptionSource,
  type PropertyAttributeUnit,
} from '../property-attributes/property-attribute.constants';

/**
 * Dynamic Property Form V1 (DPF-010): FormDefinition heads and immutable,
 * versioned FormDefinitionVersions. One head per property type (subcategory);
 * a revision always pins its PRIMARY type's version (multi-type amendment).
 */

/** The only renderer contract V1 clients understand (`formSchema=1`). */
export const CURRENT_RENDERER_VERSION = 1;
export const FORM_SCHEMA_VERSION = '1';

export const MEDIA_PROFILES = ['residential_rooms', 'land', 'commercial_unit', 'industrial', 'generic'] as const;
export type MediaProfile = (typeof MEDIA_PROFILES)[number];
/** Profiles whose slot lists have shipped; the others wait for PD-1 (DPF-041). */
export const SHIPPED_MEDIA_PROFILES: readonly MediaProfile[] = ['residential_rooms', 'generic'];

export const FORM_DEFINITION_STATUSES = ['active', 'archived'] as const;
export type FormDefinitionStatus = (typeof FORM_DEFINITION_STATUSES)[number];
export const FORM_VERSION_STATES = ['draft', 'published', 'superseded'] as const;
export type FormVersionState = (typeof FORM_VERSION_STATES)[number];
/** Publicly readable (immutable) version states. */
export const READABLE_FORM_VERSION_STATES: readonly FormVersionState[] = ['published', 'superseded'];

export const FORM_OPERATION_TYPES = ['sale', 'rent'] as const;
export type FormOperationType = (typeof FORM_OPERATION_TYPES)[number];
export const FORM_FIELD_WIDGETS = ['stepper', 'input', 'chips', 'dropdown'] as const;
export type FormFieldWidget = (typeof FORM_FIELD_WIDGETS)[number];
/** FieldDefinition properties reserved for later contract versions; rejected in V1. */
export const RESERVED_FIELD_DEFINITION_PROPERTIES = ['visibleWhen', 'sectionKey', 'regex', 'pattern', 'facet', 'indexed', 'sortable', 'filterable', 'searchable', 'default'] as const;

export const PROPERTY_FORM_LIMITS = {
  maxFields: 60,
  maxVersionBytes: 64 * 1024,
  changeNoteMaxLength: 500,
  archiveReasonMaxLength: 500,
  fieldOrderMin: 0,
  fieldOrderMax: 10_000,
  /** In-process cache of immutable version reads (DPF-015). */
  versionCacheSize: 500,
  /** Multi-type amendment (PD-8), advertised as `limits.maxPropertyTypes`. */
  maxPropertyTypes: MAX_PROPERTY_TYPES,
} as const;

export enum FormDefinitionErrorCode {
  NOT_FOUND = 'FORM_DEFINITION_NOT_FOUND',
  EXISTS = 'FORM_DEFINITION_EXISTS',
  VERSION_CONFLICT = 'FORM_DEFINITION_VERSION_CONFLICT',
  DRAFT_EXISTS = 'FORM_DEFINITION_DRAFT_EXISTS',
  NOT_DRAFT = 'FORM_DEFINITION_NOT_DRAFT',
  PUBLISH_INVALID = 'FORM_DEFINITION_PUBLISH_INVALID',
  NO_CHANGES = 'FORM_DEFINITION_NO_CHANGES',
}

export type FieldValidation = {
  min?: number | string;
  max?: number | string;
  scale?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
};

export type FieldOption = { code: string; labelAr: string; labelEn?: string; order: number };

export type FieldDefinition = {
  key: string;
  dataType: PropertyAttributeDataType;
  unit?: PropertyAttributeUnit;
  optionSource?: PropertyAttributeOptionSource;
  catalogGroup?: PropertyAttributeCatalogGroup;
  labelAr: string;
  labelEn?: string;
  helpAr?: string;
  helpEn?: string;
  placeholderAr?: string;
  required: boolean;
  order: number;
  operations?: FormOperationType[];
  validation?: FieldValidation;
  options?: FieldOption[];
  widget?: FormFieldWidget;
};

/** The content that defines a version; everything else is lifecycle metadata. */
export type FormVersionContent = {
  rendererVersion: number;
  fields: FieldDefinition[];
  mediaProfile: MediaProfile;
  amenitiesEnabled: boolean;
};

/** sha256 hex of the canonical content (frozen §A3); identical content always hashes identically. */
export function computeFormContentHash(content: FormVersionContent): string {
  return sha256(canonicalize({
    rendererVersion: content.rendererVersion,
    fields: content.fields,
    mediaProfile: content.mediaProfile,
    amenitiesEnabled: content.amenitiesEnabled,
  }));
}

/** Frozen §H3: an old (pre-dynamic-form) client can still write this version. */
export function computeLegacyWritable(content: Pick<FormVersionContent, 'fields' | 'mediaProfile' | 'amenitiesEnabled'>): boolean {
  return content.mediaProfile === 'residential_rooms'
    && content.amenitiesEnabled === true
    && content.fields.filter((field) => field.required).every((field) => LEGACY_ATTRIBUTE_KEYS.includes(field.key));
}

const seed = (key: string) => {
  const entry = LEGACY_PROPERTY_ATTRIBUTE_SEED.find((item) => item.key === key);
  if (!entry) throw new Error(`Missing registry seed for ${key}`);
  return entry;
};
const legacyInteger = (key: string, order: number, min: number, max: number, widget?: FormFieldWidget): FieldDefinition => ({
  key, dataType: seed(key).dataType, labelAr: seed(key).labelAr, required: true, order, validation: { min, max }, ...(widget ? { widget } : {}),
});
const legacyCatalog = (key: string, order: number): FieldDefinition => ({
  key, dataType: seed(key).dataType, optionSource: seed(key).optionSource, catalogGroup: seed(key).catalogGroup, labelAr: seed(key).labelAr, required: true, order, widget: 'chips',
});

/**
 * Frozen §H1: today's fixed residential form. Seeded as published v1 for every
 * existing property type (M-B) and used by the read adapter for revisions that
 * predate FormDefinitions. Bounds equal today's DTO; widget hints mirror the
 * current app (counters for rooms/floors, chips for catalog selects).
 */
export const LEGACY_RESIDENTIAL_FIELDS: readonly FieldDefinition[] = [
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

export const LEGACY_RESIDENTIAL_CONTENT: FormVersionContent = {
  rendererVersion: CURRENT_RENDERER_VERSION,
  fields: LEGACY_RESIDENTIAL_FIELDS.map((field) => ({ ...field })),
  mediaProfile: 'residential_rooms',
  amenitiesEnabled: true,
};
export const LEGACY_RESIDENTIAL_CONTENT_HASH = computeFormContentHash(LEGACY_RESIDENTIAL_CONTENT);
