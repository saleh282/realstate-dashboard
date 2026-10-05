'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Schema: MongooseSchema, Types } = require('mongoose');
const { EGP_CURRENCY, isMoneyMinorAmount } = require('../common/money/money');
const { AssetClassification } = require('../config/evidence-asset.types');
const {
  PropertyMarketingMode,
  PropertyMediaOrigin,
  PropertyMediaTagCode,
  PropertyRevisionModerationStatus,
} = require('../domain/properties/property.types');
class RevisionAsset {}
const RevisionAssetSchema = new mongooseSchema(
  {
    url: { type: String, ...{} },
    publicId: { type: String, ...{ required: true } },
    resourceType: { type: String, ...{ required: true, enum: ['image', 'raw'] } },
    deliveryType: { type: String, ...{ enum: ['upload', 'authenticated'] } },
    classification: { type: String, ...{ enum: AssetClassification } },
    format: { type: String, ...{ enum: ['jpg', 'jpeg', 'png', 'webp', 'pdf'] } },
    bytes: { type: Number, ...{ min: 1 } },
    label: { type: String, ...{} },
    slotId: { type: String, ...{ trim: true, maxlength: 80 } },
    mediaId: { type: String, ...{ trim: true, maxlength: 80 } },
    tagCode: { type: String, ...{ enum: PropertyMediaTagCode } },
    origin: { type: String, ...{ enum: PropertyMediaOrigin } },
    sortOrder: { type: Number, ...{ min: 0 } },
    contentDigest: { type: String, ...{ match: /^[a-f0-9]{64}$/ } },
  },
  { _id: false },
);
const immutableOutsideDraft = function () {
  return this.moderationStatus !== PropertyRevisionModerationStatus.DRAFT;
};
// `minimize: false`: a pinned revision whose form has only optional fields stores
// `attributes: {}`; Mongoose would otherwise drop the empty object and break the
// all-or-nothing pin invariant (frozen §A5). No other revision path holds an object.
class PropertyRevision {}
const PropertyRevisionSchema = new mongooseSchema(
  {
    propertyId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'Property',
      required: true,
      immutable: true,
      index: true,
    },
    revisionNumber: { type: Number, ...{ required: true, min: 1, immutable: true } },
    createdByActorId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'User',
      required: true,
      immutable: true,
    },
    operationType: {
      type: String,
      ...{ required: true, enum: ['sale', 'rent'], immutable: immutableOutsideDraft },
    },
    purposeCategoryId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'PropertyPurposeCategory',
      immutable: immutableOutsideDraft,
    },
    purposeSubcategoryId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'PropertyType',
      immutable: immutableOutsideDraft,
    },
    purposeSubcategoryIds: {
      type: [{ type: mongooseSchema.Types.Mixed, ref: 'PropertyType' }],
      default: undefined,
      immutable: immutableOutsideDraft,
    },
    legacyPropertyTypeCode: {
      type: String,
      ...{ trim: true, maxlength: 50, immutable: immutableOutsideDraft },
    },
    title: {
      type: String,
      ...{ required: true, trim: true, maxlength: 150, immutable: immutableOutsideDraft },
    },
    description: {
      type: String,
      ...{ required: true, trim: true, maxlength: 3000, immutable: immutableOutsideDraft },
    },
    governorateCode: {
      type: String,
      ...{ required: true, trim: true, maxlength: 50, immutable: immutableOutsideDraft },
    },
    city: {
      type: String,
      ...{ required: true, trim: true, maxlength: 100, immutable: immutableOutsideDraft },
    },
    district: {
      type: String,
      ...{ required: true, trim: true, maxlength: 100, immutable: immutableOutsideDraft },
    },
    street: { type: String, ...{ trim: true, maxlength: 200, immutable: immutableOutsideDraft } },
    additionalAddressDetails: {
      type: String,
      ...{ trim: true, maxlength: 500, immutable: immutableOutsideDraft },
    },
    latitude: {
      type: Number,
      ...{ required: true, min: -90, max: 90, immutable: immutableOutsideDraft },
    },
    longitude: {
      type: Number,
      ...{ required: true, min: -180, max: 180, immutable: immutableOutsideDraft },
    },
    area: { type: Number, ...{ required: true, min: 1, immutable: immutableOutsideDraft } },
    bedrooms: { type: Number, ...{ min: 0, max: 100, immutable: immutableOutsideDraft } },
    livingRooms: { type: Number, ...{ min: 0, max: 100, immutable: immutableOutsideDraft } },
    kitchens: { type: Number, ...{ min: 0, max: 100, immutable: immutableOutsideDraft } },
    bathrooms: { type: Number, ...{ min: 0, max: 100, immutable: immutableOutsideDraft } },
    floor: { type: Number, ...{ min: -10, max: 300, immutable: immutableOutsideDraft } },
    totalFloors: { type: Number, ...{ min: 1, max: 300, immutable: immutableOutsideDraft } },
    buildingYear: { type: Number, ...{ min: 1800, max: 2200, immutable: immutableOutsideDraft } },
    finishingStatusCode: {
      type: String,
      ...{ trim: true, maxlength: 50, immutable: immutableOutsideDraft },
    },
    deliveryStatusCode: {
      type: String,
      ...{ trim: true, maxlength: 50, immutable: immutableOutsideDraft },
    },
    amenityCodes: { type: [String], default: [], immutable: immutableOutsideDraft },
    formDefinitionId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'PropertyFormDefinition',
      immutable: immutableOutsideDraft,
    },
    formDefinitionVersionId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'PropertyFormDefinitionVersion',
      immutable: immutableOutsideDraft,
    },
    formDefinitionVersion: { type: Number, ...{ min: 1, immutable: immutableOutsideDraft } },
    formContentHash: {
      type: String,
      ...{ match: /^[a-f0-9]{64}$/, immutable: immutableOutsideDraft },
    },
    attributes: { type: MongooseSchema.Types.Mixed, immutable: immutableOutsideDraft },
    totalPriceMinor: {
      type: Number,
      ...{
        required: true,
        immutable: immutableOutsideDraft,
        validate: { validator: (value) => isMoneyMinorAmount(value, { positive: true }) },
      },
    },
    currency: {
      type: String,
      required: true,
      enum: [EGP_CURRENCY],
      default: EGP_CURRENCY,
      immutable: immutableOutsideDraft,
    },
    legacyDownPaymentMinor: {
      type: Number,
      ...{
        immutable: immutableOutsideDraft,
        validate: { validator: (value) => value === undefined || isMoneyMinorAmount(value) },
      },
    },
    isPriceNegotiable: { type: Boolean, ...{ default: false, immutable: immutableOutsideDraft } },
    paymentMethodCodes: { type: [String], default: undefined, immutable: immutableOutsideDraft },
    marketingMode: {
      type: String,
      ...{ enum: PropertyMarketingMode, immutable: immutableOutsideDraft },
    },
    entranceImageAsset: { type: RevisionAssetSchema, immutable: immutableOutsideDraft },
    galleryMedia: { type: [RevisionAssetSchema], default: [], immutable: immutableOutsideDraft },
    privateEvidenceAssets: {
      type: [RevisionAssetSchema],
      default: [],
      immutable: immutableOutsideDraft,
    },
    supersededAssets: { type: [RevisionAssetSchema], default: [] },
    coverImageIndex: {
      type: Number,
      ...{ required: true, min: 0, immutable: immutableOutsideDraft },
    },
    hidePhone: { type: Boolean, ...{ default: false, immutable: immutableOutsideDraft } },
    moderationStatus: {
      type: String,
      ...{
        required: true,
        enum: PropertyRevisionModerationStatus,
        default: PropertyRevisionModerationStatus.DRAFT,
        index: true,
      },
    },
    decisionVersion: { type: Number, ...{ default: 0, min: 0 } },
    submittedAt: { type: Date, ...{} },
    reviewReason: { type: String, ...{ trim: true, maxlength: 1000 } },
    reviewedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    reviewedAt: { type: Date, ...{} },
    migrationVersion: { type: Number, ...{ min: 1 } },
    migrationRunId: { type: String, ...{ trim: true } },
    migratedAt: { type: Date, ...{} },
  },
  { timestamps: true, collection: 'property_revisions', versionKey: 'version', minimize: false },
);
PropertyRevisionSchema.index(
  { propertyId: 1, revisionNumber: 1 },
  { unique: true, name: 'property_revision_sequence_unique' },
);
PropertyRevisionSchema.index(
  { moderationStatus: 1, createdAt: 1, _id: 1 },
  { name: 'property_revision_review_queue' },
);
PropertyRevisionSchema.index(
  { propertyId: 1, moderationStatus: 1 },
  {
    unique: true,
    partialFilterExpression: { moderationStatus: 'pending_review' },
    name: 'property_one_pending_revision',
  },
);
PropertyRevisionSchema.index(
  { propertyId: 1, moderationStatus: 1 },
  {
    unique: true,
    partialFilterExpression: { moderationStatus: 'draft' },
    name: 'property_one_draft_revision',
  },
);
const REVISION_FORM_PIN_FIELDS = [
  'formDefinitionId',
  'formDefinitionVersionId',
  'formDefinitionVersion',
  'formContentHash',
];
/** Frozen §A5: the pin is all-or-nothing, and `attributes` exists exactly when pinned. */
function revisionFormPinError(revision) {
  const present = REVISION_FORM_PIN_FIELDS.filter(
    (field) => revision[field] !== undefined && revision[field] !== null,
  );
  if (present.length !== 0 && present.length !== REVISION_FORM_PIN_FIELDS.length)
    return 'form pin fields must be all present or all absent';
  const attributes = revision.attributes;
  const hasAttributes = attributes !== undefined && attributes !== null;
  if (hasAttributes !== (present.length === REVISION_FORM_PIN_FIELDS.length))
    return 'attributes must be present exactly when the revision is pinned';
  if (hasAttributes && (typeof attributes !== 'object' || Array.isArray(attributes)))
    return 'attributes must be a flat object';
  return null;
}
PropertyRevisionSchema.pre('validate', function () {
  const error = revisionFormPinError(this.toObject({ depopulate: true }));
  if (error) throw new Error(`PROPERTY_REVISION_FORM_PIN_INVALID: ${error}`);
});

Object.assign(exports, {
  RevisionAsset,
  PropertyRevision,
  PropertyRevisionSchema,
  REVISION_FORM_PIN_FIELDS,
  revisionFormPinError,
});
