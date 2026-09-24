import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../../common/money/money';

export type AuctionBidEntitlementDocument = HydratedDocument<AuctionBidEntitlement>;

/**
 * "This account has paid the configured entry fee for this auction"
 * (MAZAD-028) — and nothing more. It does not mean the auction is ACTIVE, the
 * account is currently eligible, or a bid is valid; MAZAD-027 re-checks all of
 * that on every bid.
 *
 * Created only by the server-side confirmation service, in the same
 * transaction that marks the payment SUCCEEDED. Unique per
 * `(auctionId, bidderAccountId)` and per `paymentId`, so no bidder can ever
 * hold two effective entitlements for one auction. Every field is immutable.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'auction_bid_entitlements', versionKey: false })
export class AuctionBidEntitlement {
  @Prop({ type: Types.ObjectId, ref: 'Auction', required: true, immutable: true }) auctionId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true }) bidderAccountId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'AuctionEntryPayment', required: true, immutable: true }) paymentId: Types.ObjectId;
  @Prop({
    type: Number,
    required: true,
    immutable: true,
    validate: { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }), message: 'amountMinor is outside the safe integer range' },
  })
  amountMinor: number;
  @Prop({ type: String, required: true, enum: [EGP_CURRENCY], immutable: true }) currency: typeof EGP_CURRENCY;
  @Prop({ type: Date, required: true, immutable: true }) grantedAt: Date;
}

export const AuctionBidEntitlementSchema = SchemaFactory.createForClass(AuctionBidEntitlement);

AuctionBidEntitlementSchema.index({ auctionId: 1, bidderAccountId: 1 }, { unique: true, name: 'entitlement_auction_bidder' });
AuctionBidEntitlementSchema.index({ paymentId: 1 }, { unique: true, name: 'entitlement_payment' });
AuctionBidEntitlementSchema.index({ bidderAccountId: 1, createdAt: -1 }, { name: 'entitlement_bidder_history' });
