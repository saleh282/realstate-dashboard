import {
  LEGACY_SPEC_FIELD_TO_ATTRIBUTE,
  PROPERTY_ATTRIBUTE_LIMITS,
  PROPERTY_ATTRIBUTE_UNIT_LABELS_AR,
  type PropertyAttributeDataType,
  type PropertyAttributeUnit,
} from '../property-attributes/property-attribute.constants';
import { LEGACY_RESIDENTIAL_FIELDS, type FieldDefinition, type MediaProfile } from '../property-form-definitions/property-form-definition.constants';

/**
 * Read adapter (DPF-016, frozen §H2 and §D). The backend returns ready-to-render
 * historical meaning, so clients never reconstruct old FormDefinition
 * versions. A pinned revision is read through its exact pinned version (the
 * PRIMARY type's form); a legacy revision through the fixed legacy layout.
 * Nothing is ever defaulted and no revision document is ever rewritten.
 */

export type SpecificationValue = string | number | boolean | string[];
export type EffectiveSpec = {
  source: 'definition' | 'legacy';
  formDefinitionId: string | null;
  formDefinitionVersionId: string | null;
  formDefinitionVersion: number | null;
  formContentHash: string | null;
  attributes: Record<string, SpecificationValue>;
  /** Legacy: residential_rooms. Pinned: the pinned version's profile, when the version is supplied. */
  mediaProfile: MediaProfile | null;
};

export type SpecificationItem = {
  key: string;
  labelAr: string;
  labelEn: string | null;
  dataType: PropertyAttributeDataType;
  value: SpecificationValue;
  displayValueAr: string;
  unitLabelAr: string | null;
};
export type Specifications = {
  source: 'definition' | 'legacy';
  formDefinitionVersionId: string | null;
  formDefinitionVersion: number | null;
  items: SpecificationItem[];
};
/** Live catalog label for catalog-backed selects (PD-6); undefined when unknown. */
export type CatalogLabelLookup = (catalogGroup: string, code: string) => string | undefined;
export type PinnedVersionLike = { fields: readonly FieldDefinition[]; mediaProfile?: string };

export const isPinnedRecord = (record: any): boolean => Boolean(record?.formDefinitionVersionId);
const isValue = (value: unknown) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);

/** Frozen §H2: effective attributes of a revision (or, with no revision, of the aggregate). */
export function effectiveSpec(record: any, pinnedVersion?: PinnedVersionLike | null): EffectiveSpec {
  if (isPinnedRecord(record)) {
    const stored = record.attributes && typeof record.attributes === 'object' ? record.attributes : {};
    return {
      source: 'definition',
      formDefinitionId: record.formDefinitionId ? String(record.formDefinitionId) : null,
      formDefinitionVersionId: String(record.formDefinitionVersionId),
      formDefinitionVersion: record.formDefinitionVersion ?? null,
      formContentHash: record.formContentHash ?? null,
      attributes: Object.fromEntries(Object.keys(stored).filter((key) => isValue(stored[key])).map((key) => [key, stored[key]])),
      mediaProfile: (pinnedVersion?.mediaProfile as MediaProfile | undefined) ?? null,
    };
  }
  const attributes: Record<string, SpecificationValue> = {};
  for (const [field, key] of Object.entries(LEGACY_SPEC_FIELD_TO_ATTRIBUTE)) {
    if (isValue(record?.[field])) attributes[key] = record[field];
  }
  return { source: 'legacy', formDefinitionId: null, formDefinitionVersionId: null, formDefinitionVersion: null, formContentHash: null, attributes, mediaProfile: 'residential_rooms' };
}

/**
 * Deprecated flat spec fields (bedrooms, ..., finishingStatusCode,
 * deliveryStatusCode) derived from the effective attributes. Missing values
 * are omitted, never filled.
 */
export function deprecatedFlatFields(record: any): Record<string, SpecificationValue> {
  if (!isPinnedRecord(record)) {
    return Object.fromEntries(Object.keys(LEGACY_SPEC_FIELD_TO_ATTRIBUTE).filter((field) => record?.[field] !== undefined).map((field) => [field, record[field]]));
  }
  const { attributes } = effectiveSpec(record);
  return Object.fromEntries(Object.entries(LEGACY_SPEC_FIELD_TO_ATTRIBUTE).filter(([, key]) => attributes[key] !== undefined).map(([field, key]) => [field, attributes[key]]));
}

/** Frozen §D `specifications`: items in field order, provided values only. */
export function buildSpecifications(spec: EffectiveSpec, pinnedVersion: PinnedVersionLike | null | undefined, catalogLabel: CatalogLabelLookup): Specifications {
  const fields = spec.source === 'legacy' ? LEGACY_RESIDENTIAL_FIELDS : pinnedVersion?.fields;
  const items = fields
    ? [...fields].sort((a, b) => a.order - b.order).filter((field) => spec.attributes[field.key] !== undefined).map((field) => specificationItem(field, spec.attributes[field.key], catalogLabel))
    // The pinned version could not be loaded (an integrity failure): show the stored values rather than hide them.
    : Object.keys(spec.attributes).sort().map((key) => specificationItem(unknownField(key, spec.attributes[key]), spec.attributes[key], catalogLabel));
  return { source: spec.source, formDefinitionVersionId: spec.formDefinitionVersionId, formDefinitionVersion: spec.formDefinitionVersion, items };
}

function specificationItem(field: FieldDefinition, value: SpecificationValue, catalogLabel: CatalogLabelLookup): SpecificationItem {
  return {
    key: field.key,
    labelAr: field.labelAr,
    labelEn: field.labelEn ?? null,
    dataType: field.dataType,
    value,
    displayValueAr: displayValueAr(field, value, catalogLabel),
    unitLabelAr: field.unit ? PROPERTY_ATTRIBUTE_UNIT_LABELS_AR[field.unit as PropertyAttributeUnit] ?? null : null,
  };
}

function unknownField(key: string, value: SpecificationValue): FieldDefinition {
  const dataType: PropertyAttributeDataType = Array.isArray(value) ? 'multiSelect' : typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'decimal') : 'text';
  return { key, dataType, labelAr: key, required: false, order: 0 };
}

/** Frozen §D display rules (Western digits; نعم/لا; labels joined with "، "; DD/MM/YYYY). */
export function displayValueAr(field: FieldDefinition, value: SpecificationValue, catalogLabel: CatalogLabelLookup): string {
  const optionLabel = (code: string) => {
    if (field.optionSource === 'catalog') return (field.catalogGroup ? catalogLabel(field.catalogGroup, code) : undefined) ?? code;
    return field.options?.find((option) => option.code === code)?.labelAr ?? code;
  };
  switch (field.dataType) {
    case 'integer':
      return String(value);
    case 'decimal':
      return formatDecimal(value as number, field.validation?.scale ?? PROPERTY_ATTRIBUTE_LIMITS.decimalMaxScale);
    case 'boolean':
      return value === true ? 'نعم' : 'لا';
    case 'singleSelect':
      return optionLabel(String(value));
    case 'multiSelect':
      return (Array.isArray(value) ? value : [String(value)]).map(optionLabel).join('، ');
    case 'date': {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
      return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value);
    }
    default:
      return String(value);
  }
}

function formatDecimal(value: number, scale: number): string {
  if (!Number.isFinite(value)) return String(value);
  const fixed = value.toFixed(Math.min(Math.max(scale, 0), PROPERTY_ATTRIBUTE_LIMITS.decimalMaxScale));
  if (/e/i.test(fixed)) return String(value);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** Catalog codes a specification needs live labels for (legacy layout or the pinned version). */
export function catalogReferences(spec: EffectiveSpec, pinnedVersion: PinnedVersionLike | null | undefined): Array<{ catalogGroup: string; code: string }> {
  const fields = spec.source === 'legacy' ? LEGACY_RESIDENTIAL_FIELDS : pinnedVersion?.fields ?? [];
  return fields
    .filter((field) => field.optionSource === 'catalog' && field.catalogGroup && spec.attributes[field.key] !== undefined)
    .flatMap((field) => {
      const value = spec.attributes[field.key];
      return (Array.isArray(value) ? value : [value]).map((code) => ({ catalogGroup: field.catalogGroup!, code: String(code) }));
    });
}
