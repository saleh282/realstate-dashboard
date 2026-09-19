import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../../common/money/money';
import { PropertyAsset } from './property.schema';
import { AssetClassification, EvidenceDeliveryType } from '../../config/evidence-asset.types';
import { PropertyMarketingMode, PropertyRevisionModerationStatus } from '../property.types';

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
}

const RevisionAssetSchema = SchemaFactory.createForClass(RevisionAsset);

@Schema({ timestamps: true, collection: 'property_revisions', versionKey: 'version' })
export class PropertyRevision {
  @Prop({ type: Types.ObjectId, ref: 'Property', required: true, immutable: true, index: true }) propertyId: Types.ObjectId;
  @Prop({ required: true, min: 1, immutable: true }) revisionNumber: number;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true }) createdByActorId: Types.ObjectId;

  @Prop({ required: true, enum: ['sale', 'rent'], immutable: true }) operationType: string;
  @Prop({ type: Types.ObjectId, ref: 'PropertyPurposeCategory', immutable: true }) purposeCategoryId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'PropertyType', immutable: true }) purposeSubcategoryId?: Types.ObjectId;
  @Prop({ trim: true, maxlength: 50, immutable: true }) legacyPropertyTypeCode?: string;
  @Prop({ required: true, trim: true, maxlength: 150, immutable: true }) title: string;
  @Prop({ required: true, trim: true, maxlength: 3000, immutable: true }) description: string;
  @Prop({ required: true, trim: true, maxlength: 50, immutable: true }) governorateCode: string;
  @Prop({ required: true, trim: true, maxlength: 100, immutable: true }) city: string;
  @Prop({ required: true, trim: true, maxlength: 100, immutable: true }) district: string;
  @Prop({ trim: true, maxlength: 200, immutable: true }) street?: string;
  @Prop({ trim: true, maxlength: 500, immutable: true }) additionalAddressDetails?: string;
  @Prop({ required: true, min: -90, max: 90, immutable: true }) latitude: number;
  @Prop({ required: true, min: -180, max: 180, immutable: true }) longitude: number;
  @Prop({ required: true, min: 1, immutable: true }) area: number;
  @Prop({ required: true, min: 0, max: 100, immutable: true }) bedrooms: number;
  @Prop({ required: true, min: 0, max: 100, immutable: true }) livingRooms: number;
  @Prop({ required: true, min: 0, max: 100, immutable: true }) kitchens: number;
  @Prop({ required: true, min: 0, max: 100, immutable: true }) bathrooms: number;
  @Prop({ required: true, min: -10, max: 300, immutable: true }) floor: number;
  @Prop({ required: true, min: 1, max: 300, immutable: true }) totalFloors: number;
  @Prop({ required: true, min: 1800, max: 2200, immutable: true }) buildingYear: number;
  @Prop({ required: true, trim: true, maxlength: 50, immutable: true }) finishingStatusCode: string;
  @Prop({ required: true, trim: true, maxlength: 50, immutable: true }) deliveryStatusCode: string;
  @Prop({ type: [String], default: [], immutable: true }) amenityCodes: string[];
  @Prop({ required: true, immutable: true, validate: { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }) } }) totalPriceMinor: number;
  @Prop({ type: String, required: true, enum: [EGP_CURRENCY], default: EGP_CURRENCY, immutable: true }) currency: typeof EGP_CURRENCY;
  @Prop({ immutable: true, validate: { validator: (value: unknown) => value === undefined || isMoneyMinorAmount(value) } }) legacyDownPaymentMinor?: number;
  @Prop({ default: false, immutable: true }) isPriceNegotiable: boolean;
  @Prop({ type: [String], default: undefined, immutable: true }) paymentMethodCodes?: string[];
  @Prop({ enum: PropertyMarketingMode, immutable: true }) marketingMode?: PropertyMarketingMode;
  /** @deprecated Historical compatibility only. New writes use categorized galleryMedia. */
  @Prop({ type: RevisionAssetSchema, immutable: true }) entranceImageAsset?: PropertyAsset;
  @Prop({ type: [RevisionAssetSchema], default: [], immutable: true }) galleryMedia: PropertyAsset[];
  @Prop({ type: [RevisionAssetSchema], default: [], immutable: true }) privateEvidenceAssets: PropertyAsset[];
  @Prop({ required: true, min: 0, immutable: true }) coverImageIndex: number;
  @Prop({ default: false, immutable: true }) hidePhone: boolean;

  @Prop({ required: true, enum: PropertyRevisionModerationStatus, default: PropertyRevisionModerationStatus.PENDING_REVIEW, index: true }) moderationStatus: PropertyRevisionModerationStatus;
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
