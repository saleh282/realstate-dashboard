'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { BSON } = require('mongodb');
const { Schema: MongooseSchema, Types } = require('mongoose');
const { updatedPaths } = require('../common/mongo/update-paths');
const {
  PROPERTY_ATTRIBUTE_CATALOG_GROUPS,
  PROPERTY_ATTRIBUTE_DATA_TYPES,
  PROPERTY_ATTRIBUTE_KEY_PATTERN,
  PROPERTY_ATTRIBUTE_LIMITS,
  PROPERTY_ATTRIBUTE_OPTION_CODE_PATTERN,
  PROPERTY_ATTRIBUTE_OPTION_SOURCES,
  PROPERTY_ATTRIBUTE_UNITS,
} = require('../domain/property-attributes/property-attribute.constants');
const {
  FORM_FIELD_WIDGETS,
  FORM_OPERATION_TYPES,
  FORM_VERSION_STATES,
  MEDIA_PROFILES,
  PROPERTY_FORM_LIMITS,
} = require('../domain/property-form-definitions/property-form-definition.constants');
class FieldOptionDefinition {}
const FieldOptionDefinitionSchema = new mongooseSchema(
  {
    code: { type: String, ...{ required: true, match: PROPERTY_ATTRIBUTE_OPTION_CODE_PATTERN } },
    labelAr: {
      type: String,
      ...{ required: true, trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength },
    },
    labelEn: {
      type: String,
      ...{ trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength },
    },
    order: { type: Number, ...{ required: true, min: 0, max: PROPERTY_FORM_LIMITS.fieldOrderMax } },
  },
  { _id: false, strict: 'throw' },
);
class FieldValidationDefinition {}
const FieldValidationDefinitionSchema = new mongooseSchema(
  {
    min: { type: MongooseSchema.Types.Mixed },
    max: { type: MongooseSchema.Types.Mixed },
    scale: { type: Number, ...{ min: 0, max: PROPERTY_ATTRIBUTE_LIMITS.decimalMaxScale } },
    minLength: { type: Number, ...{ min: 0 } },
    maxLength: { type: Number, ...{ min: 1 } },
    minItems: { type: Number, ...{ min: 0 } },
    maxItems: { type: Number, ...{ min: 1 } },
  },
  { _id: false, strict: 'throw' },
);
/**
 * One field of a version (frozen §A4). `dataType`, `unit`, `optionSource`
 * and `catalogGroup` are copied from the registry by the server at publish.
 * Strict "throw": reserved V1 properties (visibleWhen, regex, facet, ...) and
 * anything else unknown are rejected rather than silently dropped.
 */
class FieldDefinitionEntry {}
const FieldDefinitionEntrySchema = new mongooseSchema(
  {
    key: { type: String, ...{ required: true, match: PROPERTY_ATTRIBUTE_KEY_PATTERN } },
    dataType: { type: String, ...{ required: true, enum: PROPERTY_ATTRIBUTE_DATA_TYPES } },
    unit: { type: String, ...{ enum: PROPERTY_ATTRIBUTE_UNITS } },
    optionSource: { type: String, ...{ enum: PROPERTY_ATTRIBUTE_OPTION_SOURCES } },
    catalogGroup: { type: String, ...{ enum: PROPERTY_ATTRIBUTE_CATALOG_GROUPS } },
    labelAr: {
      type: String,
      ...{ required: true, trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength },
    },
    labelEn: {
      type: String,
      ...{ trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.labelMaxLength },
    },
    helpAr: { type: String, ...{ trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.helpMaxLength } },
    helpEn: { type: String, ...{ trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.helpMaxLength } },
    placeholderAr: {
      type: String,
      ...{ trim: true, maxlength: PROPERTY_ATTRIBUTE_LIMITS.placeholderMaxLength },
    },
    required: { type: Boolean, ...{ required: true } },
    order: {
      type: Number,
      ...{
        required: true,
        min: PROPERTY_FORM_LIMITS.fieldOrderMin,
        max: PROPERTY_FORM_LIMITS.fieldOrderMax,
        validate: Number.isInteger,
      },
    },
    operations: { type: [String], enum: FORM_OPERATION_TYPES, default: undefined },
    validation: { type: FieldValidationDefinitionSchema },
    options: { type: [FieldOptionDefinitionSchema], default: undefined },
    widget: { type: String, ...{ enum: FORM_FIELD_WIDGETS } },
  },
  { _id: false, strict: 'throw' },
);
/**
 * An immutable, versioned form (frozen §A3). While `state` is draft the
 * content may change; once published only `state` (published -> superseded)
 * and `supersededAt` may change, and versions are never deleted.
 */
class PropertyFormDefinitionVersion {}
const PropertyFormDefinitionVersionSchema = new mongooseSchema(
  {
    definitionId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'PropertyFormDefinition',
      required: true,
      immutable: true,
    },
    purposeSubcategoryId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'PropertyType',
      required: true,
      immutable: true,
    },
    version: { type: Number, ...{ min: 1 } },
    state: { type: String, ...{ required: true, enum: FORM_VERSION_STATES, default: 'draft' } },
    fields: { type: [FieldDefinitionEntrySchema], default: [] },
    mediaProfile: { type: String, ...{ required: true, enum: MEDIA_PROFILES } },
    amenitiesEnabled: { type: Boolean, ...{ required: true } },
    allowedAmenityCodes: { type: [String], default: undefined },
    changeNote: {
      type: String,
      ...{ trim: true, maxlength: PROPERTY_FORM_LIMITS.changeNoteMaxLength },
    },
    basedOnVersionId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'PropertyFormDefinitionVersion',
      immutable: true,
    },
    draftRevision: { type: Number, ...{ required: true, min: 0, default: 0 } },
    rendererVersion: { type: Number, ...{ min: 1 } },
    legacyWritable: { type: Boolean, ...{} },
    contentHash: { type: String, ...{ match: /^[a-f0-9]{64}$/ } },
    publishedAt: { type: Date, ...{} },
    publishedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    supersededAt: { type: Date, ...{} },
  },
  { timestamps: true, collection: 'property_form_definition_versions', strict: 'throw' },
);
PropertyFormDefinitionVersionSchema.index(
  { definitionId: 1, version: 1 },
  {
    unique: true,
    partialFilterExpression: { version: { $exists: true } },
    name: 'property_form_version_number_unique',
  },
);
PropertyFormDefinitionVersionSchema.index(
  { definitionId: 1 },
  {
    unique: true,
    partialFilterExpression: { state: 'draft' },
    name: 'property_form_version_one_draft',
  },
);
PropertyFormDefinitionVersionSchema.index(
  { definitionId: 1 },
  {
    unique: true,
    partialFilterExpression: { state: 'published' },
    name: 'property_form_version_one_published',
  },
);
PropertyFormDefinitionVersionSchema.index(
  { purposeSubcategoryId: 1, state: 1 },
  { name: 'property_form_version_subcategory_state' },
);
/** Paths that may still change once a version has left draft. */
const FORM_VERSION_POST_PUBLISH_PATHS = ['state', 'supersededAt', 'updatedAt'];
const STATE_ORDER = { draft: 0, published: 1, superseded: 2 };
class PropertyFormVersionInvariantError extends Error {
  constructor(message) {
    super(`PROPERTY_FORM_VERSION_INVARIANT: ${message}`);
  }
}
/** Structural rules of a version document; returns the first violation or null. */
function formVersionShapeError(version) {
  const fields = version.fields ?? [];
  if (fields.length > PROPERTY_FORM_LIMITS.maxFields)
    return `at most ${PROPERTY_FORM_LIMITS.maxFields} fields`;
  if (new Set(fields.map((field) => field.key)).size !== fields.length)
    return 'field keys must be unique';
  if (new Set(fields.map((field) => field.order)).size !== fields.length)
    return 'field order values must be unique';
  for (const field of fields) {
    if (
      field.operations &&
      (!field.operations.length || new Set(field.operations).size !== field.operations.length)
    )
      return `operations of ${field.key} must be a non-empty set`;
    if (
      field.options &&
      new Set(field.options.map((option) => option.code)).size !== field.options.length
    )
      return `option codes of ${field.key} must be unique`;
  }
  if (version.state && version.state !== 'draft') {
    if (
      !version.version ||
      version.rendererVersion === undefined ||
      version.legacyWritable === undefined ||
      !version.contentHash ||
      !version.publishedAt
    ) {
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
  const error = formVersionShapeError(this.toObject());
  if (error) throw new PropertyFormVersionInvariantError(error);
  const bytes = BSON.calculateObjectSize(this.toObject({ depopulate: true }));
  if (bytes > PROPERTY_FORM_LIMITS.maxVersionBytes)
    throw new PropertyFormVersionInvariantError(
      `serialized version is ${bytes} bytes (max ${PROPERTY_FORM_LIMITS.maxVersionBytes})`,
    );
});
PropertyFormDefinitionVersionSchema.pre('save', function () {
  const originalState = this.$locals.originalState;
  if (this.isNew || !originalState) return;
  if (
    STATE_ORDER[this.state] < STATE_ORDER[originalState] ||
    (originalState === 'draft' && this.state === 'superseded')
  ) {
    throw new PropertyFormVersionInvariantError(
      `state cannot move from ${originalState} to ${this.state}`,
    );
  }
  if (originalState === 'draft') return;
  const changed = this.modifiedPaths({ includeChildren: false })
    .map((path) => path.split('.')[0])
    .filter((path) => !FORM_VERSION_POST_PUBLISH_PATHS.includes(path));
  if (changed.length)
    throw new PropertyFormVersionInvariantError(
      `a ${originalState} version is immutable (${[...new Set(changed)].join(', ')})`,
    );
});
// Query writes cannot see the stored state, so each one is narrowed to the
// only state it may legally apply to: content edits and publishing match
// drafts only, superseding matches the published version only.
PropertyFormDefinitionVersionSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate'],
  function () {
    const update = this.getUpdate() ?? {};
    const { paths } = updatedPaths(update);
    const nextState = update.$set?.state ?? update.state;
    if (update.$unset && 'state' in update.$unset)
      throw new PropertyFormVersionInvariantError('state cannot be removed');
    if (nextState === 'draft')
      throw new PropertyFormVersionInvariantError('a version cannot return to draft');
    if (paths.includes('supersededAt') && nextState !== 'superseded')
      throw new PropertyFormVersionInvariantError('supersededAt is set only when superseding');
    const content = paths.filter((path) => !FORM_VERSION_POST_PUBLISH_PATHS.includes(path));
    if (nextState === 'superseded') {
      if (content.length)
        throw new PropertyFormVersionInvariantError(
          `superseding cannot change ${content.join(', ')}`,
        );
      this.and([{ state: 'published' }]);
      return;
    }
    if (nextState !== undefined && nextState !== 'published')
      throw new PropertyFormVersionInvariantError(`unknown state ${String(nextState)}`);
    if (content.length || nextState === 'published') this.and([{ state: 'draft' }]);
  },
);
PropertyFormDefinitionVersionSchema.pre(
  ['replaceOne', 'findOneAndReplace'],
  { query: true, document: false },
  function () {
    throw new PropertyFormVersionInvariantError('versions are never replaced');
  },
);
PropertyFormDefinitionVersionSchema.pre(
  ['deleteOne', 'deleteMany', 'findOneAndDelete'],
  { query: true, document: false },
  function () {
    this.and([{ state: 'draft' }]);
  },
);
PropertyFormDefinitionVersionSchema.pre('deleteOne', { document: true, query: false }, function () {
  if (this.state !== 'draft')
    throw new PropertyFormVersionInvariantError('only drafts can be discarded');
});

Object.assign(exports, {
  FieldOptionDefinition,
  FieldValidationDefinition,
  FieldDefinitionEntry,
  PropertyFormDefinitionVersion,
  PropertyFormDefinitionVersionSchema,
  FORM_VERSION_POST_PUBLISH_PATHS,
  PropertyFormVersionInvariantError,
  formVersionShapeError,
});
