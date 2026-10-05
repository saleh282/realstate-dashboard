'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
const { updatedPaths } = require('../common/mongo/update-paths');
const {
  FORM_DEFINITION_STATUSES,
  PROPERTY_FORM_LIMITS,
} = require('../domain/property-form-definitions/property-form-definition.constants');
/**
 * FormDefinition head (frozen §A2): exactly one per property type. Pointers
 * (`currentVersionId`/`currentVersion`, `draftVersionId`) change only through
 * the draft/publish lifecycle (DPF-031/032); `nextVersionNumber` only grows;
 * `version` is the head's optimistic-concurrency counter.
 */
class PropertyFormDefinition {}
const PropertyFormDefinitionSchema = new mongooseSchema(
  {
    purposeSubcategoryId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'PropertyType',
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      ...{ required: true, enum: FORM_DEFINITION_STATUSES, default: 'active' },
    },
    currentVersionId: { type: mongooseSchema.Types.Mixed, ref: 'PropertyFormDefinitionVersion' },
    currentVersion: { type: Number, ...{ min: 1 } },
    draftVersionId: { type: mongooseSchema.Types.Mixed, ref: 'PropertyFormDefinitionVersion' },
    nextVersionNumber: { type: Number, ...{ required: true, min: 1, default: 1 } },
    version: { type: Number, ...{ required: true, min: 0, default: 0 } },
    archivedAt: { type: Date, ...{} },
    archivedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    archivedReason: {
      type: String,
      ...{ trim: true, maxlength: PROPERTY_FORM_LIMITS.archiveReasonMaxLength },
    },
    createdBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    updatedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
  },
  { timestamps: true, collection: 'property_form_definitions' },
);
PropertyFormDefinitionSchema.index(
  { purposeSubcategoryId: 1 },
  { unique: true, name: 'property_form_definition_subcategory_unique' },
);
PropertyFormDefinitionSchema.index(
  { status: 1, purposeSubcategoryId: 1 },
  { name: 'property_form_definition_status' },
);
class PropertyFormDefinitionInvariantError extends Error {
  constructor(message) {
    super(`PROPERTY_FORM_DEFINITION_INVARIANT: ${message}`);
  }
}
const snapshotHead = (doc) => {
  doc.$locals.original = {
    nextVersionNumber: doc.nextVersionNumber,
    version: doc.version,
    purposeSubcategoryId: doc.purposeSubcategoryId?.toString(),
  };
};
// Stored counters for the save rules: taken on load and refreshed after every save.
PropertyFormDefinitionSchema.post('init', snapshotHead);
PropertyFormDefinitionSchema.post('save', snapshotHead);
PropertyFormDefinitionSchema.pre('save', function () {
  const original = this.$locals.original;
  if (this.isNew || !original) return;
  if (this.nextVersionNumber < original.nextVersionNumber)
    throw new PropertyFormDefinitionInvariantError('nextVersionNumber only increases');
  if (this.version < original.version)
    throw new PropertyFormDefinitionInvariantError('version only increases');
});
PropertyFormDefinitionSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
  const { paths } = updatedPaths(this.getUpdate());
  if (paths.includes('purposeSubcategoryId'))
    throw new PropertyFormDefinitionInvariantError('purposeSubcategoryId is immutable');
  const update = this.getUpdate();
  for (const counter of ['nextVersionNumber', 'version']) {
    const increment = update?.$inc?.[counter];
    if (increment !== undefined && !(increment > 0))
      throw new PropertyFormDefinitionInvariantError(`${counter} only increases`);
    if (update?.$set?.[counter] !== undefined || update?.[counter] !== undefined)
      throw new PropertyFormDefinitionInvariantError(`${counter} changes only through $inc`);
  }
});
PropertyFormDefinitionSchema.pre(
  ['replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  { query: true, document: false },
  function () {
    throw new PropertyFormDefinitionInvariantError(
      'form definition heads are never replaced or deleted',
    );
  },
);
PropertyFormDefinitionSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new PropertyFormDefinitionInvariantError('form definition heads are never deleted');
});

Object.assign(exports, {
  PropertyFormDefinition,
  PropertyFormDefinitionSchema,
  PropertyFormDefinitionInvariantError,
});
