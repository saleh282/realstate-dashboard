import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { updatedPaths } from '../../common/mongo/update-paths';
import {
  PROPERTY_ATTRIBUTE_CATALOG_GROUPS,
  PROPERTY_ATTRIBUTE_DATA_TYPES,
  PROPERTY_ATTRIBUTE_FACET_KEYS,
  PROPERTY_ATTRIBUTE_LIMITS,
  PROPERTY_ATTRIBUTE_NUMERIC_TYPES,
  PROPERTY_ATTRIBUTE_OPTION_CODE_PATTERN,
  PROPERTY_ATTRIBUTE_OPTION_SOURCES,
  PROPERTY_ATTRIBUTE_OPTION_STATUSES,
  PROPERTY_ATTRIBUTE_ORIGINS,
  PROPERTY_ATTRIBUTE_RESERVED_KEYS,
  PROPERTY_ATTRIBUTE_SELECT_TYPES,
  PROPERTY_ATTRIBUTE_STATUSES,
  PROPERTY_ATTRIBUTE_UNITS,
  isAllowedAttributeKey,
  type PropertyAttributeHardBounds,
} from '../property-attribute.constants';

export type PropertyAttributeDocument = HydratedDocument<PropertyAttribute>;

@Schema({ _id: false })
export class PropertyAttributeOption {
  @Prop({ required: true, match: PROPERTY_ATTRIBUTE_OPTION_CODE_PATTERN }) code: string;
  @Prop({ required: true, trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength }) labelAr: string;
  @Prop({ trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength }) labelEn?: string;
  @Prop({ required: true, enum: PROPERTY_ATTRIBUTE_OPTION_STATUSES, default: 'active' }) status: 'active' | 'deprecated';
}
const PropertyAttributeOptionSchema = SchemaFactory.createForClass(PropertyAttributeOption);

@Schema({ _id: false })
export class PropertyAttributeBounds {
  @Prop() min?: number;
  @Prop() max?: number;
  @Prop({ min: 0, max: PROPERTY_ATTRIBUTE_LIMITS.decimalMaxScale }) scale?: number;
  @Prop({ min: 1 }) maxLength?: number;
  @Prop({ match: /^\d{4}-\d{2}-\d{2}$/ }) minDate?: string;
  @Prop({ match: /^\d{4}-\d{2}-\d{2}$/ }) maxDate?: string;
  @Prop({ min: 1, max: PROPERTY_ATTRIBUTE_LIMITS.multiSelectMaxItems }) maxItems?: number;
}
const PropertyAttributeBoundsSchema = SchemaFactory.createForClass(PropertyAttributeBounds);

/**
 * Attribute Registry entry (frozen §A1). Engineering-owned: there is no write
 * API in V1 and every entry comes from seed/migration. `key`, `dataType`,
 * `unit`, `optionSource`, `catalogGroup`, `origin` and a set `facetKey` are
 * identity and never change; `status` only moves active -> deprecated;
 * `options` are append-only; `hardBounds` may only widen.
 */
@Schema({ timestamps: true, collection: 'property_attributes', strict: 'throw' })
export class PropertyAttribute {
  @Prop({ required: true, unique: true, immutable: true }) key: string;
  @Prop({ required: true, enum: PROPERTY_ATTRIBUTE_DATA_TYPES, immutable: true }) dataType: string;
  @Prop({ enum: PROPERTY_ATTRIBUTE_UNITS, immutable: true }) unit?: string;
  @Prop({ required: true, trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength }) labelAr: string;
  @Prop({ trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength }) labelEn?: string;
  @Prop({ type: PropertyAttributeBoundsSchema, default: () => ({}) }) hardBounds: PropertyAttributeHardBounds;
  @Prop({ enum: PROPERTY_ATTRIBUTE_OPTION_SOURCES, immutable: true }) optionSource?: string;
  @Prop({ enum: PROPERTY_ATTRIBUTE_CATALOG_GROUPS, immutable: true }) catalogGroup?: string;
  @Prop({ type: [PropertyAttributeOptionSchema], default: undefined }) options?: PropertyAttributeOption[];
  @Prop({ enum: PROPERTY_ATTRIBUTE_FACET_KEYS }) facetKey?: string;
  @Prop({ required: true, enum: PROPERTY_ATTRIBUTE_STATUSES, default: 'active' }) status: string;
  // No default: Mongoose treats a defaulted immutable path as changed under strict "throw"; seeds always set it.
  @Prop({ required: true, enum: PROPERTY_ATTRIBUTE_ORIGINS, immutable: true }) origin: string;
}

export const PropertyAttributeSchema = SchemaFactory.createForClass(PropertyAttribute);
PropertyAttributeSchema.index({ status: 1, key: 1 }, { name: 'property_attribute_status_key' });

/** Paths only a document save (which can check the transition rules) may change. */
export const PROPERTY_ATTRIBUTE_CONTROLLED_PATHS = ['key', 'dataType', 'unit', 'optionSource', 'catalogGroup', 'origin', 'facetKey', 'status', 'options', 'hardBounds'];
const IDENTITY_PATHS = ['key', 'dataType', 'unit', 'optionSource', 'catalogGroup', 'origin'] as const;

export class PropertyAttributeInvariantError extends Error {
  constructor(message: string) { super(`PROPERTY_ATTRIBUTE_INVARIANT: ${message}`); }
}

/** Shape rules for one registry entry; returns the first violation or null. */
export function propertyAttributeShapeError(entry: Partial<PropertyAttribute>): string | null {
  const key = String(entry.key ?? '');
  if (!isAllowedAttributeKey(key)) return `key ${JSON.stringify(key)} is not an allowed attribute key`;
  if (PROPERTY_ATTRIBUTE_RESERVED_KEYS.includes(key)) return `key ${key} is reserved`;
  const dataType = entry.dataType as string;
  const numeric = PROPERTY_ATTRIBUTE_NUMERIC_TYPES.includes(dataType as any);
  const select = PROPERTY_ATTRIBUTE_SELECT_TYPES.includes(dataType as any);
  if (entry.unit && !numeric) return 'unit is allowed on integer/decimal only';
  if (select !== Boolean(entry.optionSource)) return 'optionSource is required exactly for select types';
  if ((entry.optionSource === 'catalog') !== Boolean(entry.catalogGroup)) return 'catalogGroup is required exactly for catalog options';
  const options = entry.options ?? [];
  if (entry.optionSource === 'inline') {
    if (options.length < PROPERTY_ATTRIBUTE_LIMITS.optionsMin || options.length > PROPERTY_ATTRIBUTE_LIMITS.optionsMax) return 'inline options need 1-100 entries';
    if (new Set(options.map((option) => option.code)).size !== options.length) return 'option codes must be unique';
  } else if (options.length) return 'options are allowed on inline selects only';
  if (entry.facetKey && entry.facetKey !== key) return 'facetKey must equal the attribute key';
  const bounds = entry.hardBounds ?? {};
  if (bounds.min !== undefined || bounds.max !== undefined) {
    if (!numeric) return 'min/max bounds are for numeric types';
    if (bounds.min !== undefined && !Number.isFinite(bounds.min)) return 'min must be finite';
    if (bounds.max !== undefined && !Number.isFinite(bounds.max)) return 'max must be finite';
    if (bounds.min !== undefined && bounds.max !== undefined && bounds.min > bounds.max) return 'min must not exceed max';
  }
  if (bounds.scale !== undefined && dataType !== 'decimal') return 'scale is for decimal only';
  if (bounds.maxLength !== undefined) {
    const cap = dataType === 'text' ? PROPERTY_ATTRIBUTE_LIMITS.textMaxLength : dataType === 'textarea' ? PROPERTY_ATTRIBUTE_LIMITS.textareaMaxLength : 0;
    if (!cap || bounds.maxLength > cap) return 'maxLength exceeds the type limit';
  }
  if ((bounds.minDate !== undefined || bounds.maxDate !== undefined) && dataType !== 'date') return 'date bounds are for date only';
  if (bounds.minDate !== undefined && bounds.minDate < PROPERTY_ATTRIBUTE_LIMITS.dateMin) return 'minDate below 1800-01-01';
  if (bounds.maxDate !== undefined && bounds.maxDate > PROPERTY_ATTRIBUTE_LIMITS.dateMax) return 'maxDate above 2200-12-31';
  if (bounds.maxItems !== undefined && dataType !== 'multiSelect') return 'maxItems is for multiSelect only';
  return null;
}

/** Transition rules between a stored entry and its edited form; returns the first violation or null. */
export function propertyAttributeTransitionError(before: any, after: any): string | null {
  for (const path of IDENTITY_PATHS) if (!same(before[path], after[path])) return `${path} is immutable`;
  if (before.facetKey && before.facetKey !== after.facetKey) return 'facetKey is immutable once set';
  if (before.status === 'deprecated' && after.status !== 'deprecated') return 'a deprecated attribute cannot be reactivated';
  const nextOptions = new Map<string, any>((after.options ?? []).map((option: any) => [option.code, option]));
  for (const option of before.options ?? []) {
    const next = nextOptions.get(option.code);
    if (!next) return `option ${option.code} cannot be removed`;
    if (option.status === 'deprecated' && next.status !== 'deprecated') return `option ${option.code} cannot be reactivated`;
  }
  const was: PropertyAttributeHardBounds = before.hardBounds ?? {};
  const now: PropertyAttributeHardBounds = after.hardBounds ?? {};
  const narrows =
    (was.min !== undefined && (now.min === undefined ? false : now.min > was.min))
    || (was.min === undefined && now.min !== undefined)
    || (was.max !== undefined && (now.max === undefined ? false : now.max < was.max))
    || (was.max === undefined && now.max !== undefined)
    || (was.scale !== undefined && (now.scale ?? 0) < was.scale)
    || (was.maxLength !== undefined && now.maxLength !== undefined && now.maxLength < was.maxLength)
    || (was.maxLength === undefined && now.maxLength !== undefined)
    || (was.maxItems !== undefined && now.maxItems !== undefined && now.maxItems < was.maxItems)
    || (was.maxItems === undefined && now.maxItems !== undefined)
    || (was.minDate !== undefined && now.minDate !== undefined && now.minDate > was.minDate)
    || (was.minDate === undefined && now.minDate !== undefined)
    || (was.maxDate !== undefined && now.maxDate !== undefined && now.maxDate < was.maxDate)
    || (was.maxDate === undefined && now.maxDate !== undefined);
  if (narrows) return 'hardBounds may only widen';
  return null;
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

// Stored snapshot for the transition rules: taken on load and refreshed after every save.
PropertyAttributeSchema.post('init', function (doc) {
  doc.$locals.original = doc.toObject();
});
PropertyAttributeSchema.post('save', function (doc) {
  doc.$locals.original = doc.toObject();
});

PropertyAttributeSchema.pre('validate', function () {
  const error = propertyAttributeShapeError(this.toObject());
  if (error) throw new PropertyAttributeInvariantError(error);
});

PropertyAttributeSchema.pre('save', function () {
  const original = this.$locals.original;
  if (this.isNew || !original) return;
  const error = propertyAttributeTransitionError(original, this.toObject());
  if (error) throw new PropertyAttributeInvariantError(error);
});

// Query updates cannot see the stored entry, so they may not touch controlled
// paths at all (insert-only $setOnInsert on an upsert is fine). Registry
// entries are never deleted or replaced.
PropertyAttributeSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
  const { paths } = updatedPaths(this.getUpdate());
  const touched = paths.filter((path) => PROPERTY_ATTRIBUTE_CONTROLLED_PATHS.includes(path));
  if (touched.length) throw new PropertyAttributeInvariantError(`update cannot change ${touched.join(', ')}; load and save the entry`);
});
PropertyAttributeSchema.pre(['replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'], { query: true, document: false }, function () {
  throw new PropertyAttributeInvariantError('registry entries are never replaced or deleted');
});
PropertyAttributeSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new PropertyAttributeInvariantError('registry entries are never deleted');
});
