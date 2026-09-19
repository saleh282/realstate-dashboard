import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
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

@Schema({ timestamps: true, collection: 'property_revisions', versionKey: 'version' })
export class PropertyRevision {
  @Prop({ type: Types.ObjectId, ref: 'Property', required: true, immutable: true, index: true }) propertyId: Types.ObjectId;
  @Prop({ required: true, min: 1, immutable: true }) revisionNumber: number;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true }) createdByActorId: Types.ObjectId;

  @Prop({ required: true, enum: ['sale', 'rent'], immutable: immutableOutsideDraft }) operationType: string;
  @Prop({ type: Types.ObjectId, ref: 'PropertyPurposeCategory', immutable: immutableOutsideDraft }) purposeCategoryId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'PropertyType', immutable: immutableOutsideDraft }) purposeSubcategoryId?: Types.ObjectId;
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
  @Prop({ required: true, min: 0, max: 100, immutable: immutableOutsideDraft }) bedrooms: number;
  @Prop({ required: true, min: 0, max: 100, immutable: immutableOutsideDraft }) livingRooms: number;
  @Prop({ required: true, min: 0, max: 100, immutable: immutableOutsideDraft }) kitchens: number;
  @Prop({ required: true, min: 0, max: 100, immutable: immutableOutsideDraft }) bathrooms: number;
  @Prop({ required: true, min: -10, max: 300, immutable: immutableOutsideDraft }) floor: number;
  @Prop({ required: true, min: 1, max: 300, immutable: immutableOutsideDraft }) totalFloors: number;
  @Prop({ required: true, min: 1800, max: 2200, immutable: immutableOutsideDraft }) buildingYear: number;
  @Prop({ required: true, trim: true, maxlength: 50, immutable: immutableOutsideDraft }) finishingStatusCode: string;
  @Prop({ required: true, trim: true, maxlength: 50, immutable: immutableOutsideDraft }) deliveryStatusCode: string;
  @Prop({ type: [String], default: [], immutable: immutableOutsideDraft }) amenityCodes: string[];
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
