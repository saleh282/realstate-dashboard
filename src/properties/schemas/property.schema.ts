import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../../common/money/money';
import { AssetClassification, EvidenceDeliveryType } from '../../config/evidence-asset.types';
import { AccountType } from '../../users/identity.types';
import { PropertyLifecycleStatus, PropertyMediaOrigin, PropertyMediaTagCode } from '../property.types';
import { PROPERTY_PURPOSE_CATEGORY_LISTING_INDEX, PROPERTY_TYPE_LISTING_INDEX } from '../property-listing-indexes';
import { PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED } from '../../migrations/029-non-residential-attribute-registry';
import { PHASE9_PROMOTED_FACET_KEYS } from '../../migrations/030-phase9-facet-promotion';

/** Registry-mirrored option codes/bounds for the 7 Phase 9 promoted facets; read-only, never guesses beyond the seed. */
const PHASE9_SEED_BY_KEY = new Map(PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.map((entry) => [entry.key, entry]));
function phase9OptionCodes(key: string): readonly string[] {
  return (PHASE9_SEED_BY_KEY.get(key)?.options ?? []).map((option) => option.code);
}
function phase9HardBounds(key: string) {
  return PHASE9_SEED_BY_KEY.get(key)?.hardBounds ?? {};
}
if (!PHASE9_PROMOTED_FACET_KEYS.every((key) => PHASE9_SEED_BY_KEY.has(key))) {
  throw new Error('Phase 9 promoted facet key missing from the Phase 8 registry seed');
}

export type PropertyDocument = HydratedDocument<Property>;

@Schema({ _id: false })
export class PropertyAsset {
  @Prop() url?: string;
  @Prop({ required: true }) publicId: string;
  @Prop({ required: true, enum: ['image', 'raw'] }) resourceType: 'image' | 'raw';
  @Prop({ enum: ['upload', 'authenticated'] }) deliveryType?: EvidenceDeliveryType;
  @Prop({ enum: AssetClassification }) classification?: AssetClassification;
  @Prop({ enum: ['jpg', 'jpeg', 'png', 'webp', 'pdf'] }) format?: 'jpg' | 'jpeg' | 'png' | 'webp' | 'pdf';
  @Prop({ min: 1 }) bytes?: number;
  @Prop() label?: string;
  @Prop({ trim: true, maxlength: 80 }) slotId?: string;
  @Prop({ trim: true, maxlength: 80 }) mediaId?: string;
  @Prop({ enum: PropertyMediaTagCode }) tagCode?: PropertyMediaTagCode;
  @Prop({ enum: PropertyMediaOrigin }) origin?: PropertyMediaOrigin;
  @Prop({ min: 0 }) sortOrder?: number;
  @Prop({ match: /^[a-f0-9]{64}$/ }) contentDigest?: string;
}

const PropertyAssetSchema = SchemaFactory.createForClass(PropertyAsset);

/**
 * Typed facet values. V1 (DPF-023) promoted only `bedrooms` (integer 0-100).
 * Phase 9 (Search & Facets) adds exactly 7 non-residential facets, each
 * explicitly typed and validated against the same registry-approved option
 * codes/hard bounds `030-phase9-facet-promotion.ts` promoted. No dynamic keys
 * (`strict: 'throw'`, no generic map) — a facet is only ever addable here by
 * an engineering code change, never by data.
 */
@Schema({ _id: false, strict: 'throw' })
export class PropertyFacets {
  @Prop({ min: 0, max: 100, validate: { validator: (value: unknown) => value === undefined || Number.isInteger(value), message: 'facets.bedrooms must be an integer' } })
  bedrooms?: number;

  @Prop({ enum: phase9OptionCodes('shopFloorLevel') })
  shopFloorLevel?: string;

  @Prop({
    type: [String],
    default: undefined,
    validate: {
      validator: (value: unknown) =>
        value === undefined
        || (Array.isArray(value) && value.length > 0 && value.every((code) => phase9OptionCodes('commercialUseTypes').includes(code)) && new Set(value).size === value.length),
      message: 'facets.commercialUseTypes must be a non-empty array of unique approved option codes',
    },
  })
  commercialUseTypes?: string[];

  @Prop({
    min: phase9HardBounds('builtAreaSqm').min,
    max: phase9HardBounds('builtAreaSqm').max,
    validate: { validator: (value: unknown) => value === undefined || (typeof value === 'number' && Number.isFinite(value)), message: 'facets.builtAreaSqm must be a finite number' },
  })
  builtAreaSqm?: number;

  @Prop({ enum: phase9OptionCodes('powerSource') })
  powerSource?: string;

  @Prop({ enum: phase9OptionCodes('industrialUseType') })
  industrialUseType?: string;

  @Prop({ enum: phase9OptionCodes('soilType') })
  soilType?: string;

  @Prop({ enum: phase9OptionCodes('waterSource') })
  waterSource?: string;
}
export const PropertyFacetsSchema = SchemaFactory.createForClass(PropertyFacets);

@Schema({ timestamps: true, collection: 'properties' })
export class Property {
  /** @deprecated Compatibility alias for advertiserAccountId during migration. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true }) ownerId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User', index: true }) advertiserAccountId?: Types.ObjectId;
  @Prop({ enum: AccountType, index: true }) advertiserAccountTypeSnapshot?: AccountType;
  @Prop({ type: Types.ObjectId, ref: 'User', index: true }) createdByActorId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'PropertyRevision' }) currentPublicRevisionId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'PropertyRevision' }) pendingRevisionId?: Types.ObjectId;
  @Prop({ default: 0, min: 0 }) revisionSequence: number;
  @Prop({ required: true, enum: PropertyLifecycleStatus, default: PropertyLifecycleStatus.ACTIVE, index: true }) lifecycleStatus: PropertyLifecycleStatus;
  @Prop({ default: 0, min: 0 }) lifecycleVersion: number;
  @Prop() publishedAt?: Date;
  @Prop() archivedAt?: Date;
  @Prop({ trim: true, maxlength: 1000 }) lifecycleReason?: string;
  @Prop({ min: 1 }) propertyContractVersion?: number;
  @Prop() propertyContractMigratedAt?: Date;
  @Prop({ trim: true }) propertyContractMigrationRunId?: string;
  @Prop({ required: true, enum: ['sale', 'rent'], index: true }) operationType: string;
  @Prop({ required: true, trim: true, maxlength: 50, index: true }) propertyTypeCode: string;
  /**
   * Denormalized copy of the current public revision's catalog references, kept
   * in sync on approval (see `reviewForAdmin`) so the public listing/search
   * query can filter and sort on the `properties` collection directly instead
   * of joining `property_revisions` for every request.
   */
  @Prop({ type: Types.ObjectId, ref: 'PropertyPurposeCategory', index: true }) purposeCategoryId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'PropertyType', index: true }) purposeSubcategoryId?: Types.ObjectId;
  /** Every selected type of the current public classification, primary included (DPF-005). Absent on pre-DPF-005 rows until backfilled. */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'PropertyType' }], default: undefined }) purposeSubcategoryIds?: Types.ObjectId[];
  @Prop({ required: true, trim: true, maxlength: 150 }) title: string;
  @Prop({ required: true, trim: true, maxlength: 3000 }) description: string;
  @Prop({ required: true, trim: true, maxlength: 50, index: true }) governorateCode: string;
  @Prop({ required: true, trim: true, maxlength: 100 }) city: string;
  @Prop({ required: true, trim: true, maxlength: 100 }) district: string;
  @Prop({ trim: true, maxlength: 200 }) street?: string;
  @Prop({ trim: true, maxlength: 500 }) additionalAddressDetails?: string;
  @Prop({ required: true, min: -90, max: 90 }) latitude: number;
  @Prop({ required: true, min: -180, max: 180 }) longitude: number;
  @Prop({ required: true, min: 1 }) area: number;
  // Legacy spec fields (frozen §A5/§A6): no longer required on the aggregate;
  // properties created through a FormDefinition do not store them.
  @Prop({ min: 0, max: 100 }) bedrooms?: number;
  @Prop({ min: 0, max: 100 }) livingRooms?: number;
  @Prop({ min: 0, max: 100 }) kitchens?: number;
  @Prop({ min: 0, max: 100 }) bathrooms?: number;
  @Prop({ min: -10, max: 300 }) floor?: number;
  @Prop({ min: 1, max: 300 }) totalFloors?: number;
  @Prop({ min: 1800, max: 2200 }) buildingYear?: number;
  @Prop({ trim: true, maxlength: 50 }) finishingStatusCode?: string;
  @Prop({ trim: true, maxlength: 50 }) deliveryStatusCode?: string;
  @Prop({ type: [String], default: [] }) amenityCodes: string[];
  /**
   * Promoted search facets (frozen §A6), written only by approval sync and
   * the facet backfill, never from client input; each write replaces the
   * whole object.
   */
  @Prop({ type: PropertyFacetsSchema, default: undefined }) facets?: PropertyFacets;
  /** @deprecated Read-only migration source. New writes use totalPriceMinor. */
  @Prop() totalPrice?: number;
  /** @deprecated Read-only migration source. New writes use downPaymentMinor. */
  @Prop() downPayment?: number;
  @Prop({
    required: true,
    validate: { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }), message: 'totalPriceMinor is outside the safe integer range' },
  })
  totalPriceMinor: number;
  @Prop({
    validate: { validator: (value: unknown) => isMoneyMinorAmount(value), message: 'downPaymentMinor is outside the safe integer range' },
  })
  downPaymentMinor?: number;
  @Prop({ type: String, required: true, enum: [EGP_CURRENCY], default: EGP_CURRENCY, immutable: true }) currency: typeof EGP_CURRENCY;
  @Prop() moneyMigratedAt?: Date;
  @Prop({ trim: true }) moneyMigrationRunId?: string;
  @Prop({ min: 1 }) moneyMigrationVersion?: number;
  @Prop({ default: false }) isPriceNegotiable: boolean;
  @Prop({ trim: true, maxlength: 50 }) paymentMethodCode?: string;
  @Prop({ type: [PropertyAssetSchema], required: true }) images: PropertyAsset[];
  @Prop({ required: true, min: 0 }) coverImageIndex: number;
  @Prop({ type: PropertyAssetSchema }) titleDeed?: PropertyAsset;
  @Prop({ enum: ['owner', 'office', 'broker'] }) advertiserType?: string;
  @Prop({ default: false }) hidePhone: boolean;
  @Prop({ default: true, index: true }) isOwnerVisible: boolean;
  @Prop({ required: true, enum: ['pending_review', 'approved', 'rejected', 'hidden'], default: 'pending_review', index: true }) status: string;
  @Prop({ trim: true, maxlength: 1000 }) reviewReason?: string;
  @Prop({ type: Types.ObjectId, ref: 'User' }) reviewedBy?: Types.ObjectId;
  @Prop() reviewedAt?: Date;
}

export const PropertySchema = SchemaFactory.createForClass(Property);
PropertySchema.index({ createdAt: -1 });
PropertySchema.index({ advertiserAccountId: 1, createdAt: -1 }, { name: 'property_advertiser_created' });

// Public marketplace search/discovery (MAZAD-021). `status`/`isOwnerVisible`/
// `lifecycleStatus` gate every public query, so they lead each compound index;
// the trailing field is whichever dimension most narrows that particular query
// shape. Mongo can also use a leading prefix of any of these (e.g. just the
// three visibility fields) when a request has no extra filters.
PropertySchema.index(
  { status: 1, isOwnerVisible: 1, lifecycleStatus: 1, createdAt: -1 },
  { name: 'property_public_listing_newest' },
);
PropertySchema.index(
  { status: 1, isOwnerVisible: 1, lifecycleStatus: 1, operationType: 1, createdAt: -1 },
  { name: 'property_public_listing_operation_type' },
);
PropertySchema.index(
  { status: 1, isOwnerVisible: 1, lifecycleStatus: 1, governorateCode: 1, createdAt: -1 },
  { name: 'property_public_listing_governorate' },
);
// DPF-007: purpose-only and any-selected-type queries use separate indexes
// (created by migration 023). The replaced `property_public_listing_purpose`
// is deliberately no longer declared, so autoIndex never re-creates it after
// the manual migration 024 retires it.
PropertySchema.index(PROPERTY_PURPOSE_CATEGORY_LISTING_INDEX.key, PROPERTY_PURPOSE_CATEGORY_LISTING_INDEX.options);
PropertySchema.index(PROPERTY_TYPE_LISTING_INDEX.key, PROPERTY_TYPE_LISTING_INDEX.options);
// Ascending on price; MongoDB can walk this index in reverse to satisfy a
// descending price sort too, so one index covers both `price_asc`/`price_desc`.
PropertySchema.index(
  { status: 1, isOwnerVisible: 1, lifecycleStatus: 1, totalPriceMinor: 1 },
  { name: 'property_public_listing_price' },
);
