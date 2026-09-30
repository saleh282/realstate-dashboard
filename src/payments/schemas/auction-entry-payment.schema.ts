import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../../common/money/money';
import { EntryPaymentStatus, PaymentPurpose, PaymentReconciliationFlag } from '../payment.types';

export type AuctionEntryPaymentDocument = HydratedDocument<AuctionEntryPayment>;

/**
 * One attempt to pay a specific auction's entry fee (MAZAD-028). Provider
 * neutral: it stores no card data, credentials or raw provider payloads.
 *
 * Identity/amount fields are immutable and server-owned: `amountMinor` is the
 * auction's configured fee snapshot at initiation, never a client value.
 * Only `status`, `confirmedAt`/`failedAt`, `providerReference`, provider event
 * ids, failure/reconciliation info and `isLive` ever change, and only via the
 * server-side services' conditional updates.
 *
 * `isLive` is true while the attempt is INITIATED or SUCCEEDED and is unset
 * on FAILED; a partial unique index over it guarantees at most one live
 * attempt per (auction, bidder) — "a bidder pays once per auction" — while
 * still allowing a fresh attempt after a failure.
 */
@Schema({ timestamps: true, collection: 'auction_entry_payments', versionKey: false })
export class AuctionEntryPayment {
  @Prop({ type: String, enum: [PaymentPurpose.AUCTION_ENTRY], default: PaymentPurpose.AUCTION_ENTRY, required: true, immutable: true }) purpose: PaymentPurpose.AUCTION_ENTRY;
  @Prop({ type: Types.ObjectId, ref: 'Auction', required: true, immutable: true }) auctionId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true }) bidderAccountId: Types.ObjectId;

  @Prop({
    type: Number,
    required: true,
    immutable: true,
    validate: { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }), message: 'amountMinor is outside the safe integer range' },
  })
  amountMinor: number;
  @Prop({ type: String, required: true, enum: [EGP_CURRENCY], default: EGP_CURRENCY, immutable: true }) currency: typeof EGP_CURRENCY;

  @Prop({ type: String, required: true, enum: EntryPaymentStatus, default: EntryPaymentStatus.INITIATED }) status: EntryPaymentStatus;
  @Prop({ type: Boolean }) isLive?: boolean;

  @Prop({ type: Date, required: true, immutable: true }) initiatedAt: Date;
  /** Server-confirmed success time. Set only by the confirmation service. */
  @Prop({ type: Date }) confirmedAt?: Date;
  @Prop({ type: Date }) failedAt?: Date;
  @Prop({ type: String, maxlength: 100 }) failureCode?: string;

  /** Non-secret provider adapter identifier (`AuctionPaymentProviderPort.providerKey`). */
  @Prop({ type: String, required: true, maxlength: 50, immutable: true }) provider: string;
  /** The provider's reference; attached once after gateway initiation. Unique per provider. */
  @Prop({ type: String, maxlength: 200 }) providerReference?: string;
  /** The provider's own transaction/event id at confirmation, kept for reconciliation. */
  @Prop({ type: String, maxlength: 200 }) providerEventId?: string;

  @Prop({ type: String, enum: PaymentReconciliationFlag }) reconciliationFlag?: PaymentReconciliationFlag;
  @Prop({ type: Date }) lastVerifiedAt?: Date;
}

export const AuctionEntryPaymentSchema = SchemaFactory.createForClass(AuctionEntryPayment);

// At most one live (INITIATED or SUCCEEDED) attempt per bidder per auction.
AuctionEntryPaymentSchema.index(
  { auctionId: 1, bidderAccountId: 1 },
  { unique: true, partialFilterExpression: { isLive: true }, name: 'entry_payment_one_live_per_bidder_auction' },
);
// Maps a provider reference back to the internal payment; unique per provider.
AuctionEntryPaymentSchema.index(
  { provider: 1, providerReference: 1 },
  { unique: true, partialFilterExpression: { providerReference: { $type: 'string' } }, name: 'entry_payment_provider_reference' },
);
// Reconciliation sweeps: stale INITIATED attempts.
AuctionEntryPaymentSchema.index({ status: 1, initiatedAt: 1 }, { name: 'entry_payment_status_initiated' });
AuctionEntryPaymentSchema.index({ bidderAccountId: 1, createdAt: -1 }, { name: 'entry_payment_bidder_history' });
// MAZAD-035: per-auction operational reads (Admin payment summary, pre-start revision safety check).
AuctionEntryPaymentSchema.index({ auctionId: 1, status: 1 }, { name: 'entry_payment_auction_status' });
