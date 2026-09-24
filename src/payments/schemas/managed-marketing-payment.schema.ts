import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../../common/money/money';
import { EntryPaymentStatus, PaymentPurpose, PaymentReconciliationFlag } from '../payment.types';

export type ManagedMarketingPaymentDocument = HydratedDocument<ManagedMarketingPayment>;

/**
 * One attempt to pay for a managed-marketing request (MAZAD-028). Deliberately
 * a SEPARATE collection from `auction_entry_payments`: different owner
 * reference (`requestId`, never an auction), different business effect
 * (request → PAID), and it can never create an auction entitlement.
 *
 * `amountMinor`/`currency` are copied from the request's immutable package
 * snapshot at initiation. Same attempt/`isLive` mechanics as the auction
 * payment: at most one live (INITIATED/SUCCEEDED) attempt per request.
 */
@Schema({ timestamps: true, collection: 'managed_marketing_payments', versionKey: false })
export class ManagedMarketingPayment {
  @Prop({ type: String, enum: [PaymentPurpose.MANAGED_MARKETING], default: PaymentPurpose.MANAGED_MARKETING, required: true, immutable: true }) purpose: PaymentPurpose.MANAGED_MARKETING;
  @Prop({ type: Types.ObjectId, ref: 'ManagedMarketingRequest', required: true, immutable: true }) requestId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true }) advertiserAccountId: Types.ObjectId;

  @Prop({
    type: Number,
    required: true,
    immutable: true,
    validate: { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }), message: 'amountMinor is outside the safe integer range' },
  })
  amountMinor: number;
  @Prop({ type: String, required: true, enum: [EGP_CURRENCY], immutable: true }) currency: typeof EGP_CURRENCY;

  @Prop({ type: String, required: true, enum: EntryPaymentStatus, default: EntryPaymentStatus.INITIATED }) status: EntryPaymentStatus;
  @Prop({ type: Boolean }) isLive?: boolean;

  @Prop({ type: Date, required: true, immutable: true }) initiatedAt: Date;
  @Prop({ type: Date }) confirmedAt?: Date;
  @Prop({ type: Date }) failedAt?: Date;
  @Prop({ type: String, maxlength: 100 }) failureCode?: string;

  @Prop({ type: String, required: true, maxlength: 50, immutable: true }) provider: string;
  @Prop({ type: String, maxlength: 200 }) providerReference?: string;
  @Prop({ type: String, maxlength: 200 }) providerEventId?: string;
  @Prop({ type: String, enum: PaymentReconciliationFlag }) reconciliationFlag?: PaymentReconciliationFlag;
  @Prop({ type: Date }) lastVerifiedAt?: Date;
}

export const ManagedMarketingPaymentSchema = SchemaFactory.createForClass(ManagedMarketingPayment);

ManagedMarketingPaymentSchema.index(
  { requestId: 1 },
  { unique: true, partialFilterExpression: { isLive: true }, name: 'mm_payment_one_live_per_request' },
);
ManagedMarketingPaymentSchema.index(
  { provider: 1, providerReference: 1 },
  { unique: true, partialFilterExpression: { providerReference: { $type: 'string' } }, name: 'mm_payment_provider_reference' },
);
ManagedMarketingPaymentSchema.index({ status: 1, initiatedAt: 1 }, { name: 'mm_payment_status_initiated' });
ManagedMarketingPaymentSchema.index({ advertiserAccountId: 1, createdAt: -1 }, { name: 'mm_payment_advertiser_history' });
