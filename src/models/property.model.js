'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
const { EGP_CURRENCY, isMoneyMinorAmount } = require('../common/money/money');
const { AssetClassification } = require('../config/evidence-asset.types');
const { AccountType } = require('../domain/users/identity.types');
const {
  PropertyLifecycleStatus,
  PropertyMediaOrigin,
  PropertyMediaTagCode,
} = require('../domain/properties/property.types');
const {
  PROPERTY_SORTABLE_LISTING_INDEXES,
} = require('../domain/properties/property-listing-indexes');
const {
  PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED,
} = require('../migrations/029-non-residential-attribute-registry');
const { PHASE9_PROMOTED_FACET_KEYS } = require('../migrations/030-phase9-facet-promotion');
/** Registry-mirrored option codes/bounds for the 7 Phase 9 promoted facets; read-only, never guesses beyond the seed. */
const PHASE9_SEED_BY_KEY = new Map(
  PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.map((entry) => [entry.key, entry]),
);
function phase9OptionCodes(key) {
  return (PHASE9_SEED_BY_KEY.get(key)?.options ?? []).map((option) => option.code);
}
function phase9HardBounds(key) {
  return PHASE9_SEED_BY_KEY.get(key)?.hardBounds ?? {};
}
if (!PHASE9_PROMOTED_FACET_KEYS.every((key) => PHASE9_SEED_BY_KEY.has(key))) {
  throw new Error('Phase 9 promoted facet key missing from the Phase 8 registry seed');
}
class PropertyAsset {}
const PropertyAssetSchema = new mongooseSchema(
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
/**
 * Typed facet values. V1 (DPF-023) promoted only `bedrooms` (integer 0-100).
 * Phase 9 (Search & Facets) adds exactly 7 non-residential facets, each
 * explicitly typed and validated against the same registry-approved option
 * codes/hard bounds `030-phase9-facet-promotion.ts` promoted. No dynamic keys
 * (`strict: 'throw'`, no generic map) — a facet is only ever addable here by
 * an engineering code change, never by data.
 */
class PropertyFacets {}
const PropertyFacetsSchema = new mongooseSchema(
  {
    bedrooms: {
      type: Number,
      ...{
        min: 0,
        max: 100,
        validate: {
          validator: (value) => value === undefined || Number.isInteger(value),
          message: 'facets.bedrooms must be an integer',
        },
      },
    },
    shopFloorLevel: { type: String, ...{ enum: phase9OptionCodes('shopFloorLevel') } },
    commercialUseTypes: {
      type: [String],
      default: undefined,
      validate: {
        validator: (value) =>
          value === undefined ||
          (Array.isArray(value) &&
            value.length > 0 &&
            value.every((code) => phase9OptionCodes('commercialUseTypes').includes(code)) &&
            new Set(value).size === value.length),
        message:
          'facets.commercialUseTypes must be a non-empty array of unique approved option codes',
      },
    },
    builtAreaSqm: {
      type: Number,
      ...{
        min: phase9HardBounds('builtAreaSqm').min,
        max: phase9HardBounds('builtAreaSqm').max,
        validate: {
          validator: (value) =>
            value === undefined || (typeof value === 'number' && Number.isFinite(value)),
          message: 'facets.builtAreaSqm must be a finite number',
        },
      },
    },
    powerSource: { type: String, ...{ enum: phase9OptionCodes('powerSource') } },
    industrialUseType: { type: String, ...{ enum: phase9OptionCodes('industrialUseType') } },
    soilType: { type: String, ...{ enum: phase9OptionCodes('soilType') } },
    waterSource: { type: String, ...{ enum: phase9OptionCodes('waterSource') } },
  },
  { _id: false, strict: 'throw' },
);
class Property {}
const PropertySchema = new mongooseSchema(
  {
    ownerId: { type: mongooseSchema.Types.Mixed, ref: 'User', required: true, index: true },
    advertiserAccountId: { type: mongooseSchema.Types.Mixed, ref: 'User', index: true },
    advertiserAccountTypeSnapshot: { type: String, ...{ enum: AccountType, index: true } },
    createdByActorId: { type: mongooseSchema.Types.Mixed, ref: 'User', index: true },
    currentPublicRevisionId: { type: mongooseSchema.Types.Mixed, ref: 'PropertyRevision' },
    pendingRevisionId: { type: mongooseSchema.Types.Mixed, ref: 'PropertyRevision' },
    revisionSequence: { type: Number, ...{ default: 0, min: 0 } },
    lifecycleStatus: {
      type: String,
      ...{
        required: true,
        enum: PropertyLifecycleStatus,
        default: PropertyLifecycleStatus.ACTIVE,
        index: true,
      },
    },
    lifecycleVersion: { type: Number, ...{ default: 0, min: 0 } },
    publishedAt: { type: Date, ...{} },
    archivedAt: { type: Date, ...{} },
    lifecycleReason: { type: String, ...{ trim: true, maxlength: 1000 } },
    propertyContractVersion: { type: Number, ...{ min: 1 } },
    propertyContractMigratedAt: { type: Date, ...{} },
    propertyContractMigrationRunId: { type: String, ...{ trim: true } },
    operationType: { type: String, ...{ required: true, enum: ['sale', 'rent'], index: true } },
    propertyTypeCode: {
      type: String,
      ...{ required: true, trim: true, maxlength: 50, index: true },
    },
    purposeCategoryId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'PropertyPurposeCategory',
      index: true,
    },
    purposeSubcategoryId: { type: mongooseSchema.Types.Mixed, ref: 'PropertyType', index: true },
    purposeSubcategoryIds: {
      type: [{ type: mongooseSchema.Types.Mixed, ref: 'PropertyType' }],
      default: undefined,
    },
    title: { type: String, ...{ required: true, trim: true, maxlength: 150 } },
    description: { type: String, ...{ required: true, trim: true, maxlength: 3000 } },
    governorateCode: {
      type: String,
      ...{ required: true, trim: true, maxlength: 50, index: true },
    },
    city: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    district: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    street: { type: String, ...{ trim: true, maxlength: 200 } },
    additionalAddressDetails: { type: String, ...{ trim: true, maxlength: 500 } },
    latitude: { type: Number, ...{ required: true, min: -90, max: 90 } },
    longitude: { type: Number, ...{ required: true, min: -180, max: 180 } },
    area: { type: Number, ...{ required: true, min: 1 } },
    bedrooms: { type: Number, ...{ min: 0, max: 100 } },
    livingRooms: { type: Number, ...{ min: 0, max: 100 } },
    kitchens: { type: Number, ...{ min: 0, max: 100 } },
    bathrooms: { type: Number, ...{ min: 0, max: 100 } },
    floor: { type: Number, ...{ min: -10, max: 300 } },
    totalFloors: { type: Number, ...{ min: 1, max: 300 } },
    buildingYear: { type: Number, ...{ min: 1800, max: 2200 } },
    finishingStatusCode: { type: String, ...{ trim: true, maxlength: 50 } },
    deliveryStatusCode: { type: String, ...{ trim: true, maxlength: 50 } },
    amenityCodes: { type: [String], default: [] },
    facets: { type: PropertyFacetsSchema, default: undefined },
    totalPrice: { type: Number, ...{} },
    downPayment: { type: Number, ...{} },
    totalPriceMinor: {
      type: Number,
      ...{
        required: true,
        validate: {
          validator: (value) => isMoneyMinorAmount(value, { positive: true }),
          message: 'totalPriceMinor is outside the safe integer range',
        },
      },
    },
    downPaymentMinor: {
      type: Number,
      ...{
        validate: {
          validator: (value) => isMoneyMinorAmount(value),
          message: 'downPaymentMinor is outside the safe integer range',
        },
      },
    },
    currency: {
      type: String,
      required: true,
      enum: [EGP_CURRENCY],
      default: EGP_CURRENCY,
      immutable: true,
    },
    moneyMigratedAt: { type: Date, ...{} },
    moneyMigrationRunId: { type: String, ...{ trim: true } },
    moneyMigrationVersion: { type: Number, ...{ min: 1 } },
    isPriceNegotiable: { type: Boolean, ...{ default: false } },
    paymentMethodCode: { type: String, ...{ trim: true, maxlength: 50 } },
    images: { type: [PropertyAssetSchema], required: true },
    coverImageIndex: { type: Number, ...{ required: true, min: 0 } },
    titleDeed: { type: PropertyAssetSchema },
    advertiserType: { type: String, ...{ enum: ['owner', 'office', 'broker'] } },
    hidePhone: { type: Boolean, ...{ default: false } },
    isOwnerVisible: { type: Boolean, ...{ default: true, index: true } },
    status: {
      type: String,
      ...{
        required: true,
        enum: ['pending_review', 'approved', 'rejected', 'hidden'],
        default: 'pending_review',
        index: true,
      },
    },
    reviewReason: { type: String, ...{ trim: true, maxlength: 1000 } },
    reviewedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    reviewedAt: { type: Date, ...{} },
  },
  { timestamps: true, collection: 'properties' },
);
PropertySchema.index({ createdAt: -1 });
PropertySchema.index(
  { advertiserAccountId: 1, createdAt: -1 },
  { name: 'property_advertiser_created' },
);
// Public marketplace search/discovery (MAZAD-021). `status`/`isOwnerVisible`/
// `lifecycleStatus` gate every public query, so they lead each compound index;
// the trailing fields are the dimension that most narrows the query shape, then
// the sort (including its `_id` tie-breaker). Phase 13 (migration 034) moved to
// the sortable `_v2` set so the first page is served without a blocking sort;
// the original names are retired only by the manual migration 035 and are
// deliberately no longer declared here (autoIndex must not recreate them).
for (const index of PROPERTY_SORTABLE_LISTING_INDEXES)
  PropertySchema.index(index.key, index.options);

Object.assign(exports, {
  PropertyAsset,
  PropertyFacets,
  PropertyFacetsSchema,
  Property,
  PropertySchema,
});
