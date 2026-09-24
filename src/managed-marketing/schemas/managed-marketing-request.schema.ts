import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../../common/money/money';
import { ManagedMarketingPaymentStatus, ManagedMarketingRequestStatus } from '../managed-marketing.types';

export type ManagedMarketingRequestDocument = HydratedDocument<ManagedMarketingRequest>;

@Schema({ _id: false })
export class ManagedMarketingPackageSnapshot {
  @Prop({ type: Types.ObjectId, required: true, immutable: true }) packageId: Types.ObjectId;
  @Prop({ required: true, immutable: true }) packageVersion: number;
  @Prop({ required: true, trim: true, immutable: true }) code: string;
  @Prop({ required: true, trim: true, immutable: true }) nameAr: string;
  @Prop({ required: true, trim: true, immutable: true }) nameEn: string;
  @Prop({ trim: true, immutable: true }) detailsAr?: string;
  @Prop({ trim: true, immutable: true }) detailsEn?: string;
  @Prop({ type: [String], required: true, immutable: true }) includedServiceCodes: string[];
  @Prop({ type: [String], required: true, immutable: true }) benefitsAr: string[];
  @Prop({ type: [String], required: true, immutable: true }) benefitsEn: string[];
  @Prop({ required: true, immutable: true, validate: { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }) } }) priceMinor: number;
  @Prop({ type: String, required: true, enum: [EGP_CURRENCY], immutable: true }) currency: typeof EGP_CURRENCY;
}

const ManagedMarketingPackageSnapshotSchema = SchemaFactory.createForClass(ManagedMarketingPackageSnapshot);

@Schema({ timestamps: true, collection: 'managed_marketing_requests', versionKey: 'version' })
export class ManagedMarketingRequest {
  @Prop({ type: Types.ObjectId, ref: 'Property', required: true, index: true }) propertyId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'PropertyRevision', required: true, index: true }) propertyRevisionId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true }) advertiserAccountId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) createdByActorId: Types.ObjectId;
  @Prop({ type: ManagedMarketingPackageSnapshotSchema, required: true, immutable: true }) packageSnapshot: ManagedMarketingPackageSnapshot;
  @Prop({ required: true, enum: ManagedMarketingRequestStatus, default: ManagedMarketingRequestStatus.PENDING_REVIEW, index: true }) status: ManagedMarketingRequestStatus;
  @Prop({ required: true, enum: ManagedMarketingPaymentStatus, default: ManagedMarketingPaymentStatus.NOT_ELIGIBLE, index: true }) paymentStatus: ManagedMarketingPaymentStatus;
  @Prop({ type: Types.ObjectId, ref: 'User' }) reviewedByActorId?: Types.ObjectId;
  @Prop() reviewedAt?: Date;
  @Prop({ trim: true, maxlength: 1000 }) reviewReason?: string;
  @Prop({ trim: true, maxlength: 1000 }) cancellationReason?: string;
  @Prop() cancelledAt?: Date;
  /** Set only by the server-confirmed MANAGED_MARKETING payment (MAZAD-028). A factual timestamp; no SLA/schedule is derived from it here. */
  @Prop() paidAt?: Date;
  @Prop({ type: Types.ObjectId, ref: 'ManagedMarketingPayment' }) paidPaymentId?: Types.ObjectId;
}

export const ManagedMarketingRequestSchema = SchemaFactory.createForClass(ManagedMarketingRequest);
ManagedMarketingRequestSchema.index({ advertiserAccountId: 1, createdAt: -1 }, { name: 'managed_marketing_request_advertiser_history' });
ManagedMarketingRequestSchema.index({ status: 1, createdAt: 1, _id: 1 }, { name: 'managed_marketing_request_review_queue' });
ManagedMarketingRequestSchema.index({ propertyRevisionId: 1 }, { unique: true, name: 'managed_marketing_request_revision_unique' });
