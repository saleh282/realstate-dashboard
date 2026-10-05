'use strict';

const {
  LEGACY_SPEC_FIELD_TO_ATTRIBUTE,
  PROPERTY_ATTRIBUTE_LIMITS,
  PROPERTY_ATTRIBUTE_UNIT_LABELS_AR,
} = require('../property-attributes/property-attribute.constants');
const {
  LEGACY_RESIDENTIAL_FIELDS,
} = require('../property-form-definitions/property-form-definition.constants');
const isPinnedRecord = (record) => Boolean(record?.formDefinitionVersionId);
const isValue = (value) =>
  value !== undefined &&
  value !== null &&
  value !== '' &&
  !(Array.isArray(value) && value.length === 0);
/** Frozen §H2: effective attributes of a revision (or, with no revision, of the aggregate). */
function effectiveSpec(record, pinnedVersion) {
  if (isPinnedRecord(record)) {
    const stored =
      record.attributes && typeof record.attributes === 'object' ? record.attributes : {};
    return {
      source: 'definition',
      formDefinitionId: record.formDefinitionId ? String(record.formDefinitionId) : null,
      formDefinitionVersionId: String(record.formDefinitionVersionId),
      formDefinitionVersion: record.formDefinitionVersion ?? null,
      formContentHash: record.formContentHash ?? null,
      attributes: Object.fromEntries(
        Object.keys(stored)
          .filter((key) => isValue(stored[key]))
          .map((key) => [key, stored[key]]),
      ),
      mediaProfile: pinnedVersion?.mediaProfile ?? null,
    };
  }
  const attributes = {};
  for (const [field, key] of Object.entries(LEGACY_SPEC_FIELD_TO_ATTRIBUTE)) {
    if (isValue(record?.[field])) attributes[key] = record[field];
  }
  return {
    source: 'legacy',
    formDefinitionId: null,
    formDefinitionVersionId: null,
    formDefinitionVersion: null,
    formContentHash: null,
    attributes,
    mediaProfile: 'residential_rooms',
  };
}
/**
 * Deprecated flat spec fields (bedrooms, ..., finishingStatusCode,
 * deliveryStatusCode) derived from the effective attributes. Missing values
 * are omitted, never filled.
 */
function deprecatedFlatFields(record) {
  if (!isPinnedRecord(record)) {
    return Object.fromEntries(
      Object.keys(LEGACY_SPEC_FIELD_TO_ATTRIBUTE)
        .filter((field) => record?.[field] !== undefined)
        .map((field) => [field, record[field]]),
    );
  }
  const { attributes } = effectiveSpec(record);
  return Object.fromEntries(
    Object.entries(LEGACY_SPEC_FIELD_TO_ATTRIBUTE)
      .filter(([, key]) => attributes[key] !== undefined)
      .map(([field, key]) => [field, attributes[key]]),
  );
}
/** Frozen §D `specifications`: items in field order, provided values only. */
function buildSpecifications(spec, pinnedVersion, catalogLabel) {
  const fields = spec.source === 'legacy' ? LEGACY_RESIDENTIAL_FIELDS : pinnedVersion?.fields;
  const items = fields
    ? [...fields]
        .sort((a, b) => a.order - b.order)
        .filter((field) => spec.attributes[field.key] !== undefined)
        .map((field) => specificationItem(field, spec.attributes[field.key], catalogLabel))
    : // The pinned version could not be loaded (an integrity failure): show the stored values rather than hide them.
      Object.keys(spec.attributes)
        .sort()
        .map((key) =>
          specificationItem(
            unknownField(key, spec.attributes[key]),
            spec.attributes[key],
            catalogLabel,
          ),
        );
  return {
    source: spec.source,
    formDefinitionVersionId: spec.formDefinitionVersionId,
    formDefinitionVersion: spec.formDefinitionVersion,
    items,
  };
}
function specificationItem(field, value, catalogLabel) {
  return {
    key: field.key,
    labelAr: field.labelAr,
    labelEn: field.labelEn ?? null,
    dataType: field.dataType,
    value,
    displayValueAr: displayValueAr(field, value, catalogLabel),
    unitLabelAr: field.unit ? (PROPERTY_ATTRIBUTE_UNIT_LABELS_AR[field.unit] ?? null) : null,
  };
}
function unknownField(key, value) {
  const dataType = Array.isArray(value)
    ? 'multiSelect'
    : typeof value === 'boolean'
      ? 'boolean'
      : typeof value === 'number'
        ? Number.isInteger(value)
          ? 'integer'
          : 'decimal'
        : 'text';
  return { key, dataType, labelAr: key, required: false, order: 0 };
}
/** Frozen §D display rules (Western digits; نعم/لا; labels joined with "، "; DD/MM/YYYY). */
function displayValueAr(field, value, catalogLabel) {
  const optionLabel = (code) => {
    if (field.optionSource === 'catalog')
      return (field.catalogGroup ? catalogLabel(field.catalogGroup, code) : undefined) ?? code;
    return field.options?.find((option) => option.code === code)?.labelAr ?? code;
  };
  switch (field.dataType) {
    case 'integer':
      return String(value);
    case 'decimal':
      return formatDecimal(
        value,
        field.validation?.scale ?? PROPERTY_ATTRIBUTE_LIMITS.decimalMaxScale,
      );
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
function formatDecimal(value, scale) {
  if (!Number.isFinite(value)) return String(value);
  const fixed = value.toFixed(
    Math.min(Math.max(scale, 0), PROPERTY_ATTRIBUTE_LIMITS.decimalMaxScale),
  );
  if (/e/i.test(fixed)) return String(value);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}
/** Catalog codes a specification needs live labels for (legacy layout or the pinned version). */
function catalogReferences(spec, pinnedVersion) {
  const fields =
    spec.source === 'legacy' ? LEGACY_RESIDENTIAL_FIELDS : (pinnedVersion?.fields ?? []);
  return fields
    .filter(
      (field) =>
        field.optionSource === 'catalog' &&
        field.catalogGroup &&
        spec.attributes[field.key] !== undefined,
    )
    .flatMap((field) => {
      const value = spec.attributes[field.key];
      return (Array.isArray(value) ? value : [value]).map((code) => ({
        catalogGroup: field.catalogGroup,
        code: String(code),
      }));
    });
}

Object.assign(exports, {
  isPinnedRecord,
  effectiveSpec,
  deprecatedFlatFields,
  buildSpecifications,
  displayValueAr,
  catalogReferences,
});
