'use strict';

const {
  PROPERTY_ATTRIBUTE_LIMITS,
} = require('../../../domain/property-attributes/property-attribute.constants');
const { CROSS_FIELD_RULES } = require('./cross-field-rules');
const {
  codePointLength,
  isWellFormedText,
  normalizeAttributeText,
  normalizeAttributeToken,
} = require('./normalize-text');
const {
  PropertyAttributeFieldErrorCode: Code,
  fieldError,
} = require('./property-attribute-errors');
/**
 * Frozen §B3-§B6. Pure: no database, no HTTP. Every field runs applicability,
 * missing-value, type and rule checks in that order and stops at its first
 * failure; cross-field rules run last on fields that passed; all errors are
 * collected. Unknown keys are rejected, never stripped.
 */
function validateAgainstVersion(
  version,
  operationType,
  attributes,
  catalogLookup,
  crossFieldRules = CROSS_FIELD_RULES,
) {
  const fields = [...version.fields].sort((a, b) => a.order - b.order);
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const errors = [];
  const values = new Map();
  for (const field of fields) {
    const present = Object.prototype.hasOwnProperty.call(attributes, field.key);
    const outcome = validateField(
      field,
      operationType,
      present,
      present ? attributes[field.key] : undefined,
      catalogLookup,
    );
    if ('error' in outcome) errors.push(outcome.error);
    else if ('value' in outcome) values.set(field.key, outcome.value);
  }
  const failedKeys = new Set(errors.map((error) => error.key));
  for (const rule of crossFieldRules) {
    if (!rule.keys.every((key) => byKey.has(key) && values.has(key) && !failedKeys.has(key)))
      continue;
    if (!rule.holds(Object.fromEntries(rule.keys.map((key) => [key, values.get(key)])))) {
      errors.push(
        fieldError(rule.errorKey, Code.CROSS_FIELD, {
          rule: rule.name,
          relatedKeys: rule.keys.filter((key) => key !== rule.errorKey),
        }),
      );
    }
  }
  const unknown = Object.keys(attributes)
    .filter((key) => !byKey.has(key))
    .sort();
  for (const key of unknown) errors.push(fieldError(key, Code.UNKNOWN_FIELD));
  if (errors.length) return { ok: false, fieldErrors: sortFieldErrors(errors, byKey) };
  return {
    ok: true,
    attributes: Object.fromEntries(
      fields
        .filter((field) => values.has(field.key))
        .map((field) => [field.key, values.get(field.key)]),
    ),
  };
}
/** Frozen §B8: by field order, unknown keys last in alphabetical order. */
function sortFieldErrors(errors, byKey) {
  const rank = (error) => byKey.get(error.key)?.order ?? Number.POSITIVE_INFINITY;
  return [...errors].sort(
    (a, b) => rank(a) - rank(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}
/** Frozen §B3: absent, null, [] and a string empty after normalization mean "not provided". */
function isProvided(field, value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return normalizeString(field, value) !== '';
  return true;
}
function normalizeString(field, value) {
  if (!isWellFormedText(value)) return value;
  if (field.dataType === 'text') return normalizeAttributeText(value, false);
  if (field.dataType === 'textarea') return normalizeAttributeText(value, true);
  return normalizeAttributeToken(value);
}
function validateField(field, operationType, present, raw, catalogLookup) {
  const key = field.key;
  const applicable = !field.operations || field.operations.includes(operationType);
  if (!applicable)
    return present
      ? { error: fieldError(key, Code.NOT_APPLICABLE, { operationType }) }
      : { omitted: true };
  if (!isProvided(field, raw))
    return field.required ? { error: fieldError(key, Code.REQUIRED) } : { omitted: true };
  const typed = normalize(field, raw);
  if ('error' in typed) return typed;
  return checkRules(field, typed.value, catalogLookup);
}
/** Type check plus normalization of one provided value (no type conversion, ever). */
function normalize(field, raw) {
  const key = field.key;
  const mismatch = () => ({
    error: fieldError(key, Code.TYPE_MISMATCH, { expected: field.dataType }),
  });
  switch (field.dataType) {
    case 'integer':
      if (typeof raw !== 'number') return mismatch();
      if (!Number.isSafeInteger(raw)) return { error: fieldError(key, Code.NOT_INTEGER) };
      return { value: raw === 0 ? 0 : raw };
    case 'decimal':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return mismatch();
      return { value: raw === 0 ? 0 : raw };
    case 'boolean':
      return typeof raw === 'boolean' ? { value: raw } : mismatch();
    case 'text':
    case 'textarea':
    case 'singleSelect':
    case 'date':
      if (typeof raw !== 'string' || !isWellFormedText(raw)) return mismatch();
      return { value: normalizeString(field, raw) };
    case 'multiSelect':
      if (
        !Array.isArray(raw) ||
        !raw.every((item) => typeof item === 'string' && isWellFormedText(item))
      )
        return mismatch();
      return { value: raw.map((item) => normalizeAttributeToken(item)) };
    default:
      return mismatch();
  }
}
function checkRules(field, value, catalogLookup) {
  const key = field.key;
  const rules = field.validation ?? {};
  switch (field.dataType) {
    case 'integer':
    case 'decimal': {
      const number = value;
      if (typeof rules.min === 'number' && number < rules.min)
        return { error: fieldError(key, Code.MIN, { min: rules.min }) };
      if (typeof rules.max === 'number' && number > rules.max)
        return { error: fieldError(key, Code.MAX, { max: rules.max }) };
      if (field.dataType === 'decimal') {
        const scale = Math.min(
          rules.scale ?? PROPERTY_ATTRIBUTE_LIMITS.decimalMaxScale,
          PROPERTY_ATTRIBUTE_LIMITS.decimalMaxScale,
        );
        if (Number(number.toFixed(scale)) !== number)
          return { error: fieldError(key, Code.SCALE_EXCEEDED, { scale }) };
      }
      return { value: number };
    }
    case 'text':
    case 'textarea': {
      const text = value;
      const hardMax =
        field.dataType === 'text'
          ? PROPERTY_ATTRIBUTE_LIMITS.textMaxLength
          : PROPERTY_ATTRIBUTE_LIMITS.textareaMaxLength;
      const maxLength = Math.min(rules.maxLength ?? hardMax, hardMax);
      const length = codePointLength(text);
      if (rules.minLength !== undefined && length < rules.minLength)
        return { error: fieldError(key, Code.MIN_LENGTH, { minLength: rules.minLength }) };
      if (length > maxLength) return { error: fieldError(key, Code.MAX_LENGTH, { maxLength }) };
      return { value: text };
    }
    case 'boolean':
      return { value };
    case 'singleSelect':
      return isOption(field, value, catalogLookup)
        ? { value }
        : { error: fieldError(key, Code.OPTION_INVALID) };
    case 'multiSelect': {
      const items = value;
      if (new Set(items).size !== items.length)
        return { error: fieldError(key, Code.DUPLICATE_ITEMS) };
      if (!items.every((item) => isOption(field, item, catalogLookup)))
        return { error: fieldError(key, Code.OPTION_INVALID) };
      const maxItems = Math.min(
        rules.maxItems ?? PROPERTY_ATTRIBUTE_LIMITS.multiSelectMaxItems,
        PROPERTY_ATTRIBUTE_LIMITS.multiSelectMaxItems,
      );
      if (rules.minItems !== undefined && items.length < rules.minItems)
        return { error: fieldError(key, Code.MIN_ITEMS, { minItems: rules.minItems }) };
      if (items.length > maxItems) return { error: fieldError(key, Code.MAX_ITEMS, { maxItems }) };
      return { value: sortByOptionOrder(field, items) };
    }
    case 'date': {
      const date = value;
      if (!isCalendarDate(date)) return { error: fieldError(key, Code.DATE_INVALID) };
      const min =
        typeof rules.min === 'string' && rules.min > PROPERTY_ATTRIBUTE_LIMITS.dateMin
          ? rules.min
          : PROPERTY_ATTRIBUTE_LIMITS.dateMin;
      const max =
        typeof rules.max === 'string' && rules.max < PROPERTY_ATTRIBUTE_LIMITS.dateMax
          ? rules.max
          : PROPERTY_ATTRIBUTE_LIMITS.dateMax;
      if (date < min) return { error: fieldError(key, Code.MIN, { min }) };
      if (date > max) return { error: fieldError(key, Code.MAX, { max }) };
      return { value: date };
    }
    default:
      return { error: fieldError(key, Code.TYPE_MISMATCH, { expected: field.dataType }) };
  }
}
function isOption(field, code, catalogLookup) {
  if (field.optionSource === 'catalog')
    return Boolean(field.catalogGroup) && catalogLookup(field.catalogGroup, code);
  return (field.options ?? []).some((option) => option.code === code);
}
/** Frozen §B4: multiSelect values are stored in the version's option order (catalog: by code). */
function sortByOptionOrder(field, items) {
  if (field.optionSource === 'catalog') return [...items].sort();
  const order = new Map((field.options ?? []).map((option) => [option.code, option.order]));
  return [...items].sort((a, b) => order.get(a) - order.get(b) || (a < b ? -1 : a > b ? 1 : 0));
}
/** `YYYY-MM-DD`, a real Gregorian calendar date, no time or zone. */
function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [
    31,
    (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  return day <= daysInMonth;
}

Object.assign(exports, { validateAgainstVersion, isProvided, normalize, isCalendarDate });
