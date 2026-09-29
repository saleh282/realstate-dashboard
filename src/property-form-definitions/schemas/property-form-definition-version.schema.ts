import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { BSON } from 'mongodb';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { updatedPaths } from '../../common/mongo/update-paths';
import {
  PROPERTY_ATTRIBUTE_CATALOG_GROUPS,
  PROPERTY_ATTRIBUTE_DATA_TYPES,
  PROPERTY_ATTRIBUTE_KEY_PATTERN,
  PROPERTY_ATTRIBUTE_LIMITS,
  PROPERTY_ATTRIBUTE_OPTION_CODE_PATTERN,
  PROPERTY_ATTRIBUTE_OPTION_SOURCES,
  PROPERTY_ATTRIBUTE_UNITS,
} from '../../property-attributes/property-attribute.constants';
import {
  FORM_FIELD_WIDGETS,
  FORM_OPERATION_TYPES,
  FORM_VERSION_STATES,
  MEDIA_PROFILES,
  PROPERTY_FORM_LIMITS,
  type FieldDefinition,
  type FormVersionState,
} from '../property-form-definition.constants';

export type PropertyFormDefinitionVersionDocument = HydratedDocument<PropertyFormDefinitionVersion>;

@Schema({ _id: false, strict: 'throw' })
export class FieldOptionDefinition {
  @Prop({ required: true, match: PROPERTY_ATTRIBUTE_OPTION_CODE_PATTERN }) code: string;
  @Prop({ required: true, trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength }) labelAr: string;
  @Prop({ trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength }) labelEn?: string;
  @Prop({ required: true, min: 0, max: PROPERTY_FORM_LIMITS.fieldOrderMax }) order: number;
}
const FieldOptionDefinitionSchema = SchemaFactory.createForClass(FieldOptionDefinition);

@Schema({ _id: false, strict: 'throw' })
export class FieldValidationDefinition {
  /** Number for integer/decimal, `YYYY-MM-DD` for date. */
  @Prop({ type: MongooseSchema.Types.Mixed }) min?: number | string;
  @Prop({ type: MongooseSchema.Types.Mixed }) max?: number | string;
  @Prop({ min: 0, max: PROPERTY_ATTRIBUTE_LIMITS.decimalMaxScale }) scale?: number;
  @Prop({ min: 0 }) minLength?: number;
  @Prop({ min: 1 }) maxLength?: number;
  @Prop({ min: 0 }) minItems?: number;
  @Prop({ min: 1 }) maxItems?: number;
}
const FieldValidationDefinitionSchema = SchemaFactory.createForClass(FieldValidationDefinition);

/**
 * One field of a version (frozen §A4). `dataType`, `unit`, `optionSource`
 * and `catalogGroup` are copied from the registry by the server at publish.
 * Strict "throw": reserved V1 properties (visibleWhen, regex, facet, ...) and
 * anything else unknown are rejected rather than silently dropped.
 */
@Schema({ _id: false, strict: 'throw' })
export class FieldDefinitionEntry {
  @Prop({ required: true, match: PROPERTY_ATTRIBUTE_KEY_PATTERN }) key: string;
  @Prop({ required: true, enum: PROPERTY_ATTRIBUTE_DATA_TYPES }) dataType: string;
  @Prop({ enum: PROPERTY_ATTRIBUTE_UNITS }) unit?: string;
  @Prop({ enum: PROPERTY_ATTRIBUTE_OPTION_SOURCES }) optionSource?: string;
  @Prop({ enum: PROPERTY_ATTRIBUTE_CATALOG_GROUPS }) catalogGroup?: string;
  @Prop({ required: true, trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength }) labelAr: string;
  @Prop({ trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength }) labelEn?: string;
  @Prop({ trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.helpMaxLength }) helpAr?: string;
  @Prop({ trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.helpMaxLength }) helpEn?: string;
  @Prop({ trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.placeholderMaxLength }) placeholderAr?: string;
  @Prop({ required: true }) required: boolean;
  @Prop({ required: true, min: PROPERTY_FORM_LIMITS.fieldOrderMin, max: PROPERTY_FORM_LIMITS.fieldOrderMax, validate: Number.isInteger }) order: number;
  @Prop({ type: [String], enum: FORM_OPERATION_TYPES, default: undefined }) operations?: string[];
  @Prop({ type: FieldValidationDefinitionSchema }) validation?: FieldValidationDefinition;
  @Prop({ type: [FieldOptionDefinitionSchema], default: undefined }) options?: FieldOptionDefinition[];
  @Prop({ enum: FORM_FIELD_WIDGETS }) widget?: string;
}
const FieldDefinitionEntrySchema = SchemaFactory.createForClass(FieldDefinitionEntry);

/**
 * An immutable, versioned form (frozen §A3). While `state` is draft the
 * content may change; once published only `state` (published -> superseded)
 * and `supersededAt` may change, and versions are never deleted.
 */
@Schema({ timestamps: true, collection: 'property_form_definition_versions', strict: 'throw' })
export class PropertyFormDefinitionVersion {
  @Prop({ type: Types.ObjectId, ref: 'PropertyFormDefinition', required: true, immutable: true }) definitionId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'PropertyType', required: true, immutable: true }) purposeSubcategoryId: Types.ObjectId;
  @Prop({ min: 1 }) version?: number;
  @Prop({ required: true, enum: FORM_VERSION_STATES, default: 'draft' }) state: FormVersionState;
  @Prop({ type: [FieldDefinitionEntrySchema], default: [] }) fields: FieldDefinition[];
  @Prop({ required: true, enum: MEDIA_PROFILES }) mediaProfile: string;
  @Prop({ required: true }) amenitiesEnabled: boolean;
  /** Phase 11 type-aware amenities: absent (the only value every pre-Phase-11 version has) means legacy full-catalog-when-enabled behavior. */
  @Prop({ type: [String], default: undefined }) allowedAmenityCodes?: string[];
  @Prop({ trim: true, maxlength: PROPERTY_FORM_LIMITS.changeNoteMaxLength }) changeNote?: string;
  @Prop({ type: Types.ObjectId, ref: 'PropertyFormDefinitionVersion', immutable: true }) basedOnVersionId?: Types.ObjectId;
  @Prop({ required: true, min: 0, default: 0 }) draftRevision: number;
  @Prop({ min: 1 }) rendererVersion?: number;
  @Prop() legacyWritable?: boolean;
  @Prop({ match: /^[a-f0-9]{64}$/ }) contentHash?: string;
  @Prop() publishedAt?: Date;
  @Prop({ type: Types.ObjectId, ref: 'User' }) publishedBy?: Types.ObjectId;
  @Prop() supersededAt?: Date;
}

export const PropertyFormDefinitionVersionSchema = SchemaFactory.createForClass(PropertyFormDefinitionVersion);
PropertyFormDefinitionVersionSchema.index(
  { definitionId: 1, version: 1 },
  { unique: true, partialFilterExpression: { version: { $exists: true } }, name: 'property_form_version_number_unique' },
);
PropertyFormDefinitionVersionSchema.index(
  { definitionId: 1 },
  { unique: true, partialFilterExpression: { state: 'draft' }, name: 'property_form_version_one_draft' },
);
PropertyFormDefinitionVersionSchema.index(
  { definitionId: 1 },
  { unique: true, partialFilterExpression: { state: 'published' }, name: 'property_form_version_one_published' },
);
PropertyFormDefinitionVersionSchema.index({ purposeSubcategoryId: 1, state: 1 }, { name: 'property_form_version_subcategory_state' });

/** Paths that may still change once a version has left draft. */
export const FORM_VERSION_POST_PUBLISH_PATHS = ['state', 'supersededAt', 'updatedAt'];
const STATE_ORDER: Record<FormVersionState, number> = { draft: 0, published: 1, superseded: 2 };

export class PropertyFormVersionInvariantError extends Error {
  constructor(message: string) { super(`PROPERTY_FORM_VERSION_INVARIANT: ${message}`); }
}

/** Structural rules of a version document; returns the first violation or null. */
export function formVersionShapeError(version: { state?: string; fields?: FieldDefinition[]; version?: number; rendererVersion?: number; legacyWritable?: boolean; contentHash?: string; publishedAt?: Date }): string | null {
  const fields = version.fields ?? [];
  if (fields.length > PROPERTY_FORM_LIMITS.maxFields) return `at most ${PROPERTY_FORM_LIMITS.maxFields} fields`;
  if (new Set(fields.map((field) => field.key)).size !== fields.length) return 'field keys must be unique';
  if (new Set(fields.map((field) => field.order)).size !== fields.length) return 'field order values must be unique';
  for (const field of fields) {
    if (field.operations && (!field.operations.length || new Set(field.operations).size !== field.operations.length)) return `operations of ${field.key} must be a non-empty set`;
    if (field.options && new Set(field.options.map((option) => option.code)).size !== field.options.length) return `option codes of ${field.key} must be unique`;
  }
  if (version.state && version.state !== 'draft') {
    if (!version.version || version.rendererVersion === undefined || version.legacyWritable === undefined || !version.contentHash || !version.publishedAt) {
      return 'a published version needs version, rendererVersion, legacyWritable, contentHash and publishedAt';
    }
  }
  return null;
}

// The stored state, for the save rules: taken when a document is loaded and
// refreshed after every save, so a document created (or published) in this
// process cannot be edited afterwards either.
PropertyFormDefinitionVersionSchema.post('init', function (doc) {
  doc.$locals.originalState = doc.state;
});
PropertyFormDefinitionVersionSchema.post('save', function (doc) {
  doc.$locals.originalState = doc.state;
});

PropertyFormDefinitionVersionSchema.pre('validate', function () {
  const error = formVersionShapeError(this.toObject() as any);
  if (error) throw new PropertyFormVersionInvariantError(error);
  const bytes = BSON.calculateObjectSize(this.toObject({ depopulate: true }));
  if (bytes > PROPERTY_FORM_LIMITS.maxVersionBytes) throw new PropertyFormVersionInvariantError(`serialized version is ${bytes} bytes (max ${PROPERTY_FORM_LIMITS.maxVersionBytes})`);
});

PropertyFormDefinitionVersionSchema.pre('save', function () {
  const originalState = this.$locals.originalState as FormVersionState | undefined;
  if (this.isNew || !originalState) return;
  if (STATE_ORDER[this.state] < STATE_ORDER[originalState] || (originalState === 'draft' && this.state === 'superseded')) {
    throw new PropertyFormVersionInvariantError(`state cannot move from ${originalState} to ${this.state}`);
  }
  if (originalState === 'draft') return;
  const changed = this.modifiedPaths({ includeChildren: false }).map((path) => path.split('.')[0]).filter((path) => !FORM_VERSION_POST_PUBLISH_PATHS.includes(path));
  if (changed.length) throw new PropertyFormVersionInvariantError(`a ${originalState} version is immutable (${[...new Set(changed)].join(', ')})`);
});

// Query writes cannot see the stored state, so each one is narrowed to the
// only state it may legally apply to: content edits and publishing match
// drafts only, superseding matches the published version only.
PropertyFormDefinitionVersionSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
  const update = (this.getUpdate() ?? {}) as Record<string, any>;
  const { paths } = updatedPaths(update);
  const nextState = update.$set?.state ?? update.state;
  if (update.$unset && 'state' in update.$unset) throw new PropertyFormVersionInvariantError('state cannot be removed');
  if (nextState === 'draft') throw new PropertyFormVersionInvariantError('a version cannot return to draft');
  if (paths.includes('supersededAt') && nextState !== 'superseded') throw new PropertyFormVersionInvariantError('supersededAt is set only when superseding');
  const content = paths.filter((path) => !FORM_VERSION_POST_PUBLISH_PATHS.includes(path));
  if (nextState === 'superseded') {
    if (content.length) throw new PropertyFormVersionInvariantError(`superseding cannot change ${content.join(', ')}`);
    this.and([{ state: 'published' }]);
    return;
  }
  if (nextState !== undefined && nextState !== 'published') throw new PropertyFormVersionInvariantError(`unknown state ${String(nextState)}`);
  if (content.length || nextState === 'published') this.and([{ state: 'draft' }]);
});
PropertyFormDefinitionVersionSchema.pre(['replaceOne', 'findOneAndReplace'], { query: true, document: false }, function () {
  throw new PropertyFormVersionInvariantError('versions are never replaced');
});
PropertyFormDefinitionVersionSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], { query: true, document: false }, function () {
  this.and([{ state: 'draft' }]);
});
PropertyFormDefinitionVersionSchema.pre('deleteOne', { document: true, query: false }, function () {
  if (this.state !== 'draft') throw new PropertyFormVersionInvariantError('only drafts can be discarded');
});
