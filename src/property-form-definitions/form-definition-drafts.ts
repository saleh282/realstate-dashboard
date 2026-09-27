import { BSON } from 'mongodb';
import { canonicalize } from '../common/idempotency/idempotency.service';
import { codePointLength, isCalendarDate, sanitizeFormLabel } from '../common/validators/property-attributes';
import {
  PROPERTY_ATTRIBUTE_DATA_TYPES,
  PROPERTY_ATTRIBUTE_LIMITS,
  PROPERTY_ATTRIBUTE_RESERVED_KEYS,
  isAllowedAttributeKey,
  type PropertyAttributeHardBounds,
} from '../property-attributes/property-attribute.constants';
import {
  CURRENT_RENDERER_VERSION,
  FORM_OPERATION_TYPES,
  FORM_WIDGETS_BY_DATA_TYPE,
  PROPERTY_FORM_LIMITS,
  SHIPPED_MEDIA_PROFILES,
  computeFormContentHash,
  computeLegacyWritable,
  type FieldDefinition,
  type FieldOption,
  type FieldValidation,
  type FormVersionContent,
  type MediaProfile,
} from './property-form-definition.constants';

/**
 * Admin form-builder rules (DPF-031/032). Pure: no database, no HTTP. The
 * Attribute Registry owns every field's identity (key, data type, unit,
 * option source, catalog group); Admin input only carries presentation and
 * per-form rules, and the server copies identity from the registry.
 */

/** A registry entry as read from `property_attributes`. */
export type RegistryAttribute = {
  key: string;
  dataType: string;
  unit?: string;
  labelAr: string;
  labelEn?: string;
  hardBounds?: PropertyAttributeHardBounds;
  optionSource?: string;
  catalogGroup?: string;
  options?: Array<{ code: string; labelAr: string; labelEn?: string; status: string }>;
  facetKey?: string;
  status: string;
  origin?: string;
};

export type DraftOptionInput = { code: string; labelAr?: string; labelEn?: string; order: number };
export type DraftFieldInput = {
  key: string;
  labelAr: string;
  labelEn?: string;
  helpAr?: string;
  helpEn?: string;
  placeholderAr?: string;
  required: boolean;
  order: number;
  operations?: string[];
  widget?: string;
  validation?: object;
  options?: DraftOptionInput[];
};
export type DraftContentInput = { fields: DraftFieldInput[]; mediaProfile: string; amenitiesEnabled: boolean };

/** Stable `code` of one form-builder validation error. */
export enum FormDraftErrorCode {
  FIELDS_TOO_MANY = 'FIELDS_TOO_MANY',
  /** Publish only: a draft may be saved empty, but a published form needs at least one field. */
  FIELDS_EMPTY = 'FIELDS_EMPTY',
  FIELD_KEY_DUPLICATE = 'FIELD_KEY_DUPLICATE',
  FIELD_ORDER_DUPLICATE = 'FIELD_ORDER_DUPLICATE',
  FIELD_PROPERTY_UNSUPPORTED = 'FIELD_PROPERTY_UNSUPPORTED',
  FIELD_TOO_LARGE = 'FIELD_TOO_LARGE',
  ATTRIBUTE_KEY_RESERVED = 'ATTRIBUTE_KEY_RESERVED',
  ATTRIBUTE_UNKNOWN = 'ATTRIBUTE_UNKNOWN',
  ATTRIBUTE_DEPRECATED = 'ATTRIBUTE_DEPRECATED',
  ATTRIBUTE_CONTRACT_MISMATCH = 'ATTRIBUTE_CONTRACT_MISMATCH',
  DATA_TYPE_UNSUPPORTED = 'DATA_TYPE_UNSUPPORTED',
  PROPERTY_INVALID = 'PROPERTY_INVALID',
  LABEL_INVALID = 'LABEL_INVALID',
  OPERATIONS_INVALID = 'OPERATIONS_INVALID',
  WIDGET_UNSUPPORTED = 'WIDGET_UNSUPPORTED',
  OPTIONS_NOT_ALLOWED = 'OPTIONS_NOT_ALLOWED',
  OPTIONS_COUNT_INVALID = 'OPTIONS_COUNT_INVALID',
  OPTION_UNKNOWN = 'OPTION_UNKNOWN',
  OPTION_DEPRECATED = 'OPTION_DEPRECATED',
  OPTION_DUPLICATE = 'OPTION_DUPLICATE',
  OPTION_ORDER_DUPLICATE = 'OPTION_ORDER_DUPLICATE',
  OPTION_INVALID = 'OPTION_INVALID',
  VALIDATION_NOT_APPLICABLE = 'VALIDATION_NOT_APPLICABLE',
  BOUND_INVALID = 'BOUND_INVALID',
  BOUND_REQUIRED = 'BOUND_REQUIRED',
  BOUND_OUTSIDE_REGISTRY = 'BOUND_OUTSIDE_REGISTRY',
  BOUND_RANGE_INVALID = 'BOUND_RANGE_INVALID',
  MEDIA_PROFILE_UNSUPPORTED = 'MEDIA_PROFILE_UNSUPPORTED',
  RENDERER_VERSION_UNSUPPORTED = 'RENDERER_VERSION_UNSUPPORTED',
  VERSION_TOO_LARGE = 'VERSION_TOO_LARGE',
}

/** One error; `fieldKey` is absent for form-level errors, `property` names the offending path. */
export type FormDraftError = { code: FormDraftErrorCode; fieldKey?: string; property?: string; params?: Record<string, unknown> };

/** Stored FieldDefinition properties, in canonical order. */
export const FIELD_DEFINITION_PROPERTIES: readonly (keyof FieldDefinition)[] = [
  'key', 'dataType', 'unit', 'optionSource', 'catalogGroup', 'labelAr', 'labelEn', 'helpAr', 'helpEn', 'placeholderAr',
  'required', 'order', 'operations', 'validation', 'options', 'widget',
];
const VALIDATION_PROPERTIES: readonly (keyof FieldValidation)[] = ['min', 'max', 'scale', 'minLength', 'maxLength', 'minItems', 'maxItems'];
const VALIDATION_BY_DATA_TYPE: Readonly<Record<string, readonly (keyof FieldValidation)[]>> = {
  integer: ['min', 'max'],
  decimal: ['min', 'max', 'scale'],
  text: ['minLength', 'maxLength'],
  textarea: ['minLength', 'maxLength'],
  boolean: [],
  singleSelect: [],
  multiSelect: ['minItems', 'maxItems'],
  date: ['min', 'max'],
};
const TEXT_LIMITS = [
  ['labelAr', PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength],
  ['labelEn', PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength],
  ['helpAr', PROPERTY_ATTRIBUTE_LIMITS.helpMaxLength],
  ['helpEn', PROPERTY_ATTRIBUTE_LIMITS.helpMaxLength],
  ['placeholderAr', PROPERTY_ATTRIBUTE_LIMITS.placeholderMaxLength],
] as const;

const present = (value: unknown) => value !== undefined && value !== null;
const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const inOrderRange = (value: unknown) => isInteger(value) && value >= PROPERTY_FORM_LIMITS.fieldOrderMin && value <= PROPERTY_FORM_LIMITS.fieldOrderMax;
const cleanText = (value: unknown) => (typeof value === 'string' ? sanitizeFormLabel(value) : value);

// ---------------------------------------------------------------- build

/**
 * Admin input -> stored draft content. Identity comes from the registry
 * (an unknown key keeps no identity and fails validation); labels are
 * sanitized (frozen §B7); an option without a label takes the registry's.
 * The result is canonical (see `canonicalField`) but not yet validated.
 */
export function buildDraftContent(input: DraftContentInput, registry: ReadonlyMap<string, RegistryAttribute>): Omit<FormVersionContent, 'rendererVersion'> {
  return {
    fields: input.fields.map((field) => {
      const attribute = registry.get(field.key);
      const registryOptions = new Map((attribute?.options ?? []).map((option) => [option.code, option]));
      return canonicalField({
        key: field.key,
        ...(attribute ? { dataType: attribute.dataType, unit: attribute.unit, optionSource: attribute.optionSource, catalogGroup: attribute.catalogGroup } : {}),
        labelAr: cleanText(field.labelAr),
        labelEn: cleanText(field.labelEn),
        helpAr: cleanText(field.helpAr),
        helpEn: cleanText(field.helpEn),
        placeholderAr: cleanText(field.placeholderAr),
        required: field.required,
        order: field.order,
        operations: field.operations,
        widget: field.widget,
        validation: field.validation,
        options: field.options?.map((option) => ({
          code: option.code,
          labelAr: cleanText(option.labelAr ?? registryOptions.get(option.code)?.labelAr),
          labelEn: cleanText(option.labelEn ?? registryOptions.get(option.code)?.labelEn),
          order: option.order,
        })),
      } as unknown as FieldDefinition);
    }).sort(byOrder),
    mediaProfile: input.mediaProfile as MediaProfile,
    amenitiesEnabled: input.amenitiesEnabled,
  };
}

/**
 * One field in canonical form: properties in stored order, empty optional
 * values dropped, options by order, and a valid `operations` set in contract
 * order (omitted when it lists every operation, which is what absence means).
 * Canonical content hashes and diffs identically however it was written.
 */
export function canonicalField(field: FieldDefinition): FieldDefinition {
  const raw = field as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const property of Object.keys(raw)) {
    if (!(FIELD_DEFINITION_PROPERTIES as readonly string[]).includes(property) && present(raw[property])) result[property] = raw[property];
  }
  for (const property of FIELD_DEFINITION_PROPERTIES) {
    const value = raw[property];
    if (!present(value) || value === '') continue;
    if (property === 'validation' && typeof value === 'object' && !Array.isArray(value)) {
      const validation = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => present(item)));
      if (Object.keys(validation).length) result.validation = validation;
    } else if (property === 'options' && Array.isArray(value)) {
      result.options = [...value]
        .map((option: any) => (option && typeof option === 'object' ? Object.fromEntries(['code', 'labelAr', 'labelEn', 'order'].filter((key) => present(option[key]) && option[key] !== '').map((key) => [key, option[key]])) : option))
        .sort((a: any, b: any) => (a?.order ?? 0) - (b?.order ?? 0) || String(a?.code).localeCompare(String(b?.code)));
    } else if (property === 'operations' && isOperationSet(value)) {
      const operations = FORM_OPERATION_TYPES.filter((operation) => (value as string[]).includes(operation));
      if (operations.length < FORM_OPERATION_TYPES.length) result.operations = operations;
    } else {
      result[property] = value;
    }
  }
  return result as FieldDefinition;
}

const isOperationSet = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && new Set(value).size === value.length && value.every((item) => (FORM_OPERATION_TYPES as readonly unknown[]).includes(item));

const byOrder = (a: FieldDefinition, b: FieldDefinition) => (a.order - b.order) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** The content a draft would publish as, canonical and with the current renderer version. */
export function publishableContent(draft: { fields: readonly FieldDefinition[]; mediaProfile: string; amenitiesEnabled: boolean }): FormVersionContent {
  return {
    rendererVersion: CURRENT_RENDERER_VERSION,
    fields: draft.fields.map((field) => canonicalField({ ...field })).sort(byOrder),
    mediaProfile: draft.mediaProfile as MediaProfile,
    amenitiesEnabled: draft.amenitiesEnabled,
  };
}

/** A stored published version's content, canonical (it keeps its own renderer version). */
export function storedContent(version: { rendererVersion?: number; fields: readonly FieldDefinition[]; mediaProfile: string; amenitiesEnabled: boolean }): FormVersionContent {
  return { ...publishableContent(version), rendererVersion: version.rendererVersion ?? CURRENT_RENDERER_VERSION };
}

export const canonicalContentHash = (content: FormVersionContent) => computeFormContentHash(content);

// ---------------------------------------------------------------- validate

export type ValidationContext = {
  /**
   * `draft` for a draft save, which may hold a still-empty form; `publish`
   * (the default) for the pre-publish check and publication itself.
   */
  stage?: 'draft' | 'publish';
  /**
   * Fields of the published version the draft is based on. A deprecated
   * registry attribute or option may stay in a form that already used it,
   * but may not be newly added (deprecation means "no new use").
   */
  baseFields?: readonly FieldDefinition[];
};

/**
 * Every rule a version must satisfy to be published (and, except for being
 * empty, every draft save must satisfy), against the current registry. Never mutates its input;
 * returns errors in a deterministic order (form-level first, then by field
 * key, property and code).
 */
export function validateFormContent(content: FormVersionContent, registry: ReadonlyMap<string, RegistryAttribute>, context: ValidationContext = {}): FormDraftError[] {
  const errors: FormDraftError[] = [];
  const add = (code: FormDraftErrorCode, fieldKey?: string, property?: string, params?: Record<string, unknown>) =>
    errors.push({ code, ...(fieldKey !== undefined ? { fieldKey } : {}), ...(property ? { property } : {}), ...(params ? { params } : {}) });

  if (content.rendererVersion !== CURRENT_RENDERER_VERSION) add(FormDraftErrorCode.RENDERER_VERSION_UNSUPPORTED, undefined, 'rendererVersion', { supported: [CURRENT_RENDERER_VERSION] });
  // The media profile sets photo requirements only; it never requires or injects specification fields
  // (a repeated slot whose count attribute the form does not collect simply yields no slots).
  if (!SHIPPED_MEDIA_PROFILES.includes(content.mediaProfile)) add(FormDraftErrorCode.MEDIA_PROFILE_UNSUPPORTED, undefined, 'mediaProfile', { supported: [...SHIPPED_MEDIA_PROFILES] });
  if (typeof content.amenitiesEnabled !== 'boolean') add(FormDraftErrorCode.PROPERTY_INVALID, undefined, 'amenitiesEnabled');
  if ((context.stage ?? 'publish') === 'publish' && content.fields.length === 0) add(FormDraftErrorCode.FIELDS_EMPTY, undefined, 'fields', { min: 1 });
  if (content.fields.length > PROPERTY_FORM_LIMITS.maxFields) add(FormDraftErrorCode.FIELDS_TOO_MANY, undefined, 'fields', { max: PROPERTY_FORM_LIMITS.maxFields });

  const keyCounts = countBy(content.fields.map((field) => field?.key));
  const orderCounts = countBy(content.fields.map((field) => field?.order));
  const baseByKey = new Map((context.baseFields ?? []).map((field) => [field.key, field]));
  for (const field of content.fields) {
    if (!field || typeof field !== 'object') { add(FormDraftErrorCode.PROPERTY_INVALID, undefined, 'fields'); continue; }
    const key = String(field.key);
    if ((keyCounts.get(field.key) ?? 0) > 1) add(FormDraftErrorCode.FIELD_KEY_DUPLICATE, key, 'key');
    if (isInteger(field.order) && (orderCounts.get(field.order) ?? 0) > 1) add(FormDraftErrorCode.FIELD_ORDER_DUPLICATE, key, 'order', { order: field.order });
    validateField(field, registry.get(key), baseByKey.get(key), add);
  }

  const bytes = BSON.calculateObjectSize(versionEnvelope(content));
  if (bytes > PROPERTY_FORM_LIMITS.maxVersionBytes) add(FormDraftErrorCode.VERSION_TOO_LARGE, undefined, undefined, { bytes, max: PROPERTY_FORM_LIMITS.maxVersionBytes });
  return sortErrors(errors);
}

type Add = (code: FormDraftErrorCode, fieldKey?: string, property?: string, params?: Record<string, unknown>) => void;

function validateField(field: FieldDefinition, attribute: RegistryAttribute | undefined, base: FieldDefinition | undefined, add: Add): void {
  const key = String(field.key);
  const raw = field as unknown as Record<string, unknown>;
  for (const property of Object.keys(raw)) {
    if (!(FIELD_DEFINITION_PROPERTIES as readonly string[]).includes(property) && present(raw[property])) add(FormDraftErrorCode.FIELD_PROPERTY_UNSUPPORTED, key, property);
  }
  const sizeOfField = BSON.calculateObjectSize(raw);
  if (sizeOfField > PROPERTY_FORM_LIMITS.maxFieldBytes) add(FormDraftErrorCode.FIELD_TOO_LARGE, key, undefined, { bytes: sizeOfField, max: PROPERTY_FORM_LIMITS.maxFieldBytes });

  if (typeof field.key !== 'string' || !isAllowedAttributeKey(field.key) || PROPERTY_ATTRIBUTE_RESERVED_KEYS.includes(field.key)) {
    add(FormDraftErrorCode.ATTRIBUTE_KEY_RESERVED, key, 'key');
    return;
  }
  if (!(PROPERTY_ATTRIBUTE_DATA_TYPES as readonly unknown[]).includes(field.dataType) && attribute) add(FormDraftErrorCode.DATA_TYPE_UNSUPPORTED, key, 'dataType');
  if (!attribute) {
    add(FormDraftErrorCode.ATTRIBUTE_UNKNOWN, key, 'key');
    return;
  }
  if (attribute.status !== 'active' && !base) add(FormDraftErrorCode.ATTRIBUTE_DEPRECATED, key, 'key');
  for (const property of ['dataType', 'unit', 'optionSource', 'catalogGroup'] as const) {
    if ((raw[property] ?? null) !== ((attribute as Record<string, unknown>)[property] ?? null)) add(FormDraftErrorCode.ATTRIBUTE_CONTRACT_MISMATCH, key, property);
  }
  const dataType = attribute.dataType;

  for (const [property, max] of TEXT_LIMITS) {
    const value = raw[property];
    if (property === 'labelAr' ? !validLabel(value, max) : present(value) && !validLabel(value, max)) add(FormDraftErrorCode.LABEL_INVALID, key, property, { maxLength: max });
  }
  if (typeof field.required !== 'boolean') add(FormDraftErrorCode.PROPERTY_INVALID, key, 'required');
  if (!inOrderRange(field.order)) add(FormDraftErrorCode.PROPERTY_INVALID, key, 'order', { min: PROPERTY_FORM_LIMITS.fieldOrderMin, max: PROPERTY_FORM_LIMITS.fieldOrderMax });
  if (present(field.operations) && !isOperationSet(field.operations)) add(FormDraftErrorCode.OPERATIONS_INVALID, key, 'operations', { allowed: [...FORM_OPERATION_TYPES] });
  if (present(field.widget) && !(FORM_WIDGETS_BY_DATA_TYPE[dataType as keyof typeof FORM_WIDGETS_BY_DATA_TYPE] ?? []).includes(field.widget as never)) {
    add(FormDraftErrorCode.WIDGET_UNSUPPORTED, key, 'widget', { allowed: [...(FORM_WIDGETS_BY_DATA_TYPE[dataType as keyof typeof FORM_WIDGETS_BY_DATA_TYPE] ?? [])] });
  }
  const optionCount = validateOptions(field, attribute, base, add);
  validateBounds(field, attribute, optionCount, add);
}

const validLabel = (value: unknown, max: number) =>
  typeof value === 'string' && value === sanitizeFormLabel(value) && value.length > 0 && codePointLength(value) <= max;

/** Returns how many options the field offers (for item bounds), or undefined when unbounded (catalog). */
function validateOptions(field: FieldDefinition, attribute: RegistryAttribute, base: FieldDefinition | undefined, add: Add): number | undefined {
  const key = field.key;
  const options = field.options as unknown;
  if (attribute.optionSource !== 'inline') {
    if (present(options)) add(FormDraftErrorCode.OPTIONS_NOT_ALLOWED, key, 'options');
    return undefined;
  }
  if (!Array.isArray(options) || options.length < PROPERTY_ATTRIBUTE_LIMITS.optionsMin || options.length > PROPERTY_ATTRIBUTE_LIMITS.optionsMax) {
    add(FormDraftErrorCode.OPTIONS_COUNT_INVALID, key, 'options', { min: PROPERTY_ATTRIBUTE_LIMITS.optionsMin, max: PROPERTY_ATTRIBUTE_LIMITS.optionsMax });
    if (!Array.isArray(options)) return 0;
  }
  const registryOptions = new Map((attribute.options ?? []).map((option) => [option.code, option]));
  const baseCodes = new Set((base?.options ?? []).map((option) => option.code));
  const codeCounts = countBy(options.map((option: any) => option?.code));
  const orderCounts = countBy(options.map((option: any) => option?.order));
  for (const option of options as FieldOption[]) {
    if (!option || typeof option !== 'object') { add(FormDraftErrorCode.OPTION_INVALID, key, 'options'); continue; }
    const property = `options.${String(option.code)}`;
    const extra = Object.keys(option).filter((name) => !['code', 'labelAr', 'labelEn', 'order'].includes(name));
    const registryOption = registryOptions.get(option.code);
    if (!registryOption) add(FormDraftErrorCode.OPTION_UNKNOWN, key, property);
    else if (registryOption.status !== 'active' && !baseCodes.has(option.code)) add(FormDraftErrorCode.OPTION_DEPRECATED, key, property);
    if ((codeCounts.get(option.code) ?? 0) > 1) add(FormDraftErrorCode.OPTION_DUPLICATE, key, property);
    if (isInteger(option.order) && (orderCounts.get(option.order) ?? 0) > 1) add(FormDraftErrorCode.OPTION_ORDER_DUPLICATE, key, property, { order: option.order });
    const labelMax = PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength;
    if (extra.length || !inOrderRange(option.order) || !validLabel(option.labelAr, labelMax) || (present(option.labelEn) && !validLabel(option.labelEn, labelMax))) {
      add(FormDraftErrorCode.OPTION_INVALID, key, property);
    }
  }
  return options.length;
}

/**
 * Per-form bounds must lie within the registry's hard bounds, and a hard
 * bound tighter than what the write-time validator enforces by default must
 * be stated explicitly (an absent bound means "the contract maximum").
 */
function validateBounds(field: FieldDefinition, attribute: RegistryAttribute, optionCount: number | undefined, add: Add): void {
  const key = field.key;
  const dataType = attribute.dataType;
  const hard = attribute.hardBounds ?? {};
  const validation = field.validation as unknown;
  if (present(validation) && (typeof validation !== 'object' || Array.isArray(validation))) {
    add(FormDraftErrorCode.PROPERTY_INVALID, key, 'validation');
    return;
  }
  const rules = (validation ?? {}) as Record<string, unknown>;
  const allowed = VALIDATION_BY_DATA_TYPE[dataType] ?? [];
  for (const [property, value] of Object.entries(rules)) {
    if (!present(value)) continue;
    if (!(VALIDATION_PROPERTIES as readonly string[]).includes(property) || !(allowed as readonly string[]).includes(property)) add(FormDraftErrorCode.VALIDATION_NOT_APPLICABLE, key, `validation.${property}`);
  }
  const has = (property: keyof FieldValidation) => (allowed as readonly string[]).includes(property) && present(rules[property]);
  const invalid = (property: string, params?: Record<string, unknown>) => add(FormDraftErrorCode.BOUND_INVALID, key, `validation.${property}`, params);
  const outside = (property: string, limit: Record<string, unknown>) => add(FormDraftErrorCode.BOUND_OUTSIDE_REGISTRY, key, `validation.${property}`, limit);
  const required = (property: string, limit: Record<string, unknown>) => add(FormDraftErrorCode.BOUND_REQUIRED, key, `validation.${property}`, limit);
  const range = (low: string, high: string) => add(FormDraftErrorCode.BOUND_RANGE_INVALID, key, `validation.${low}`, { against: `validation.${high}` });

  if (dataType === 'integer' || dataType === 'decimal') {
    const number = (value: unknown) => (dataType === 'integer' ? isInteger(value) : typeof value === 'number' && Number.isFinite(value));
    const min = rules.min;
    const max = rules.max;
    if (has('min') && !number(min)) invalid('min', { expected: dataType });
    if (has('max') && !number(max)) invalid('max', { expected: dataType });
    if (hard.min !== undefined) {
      if (!has('min')) required('min', { min: hard.min });
      else if (number(min) && (min as number) < hard.min) outside('min', { min: hard.min });
      if (number(max) && (max as number) < hard.min) outside('max', { min: hard.min });
    }
    if (hard.max !== undefined) {
      if (!has('max')) required('max', { max: hard.max });
      else if (number(max) && (max as number) > hard.max) outside('max', { max: hard.max });
      if (number(min) && (min as number) > hard.max) outside('min', { max: hard.max });
    }
    if (number(min) && number(max) && (min as number) > (max as number)) range('min', 'max');
    if (dataType === 'decimal') {
      const scaleCap = hard.scale ?? PROPERTY_ATTRIBUTE_LIMITS.decimalMaxScale;
      if (has('scale') && !(isInteger(rules.scale) && (rules.scale as number) >= 0)) invalid('scale');
      else if (has('scale') && (rules.scale as number) > scaleCap) outside('scale', { max: scaleCap });
      else if (!has('scale') && scaleCap < PROPERTY_ATTRIBUTE_LIMITS.decimalMaxScale) required('scale', { max: scaleCap });
    }
  } else if (dataType === 'text' || dataType === 'textarea') {
    const cap = Math.min(hard.maxLength ?? Infinity, dataType === 'text' ? PROPERTY_ATTRIBUTE_LIMITS.textMaxLength : PROPERTY_ATTRIBUTE_LIMITS.textareaMaxLength);
    const typeCap = dataType === 'text' ? PROPERTY_ATTRIBUTE_LIMITS.textMaxLength : PROPERTY_ATTRIBUTE_LIMITS.textareaMaxLength;
    if (has('minLength') && !(isInteger(rules.minLength) && (rules.minLength as number) >= 0)) invalid('minLength');
    if (has('maxLength') && !(isInteger(rules.maxLength) && (rules.maxLength as number) >= 1)) invalid('maxLength');
    else if (has('maxLength') && (rules.maxLength as number) > cap) outside('maxLength', { max: cap });
    else if (!has('maxLength') && cap < typeCap) required('maxLength', { max: cap });
    const effectiveMax = isInteger(rules.maxLength) ? Math.min(rules.maxLength as number, cap) : cap;
    if (isInteger(rules.minLength) && (rules.minLength as number) > effectiveMax) range('minLength', 'maxLength');
  } else if (dataType === 'multiSelect') {
    const cap = Math.min(hard.maxItems ?? Infinity, PROPERTY_ATTRIBUTE_LIMITS.multiSelectMaxItems);
    if (has('minItems') && !(isInteger(rules.minItems) && (rules.minItems as number) >= 0)) invalid('minItems');
    if (has('maxItems') && !(isInteger(rules.maxItems) && (rules.maxItems as number) >= 1)) invalid('maxItems');
    else if (has('maxItems') && (rules.maxItems as number) > cap) outside('maxItems', { max: cap });
    else if (!has('maxItems') && cap < PROPERTY_ATTRIBUTE_LIMITS.multiSelectMaxItems) required('maxItems', { max: cap });
    const effectiveMax = Math.min(isInteger(rules.maxItems) ? (rules.maxItems as number) : cap, optionCount ?? Infinity);
    if (isInteger(rules.minItems) && (rules.minItems as number) > effectiveMax) range('minItems', 'maxItems');
  } else if (dataType === 'date') {
    const low = hard.minDate ?? PROPERTY_ATTRIBUTE_LIMITS.dateMin;
    const high = hard.maxDate ?? PROPERTY_ATTRIBUTE_LIMITS.dateMax;
    const date = (value: unknown) => typeof value === 'string' && isCalendarDate(value);
    if (has('min') && !date(rules.min)) invalid('min', { expected: 'date' });
    if (has('max') && !date(rules.max)) invalid('max', { expected: 'date' });
    if (date(rules.min) && ((rules.min as string) < low || (rules.min as string) > high)) outside('min', { min: low, max: high });
    if (date(rules.max) && ((rules.max as string) < low || (rules.max as string) > high)) outside('max', { min: low, max: high });
    if (!has('min') && low > PROPERTY_ATTRIBUTE_LIMITS.dateMin) required('min', { min: low });
    if (!has('max') && high < PROPERTY_ATTRIBUTE_LIMITS.dateMax) required('max', { max: high });
    if (date(rules.min) && date(rules.max) && (rules.min as string) > (rules.max as string)) range('min', 'max');
  }
}

/** The published document a content would become, for the version size cap. */
function versionEnvelope(content: FormVersionContent) {
  return {
    _id: new BSON.ObjectId(), definitionId: new BSON.ObjectId(), purposeSubcategoryId: new BSON.ObjectId(), version: PROPERTY_FORM_LIMITS.fieldOrderMax,
    state: 'superseded', ...content, changeNote: 'x'.repeat(PROPERTY_FORM_LIMITS.changeNoteMaxLength * 4), basedOnVersionId: new BSON.ObjectId(),
    draftRevision: Number.MAX_SAFE_INTEGER, legacyWritable: false, contentHash: '0'.repeat(64), publishedAt: new Date(), publishedBy: new BSON.ObjectId(),
    supersededAt: new Date(), createdAt: new Date(), updatedAt: new Date(), __v: 0,
  };
}

function countBy<T>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function sortErrors(errors: FormDraftError[]): FormDraftError[] {
  const text = (error: FormDraftError) => canonicalize(error);
  const unique = [...new Map(errors.map((error) => [text(error), error])).values()];
  const cmp = (a?: string, b?: string) => (a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1);
  return unique.sort((a, b) => cmp(a.fieldKey, b.fieldKey) || cmp(a.property, b.property) || cmp(a.code, b.code) || cmp(text(a), text(b)));
}

// ---------------------------------------------------------------- diff

export type FormChange = { property: string; before: unknown; after: unknown };
export type FormDiff = {
  hasChanges: boolean;
  form: FormChange[];
  fieldsAdded: FieldDefinition[];
  fieldsRemoved: FieldDefinition[];
  fieldsChanged: Array<{ key: string; changes: FormChange[] }>;
};

const FORM_PROPERTIES = ['rendererVersion', 'mediaProfile', 'amenitiesEnabled', 'legacyWritable'] as const;
const COMPARED_FIELD_PROPERTIES = FIELD_DEFINITION_PROPERTIES.filter((property) => property !== 'key' && property !== 'validation' && property !== 'options');

/**
 * Deterministic structural diff between the current published content (null
 * for a type that never published) and a draft. Both sides are compared in
 * canonical form, so key order, option order in input and an explicit
 * all-operations list never show as changes. Output order is fixed: form
 * properties in contract order; fields by key; changes by property.
 */
export function diffFormContent(before: FormVersionContent | null, after: FormVersionContent): FormDiff {
  const previous = before ? storedContent(before) : null;
  const next = storedContent(after);
  const form: FormChange[] = [];
  const formValue = (content: FormVersionContent | null, property: (typeof FORM_PROPERTIES)[number]) =>
    content === null ? null : property === 'legacyWritable' ? computeLegacyWritable(content) : content[property];
  for (const property of FORM_PROPERTIES) {
    const [a, b] = [formValue(previous, property), formValue(next, property)];
    if (!equal(a, b)) form.push({ property, before: a, after: b });
  }
  const beforeByKey = new Map((previous?.fields ?? []).map((field) => [field.key, field]));
  const afterByKey = new Map(next.fields.map((field) => [field.key, field]));
  const keys = (map: Map<string, FieldDefinition>) => [...map.keys()].sort();
  const fieldsAdded = keys(afterByKey).filter((key) => !beforeByKey.has(key)).map((key) => afterByKey.get(key)!);
  const fieldsRemoved = keys(beforeByKey).filter((key) => !afterByKey.has(key)).map((key) => beforeByKey.get(key)!);
  const fieldsChanged = keys(afterByKey)
    .filter((key) => beforeByKey.has(key))
    .map((key) => ({ key, changes: fieldChanges(beforeByKey.get(key)!, afterByKey.get(key)!) }))
    .filter((entry) => entry.changes.length > 0);
  return { hasChanges: form.length + fieldsAdded.length + fieldsRemoved.length + fieldsChanged.length > 0, form, fieldsAdded, fieldsRemoved, fieldsChanged };
}

function fieldChanges(before: FieldDefinition, after: FieldDefinition): FormChange[] {
  const changes: FormChange[] = [];
  const value = (field: FieldDefinition, property: string) => (field as Record<string, any>)[property] ?? null;
  for (const property of COMPARED_FIELD_PROPERTIES) {
    if (!equal(value(before, property), value(after, property))) changes.push({ property, before: value(before, property), after: value(after, property) });
  }
  for (const property of VALIDATION_PROPERTIES) {
    const [a, b] = [before.validation?.[property] ?? null, after.validation?.[property] ?? null];
    if (!equal(a, b)) changes.push({ property: `validation.${property}`, before: a, after: b });
  }
  const optionsBefore = new Map((before.options ?? []).map((option) => [option.code, option]));
  const optionsAfter = new Map((after.options ?? []).map((option) => [option.code, option]));
  for (const code of [...new Set([...optionsBefore.keys(), ...optionsAfter.keys()])].sort()) {
    const [a, b] = [optionsBefore.get(code) ?? null, optionsAfter.get(code) ?? null];
    if (!equal(a, b)) changes.push({ property: `options.${code}`, before: a, after: b });
  }
  return changes.sort((a, b) => (a.property < b.property ? -1 : a.property > b.property ? 1 : 0));
}

const equal = (a: unknown, b: unknown) => canonicalize(a ?? null) === canonicalize(b ?? null);
