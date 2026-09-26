import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../../common/money/money';
import { PropertyAsset } from './property.schema';
import { AssetClassification, EvidenceDeliveryType } from '../../config/evidence-asset.types';
import { PropertyMarketingMode, PropertyMediaOrigin, PropertyMediaTagCode, PropertyRevisionModerationStatus } from '../property.types';

export type PropertyRevisionDocument = HydratedDocument<PropertyRevision>;

@Schema({ _id: false })
export class RevisionAsset {
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

const RevisionAssetSchema = SchemaFactory.createForClass(RevisionAsset);
const immutableOutsideDraft = function (this: { moderationStatus?: PropertyRevisionModerationStatus }) {
  return this.moderationStatus !== PropertyRevisionModerationStatus.DRAFT;
};

// `minimize: false`: a pinned revision whose form has only optional fields stores
// `attributes: {}`; Mongoose would otherwise drop the empty object and break the
// all-or-nothing pin invariant (frozen §A5). No other revision path holds an object.
@Schema({ timestamps: true, collection: 'property_revisions', versionKey: 'version', minimize: false })
export class PropertyRevision {
  @Prop({ type: Types.ObjectId, ref: 'Property', required: true, immutable: true, index: true }) propertyId: Types.ObjectId;
  @Prop({ required: true, min: 1, immutable: true }) revisionNumber: number;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true }) createdByActorId: Types.ObjectId;

  @Prop({ required: true, enum: ['sale', 'rent'], immutable: immutableOutsideDraft }) operationType: string;
  @Prop({ type: Types.ObjectId, ref: 'PropertyPurposeCategory', immutable: immutableOutsideDraft }) purposeCategoryId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'PropertyType', immutable: immutableOutsideDraft }) purposeSubcategoryId?: Types.ObjectId;
  /** Every selected type, primary included, in canonical order (DPF-005). Pre-DPF-005 revisions omit it and read as [purposeSubcategoryId]. */
  @Prop({ type: [{ type: Types.ObjectId, ref: 'PropertyType' }], default: undefined, immutable: immutableOutsideDraft }) purposeSubcategoryIds?: Types.ObjectId[];
  @Prop({ trim: true, maxlength: 50, immutable: immutableOutsideDraft }) legacyPropertyTypeCode?: string;
  @Prop({ required: true, trim: true, maxlength: 150, immutable: immutableOutsideDraft }) title: string;
  @Prop({ required: true, trim: true, maxlength: 3000, immutable: immutableOutsideDraft }) description: string;
  @Prop({ required: true, trim: true, maxlength: 50, immutable: immutableOutsideDraft }) governorateCode: string;
  @Prop({ required: true, trim: true, maxlength: 100, immutable: immutableOutsideDraft }) city: string;
  @Prop({ required: true, trim: true, maxlength: 100, immutable: immutableOutsideDraft }) district: string;
  @Prop({ trim: true, maxlength: 200, immutable: immutableOutsideDraft }) street?: string;
  @Prop({ trim: true, maxlength: 500, immutable: immutableOutsideDraft }) additionalAddressDetails?: string;
  @Prop({ required: true, min: -90, max: 90, immutable: immutableOutsideDraft }) latitude: number;
  @Prop({ required: true, min: -180, max: 180, immutable: immutableOutsideDraft }) longitude: number;
  @Prop({ required: true, min: 1, immutable: immutableOutsideDraft }) area: number;
  // Legacy spec fields (frozen §A5): no longer required; never written on
  // revisions pinned to a FormDefinitionVersion, kept to read legacy revisions.
  @Prop({ min: 0, max: 100, immutable: immutableOutsideDraft }) bedrooms?: number;
  @Prop({ min: 0, max: 100, immutable: immutableOutsideDraft }) livingRooms?: number;
  @Prop({ min: 0, max: 100, immutable: immutableOutsideDraft }) kitchens?: number;
  @Prop({ min: 0, max: 100, immutable: immutableOutsideDraft }) bathrooms?: number;
  @Prop({ min: -10, max: 300, immutable: immutableOutsideDraft }) floor?: number;
  @Prop({ min: 1, max: 300, immutable: immutableOutsideDraft }) totalFloors?: number;
  @Prop({ min: 1800, max: 2200, immutable: immutableOutsideDraft }) buildingYear?: number;
  @Prop({ trim: true, maxlength: 50, immutable: immutableOutsideDraft }) finishingStatusCode?: string;
  @Prop({ trim: true, maxlength: 50, immutable: immutableOutsideDraft }) deliveryStatusCode?: string;
  @Prop({ type: [String], default: [], immutable: immutableOutsideDraft }) amenityCodes: string[];
  /**
   * Dynamic-form pin (frozen §A5): all four present (pinned to the PRIMARY
   * type's version) or all four absent (legacy revision, read through the
   * legacy adapter). Never rewritten outside draft.
   */
  @Prop({ type: Types.ObjectId, ref: 'PropertyFormDefinition', immutable: immutableOutsideDraft }) formDefinitionId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'PropertyFormDefinitionVersion', immutable: immutableOutsideDraft }) formDefinitionVersionId?: Types.ObjectId;
  @Prop({ min: 1, immutable: immutableOutsideDraft }) formDefinitionVersion?: number;
  @Prop({ match: /^[a-f0-9]{64}$/, immutable: immutableOutsideDraft }) formContentHash?: string;
  /** Flat map of the pinned version's applicable fields; present exactly when pinned. */
  @Prop({ type: MongooseSchema.Types.Mixed, immutable: immutableOutsideDraft }) attributes?: Record<string, unknown>;
  @Prop({ required: true, immutable: immutableOutsideDraft, validate: { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }) } }) totalPriceMinor: number;
  @Prop({ type: String, required: true, enum: [EGP_CURRENCY], default: EGP_CURRENCY, immutable: immutableOutsideDraft }) currency: typeof EGP_CURRENCY;
  @Prop({ immutable: immutableOutsideDraft, validate: { validator: (value: unknown) => value === undefined || isMoneyMinorAmount(value) } }) legacyDownPaymentMinor?: number;
  @Prop({ default: false, immutable: immutableOutsideDraft }) isPriceNegotiable: boolean;
  @Prop({ type: [String], default: undefined, immutable: immutableOutsideDraft }) paymentMethodCodes?: string[];
  @Prop({ enum: PropertyMarketingMode, immutable: immutableOutsideDraft }) marketingMode?: PropertyMarketingMode;
  /** @deprecated Historical compatibility only. New writes use categorized galleryMedia. */
  @Prop({ type: RevisionAssetSchema, immutable: immutableOutsideDraft }) entranceImageAsset?: PropertyAsset;
  @Prop({ type: [RevisionAssetSchema], default: [], immutable: immutableOutsideDraft }) galleryMedia: PropertyAsset[];
  @Prop({ type: [RevisionAssetSchema], default: [], immutable: immutableOutsideDraft }) privateEvidenceAssets: PropertyAsset[];
  /** Retained, non-projected references replaced while a DRAFT is edited. */
  @Prop({ type: [RevisionAssetSchema], default: [] }) supersededAssets: PropertyAsset[];
  @Prop({ required: true, min: 0, immutable: immutableOutsideDraft }) coverImageIndex: number;
  @Prop({ default: false, immutable: immutableOutsideDraft }) hidePhone: boolean;

  @Prop({ required: true, enum: PropertyRevisionModerationStatus, default: PropertyRevisionModerationStatus.DRAFT, index: true }) moderationStatus: PropertyRevisionModerationStatus;
  @Prop({ default: 0, min: 0 }) decisionVersion: number;
  @Prop() submittedAt?: Date;
  @Prop({ trim: true, maxlength: 1000 }) reviewReason?: string;
  @Prop({ type: Types.ObjectId, ref: 'User' }) reviewedBy?: Types.ObjectId;
  @Prop() reviewedAt?: Date;
  @Prop({ min: 1 }) migrationVersion?: number;
  @Prop({ trim: true }) migrationRunId?: string;
  @Prop() migratedAt?: Date;
}

export const PropertyRevisionSchema = SchemaFactory.createForClass(PropertyRevision);
PropertyRevisionSchema.index({ propertyId: 1, revisionNumber: 1 }, { unique: true, name: 'property_revision_sequence_unique' });
PropertyRevisionSchema.index({ moderationStatus: 1, createdAt: 1, _id: 1 }, { name: 'property_revision_review_queue' });
PropertyRevisionSchema.index(
  { propertyId: 1, moderationStatus: 1 },
  { unique: true, partialFilterExpression: { moderationStatus: 'pending_review' }, name: 'property_one_pending_revision' },
);
PropertyRevisionSchema.index(
  { propertyId: 1, moderationStatus: 1 },
  { unique: true, partialFilterExpression: { moderationStatus: 'draft' }, name: 'property_one_draft_revision' },
);

export const REVISION_FORM_PIN_FIELDS = ['formDefinitionId', 'formDefinitionVersionId', 'formDefinitionVersion', 'formContentHash'] as const;

/** Frozen §A5: the pin is all-or-nothing, and `attributes` exists exactly when pinned. */
export function revisionFormPinError(revision: Record<string, unknown>): string | null {
  const present = REVISION_FORM_PIN_FIELDS.filter((field) => revision[field] !== undefined && revision[field] !== null);
  if (present.length !== 0 && present.length !== REVISION_FORM_PIN_FIELDS.length) return 'form pin fields must be all present or all absent';
  const attributes = revision.attributes;
  const hasAttributes = attributes !== undefined && attributes !== null;
  if (hasAttributes !== (present.length === REVISION_FORM_PIN_FIELDS.length)) return 'attributes must be present exactly when the revision is pinned';
  if (hasAttributes && (typeof attributes !== 'object' || Array.isArray(attributes))) return 'attributes must be a flat object';
  return null;
}

PropertyRevisionSchema.pre('validate', function () {
  const error = revisionFormPinError(this.toObject({ depopulate: true }) as Record<string, unknown>);
  if (error) throw new Error(`PROPERTY_REVISION_FORM_PIN_INVALID: ${error}`);
});
