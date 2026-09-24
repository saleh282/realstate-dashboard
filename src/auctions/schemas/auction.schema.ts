import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../../common/money/money';
import { AccountType } from '../../users/identity.types';
import { AuctionStatus } from '../auction.types';

export type AuctionDocument = HydratedDocument<Auction>;

/**
 * The immutable record of the rules an auction was created under (see
 * `buildAuctionRuleSnapshot`). Every field is `immutable: true`: once set at
 * creation, no later property edit, account change, or global rule update
 * can alter what a specific auction promised its bidders. MAZAD-024's bid
 * acceptance / anti-sniping / closing logic must read from this snapshot,
 * not from any other mutable source.
 */
@Schema({ _id: false })
export class AuctionRuleSnapshot {
  @Prop({ required: true, min: 1, immutable: true }) version: number;
  @Prop({
    required: true,
    immutable: true,
    validate: { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }), message: 'startingPriceMinor is outside the safe integer range' },
  })
  startingPriceMinor: number;
  @Prop({
    required: true,
    immutable: true,
    validate: { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }), message: 'minimumBidStepMinor is outside the safe integer range' },
  })
  minimumBidStepMinor: number;
  @Prop({ type: String, required: true, enum: [EGP_CURRENCY], immutable: true }) currency: typeof EGP_CURRENCY;
  @Prop({ required: true, immutable: true }) scheduledStartAt: Date;
  @Prop({ required: true, immutable: true }) scheduledEndAt: Date;
  @Prop({ required: true, immutable: true, default: false }) hasReservePrice: boolean;
  @Prop({ required: true, immutable: true, default: true }) advertiserSelfBidForbidden: boolean;
  @Prop({ required: true, immutable: true, default: true }) adminBiddingForbidden: boolean;
  @Prop({ required: true, immutable: true, default: true }) bidsAreImmutable: boolean;
  @Prop({ required: true, immutable: true, default: true }) serverTimeAuthoritative: boolean;
  @Prop({ required: true, immutable: true, default: true }) automaticWinnerDetermination: boolean;
  @Prop({ required: true, immutable: true, default: false }) secondPlacePromotionOnCancellation: boolean;
  @Prop({ required: true, min: 1, immutable: true }) antiSnipingWindowSeconds: number;
  @Prop({ required: true, min: 1, immutable: true }) antiSnipingExtensionSeconds: number;
}

const AuctionRuleSnapshotSchema = SchemaFactory.createForClass(AuctionRuleSnapshot);

/**
 * The admin-configured bidder entry fee for ONE auction (MAZAD-028).
 * Write-once (set only while the auction is SCHEDULED and has no fee, via a
 * conditional update in `AuctionEntryFeeService`), server-owned, and never
 * derived from a bidder-supplied amount. Absent = NOT configured = paid
 * bidding fails closed; it is never read as zero/free.
 */
@Schema({ _id: false })
export class AuctionEntryFee {
  @Prop({
    required: true,
    validate: { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }), message: 'entry fee amountMinor is outside the safe integer range' },
  })
  amountMinor: number;
  @Prop({ type: String, required: true, enum: [EGP_CURRENCY] }) currency: typeof EGP_CURRENCY;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) configuredByActorId: Types.ObjectId;
  @Prop({ required: true }) configuredAt: Date;
}

const AuctionEntryFeeSchema = SchemaFactory.createForClass(AuctionEntryFee);

/**
 * Persistence/domain foundation for auctions (MAZAD-023). Establishes the
 * schema, immutable rule snapshot, status vocabulary and indexes that later
 * tasks (bid acceptance, anti-sniping execution, scheduling/closing
 * workers, cancellation, winner selection, payment entitlement) build on —
 * none of that lifecycle logic is implemented here.
 */
@Schema({ timestamps: true, collection: 'auctions', versionKey: 'version' })
export class Auction {
  // --- Property anchor (existing attribution/revision model, reused as-is) ---
  /** The property this auction is for. Immutable: an auction can never be re-pointed at a different property. */
  @Prop({ type: Types.ObjectId, ref: 'Property', required: true, immutable: true, index: true }) propertyId: Types.ObjectId;
  /**
   * The property's approved public revision at the moment the auction was
   * created. Frozen so a later property edit (a new revision) cannot
   * silently change what the auction is describing/selling; the auction
   * keeps describing exactly the property state that was live when it was
   * scheduled, even after the property itself moves on.
   */
  @Prop({ type: Types.ObjectId, ref: 'PropertyRevision', required: true, immutable: true }) propertyRevisionId: Types.ObjectId;

  // --- Advertiser / actor attribution (mirrors Property's attribution fields) ---
  /** The listing account the auction (and its eventual proceeds) belongs to. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true, index: true }) advertiserAccountId: Types.ObjectId;
  /** Snapshot of the advertiser's account type at creation time (USER/BROKER/COMPANY), immune to a later account-type change. */
  @Prop({ type: String, enum: AccountType, required: true, immutable: true }) advertiserAccountTypeSnapshot: AccountType;
  /** The operator who actually created the auction record (self-service today; distinct field so admin-assisted creation can be added later without a schema change). */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true }) createdByActorId: Types.ObjectId;

  // --- Money (EGP integer minor units only; reuses the shared money validator) ---
  @Prop({
    required: true,
    immutable: true,
    validate: { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }), message: 'startingPriceMinor is outside the safe integer range' },
  })
  startingPriceMinor: number;
  @Prop({
    required: true,
    immutable: true,
    validate: { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }), message: 'minimumBidStepMinor is outside the safe integer range' },
  })
  minimumBidStepMinor: number;
  @Prop({ type: String, required: true, enum: [EGP_CURRENCY], default: EGP_CURRENCY, immutable: true }) currency: typeof EGP_CURRENCY;

  // --- Authoritative scheduling ---
  /** The originally agreed start time. Immutable — this is one of the terms the auction was created under. */
  @Prop({ required: true, immutable: true, index: true }) scheduledStartAt: Date;
  /** The originally agreed end time (part of the frozen rule snapshot below). */
  @Prop({ required: true, immutable: true }) scheduledEndAt: Date;
  /**
   * The *live* authoritative end time. Starts equal to `scheduledEndAt`;
   * anti-sniping extension (MAZAD-024) is the only thing ever allowed to
   * move it forward, repeatedly, with no cap — deliberately mutable, unlike
   * every other timing field here.
   */
  @Prop({ required: true, index: true }) currentEndAt: Date;

  // --- Lifecycle ---
  @Prop({ type: String, required: true, enum: AuctionStatus, default: AuctionStatus.SCHEDULED, index: true }) status: AuctionStatus;

  // --- Immutable rule snapshot ---
  @Prop({ type: AuctionRuleSnapshotSchema, required: true, immutable: true }) ruleSnapshot: AuctionRuleSnapshot;

  // --- Entry fee (MAZAD-028) ---
  /** Bidder entry fee for this auction; absent until an admin configures it (the future Admin approval workflow supplies it via `AuctionEntryFeeService.configure`). Absent fails closed. */
  @Prop({ type: AuctionEntryFeeSchema }) entryFee?: AuctionEntryFee;

  // --- Bidding state (MAZAD-027) ---
  /**
   * Number of bids accepted so far. Mutable, and written ONLY by the atomic
   * bid-acceptance transaction (`$inc: 1`). It exists so acceptance can
   * *write* the Auction document first: a real data change on the aggregate
   * is what makes two concurrent acceptance transactions conflict (a no-op
   * update would not), and the post-increment value is cross-checked against
   * the ledger's next sequence. Absent on pre-existing documents, which read
   * as 0 (`$inc` treats a missing field as 0), so no migration is needed.
   */
  @Prop({ type: Number, default: 0, min: 0 }) acceptedBidCount: number;

  // --- Cancellation (schema only; the cancellation service itself is MAZAD-024+) ---
  @Prop({ type: Types.ObjectId, ref: 'User' }) cancelledByActorId?: Types.ObjectId;
  @Prop() cancelledAt?: Date;
  @Prop({ trim: true, maxlength: 1000 }) cancellationReason?: string;

  // --- Completion / winner (MAZAD-030) ---
  /**
   * Written exactly once, by `AuctionFinalizationService`, in ONE conditional
   * update `{status: ENDED_PENDING_CLOSE, winningBidId: {$exists: false}} ->
   * COMPLETED + these fields`. COMPLETED is terminal (no outgoing transition)
   * and every other Auction write is filtered on a non-terminal status, so a
   * finalized winner is never silently replaceable. `COMPLETED` means the
   * bidding lifecycle was finalized and the winning accepted bid determined —
   * NOT that payment or ownership transfer occurred (that is outside Mazad).
   * Never set for ENDED_NO_BIDS or CANCELLED; there is no second-place promotion.
   * Non-PII only: the winner is referenced by account id + the account-type
   * snapshot copied from the winning Bid; nothing from the profile is copied.
   */
  @Prop() completedAt?: Date;
  @Prop({ type: Types.ObjectId, ref: 'User' }) winnerAccountId?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Bid' }) winningBidId?: Types.ObjectId;
  @Prop({ type: Number, min: 1 }) winningBidSequence?: number;
  @Prop() winningBidAcceptedAt?: Date;
  @Prop({ type: String, enum: AccountType }) winnerAccountTypeSnapshot?: AccountType;
  @Prop({
    validate: { validator: (value: unknown) => value === undefined || isMoneyMinorAmount(value, { positive: true }), message: 'winningBidAmountMinor is outside the safe integer range' },
  })
  winningBidAmountMinor?: number;
}

export const AuctionSchema = SchemaFactory.createForClass(Auction);

AuctionSchema.index({ createdAt: -1 });
// Property's own auction history (e.g. "has this property been auctioned before?").
AuctionSchema.index({ propertyId: 1, createdAt: -1 }, { name: 'auction_property_history' });
// An advertiser's own auctions ("my auctions"), mirrors property_advertiser_created.
AuctionSchema.index({ advertiserAccountId: 1, createdAt: -1 }, { name: 'auction_advertiser_history' });
// Scheduling worker: "which SCHEDULED auctions are due to start?" (MAZAD-024+).
AuctionSchema.index({ status: 1, scheduledStartAt: 1 }, { name: 'auction_status_start_schedule' });
// Closing worker: "which ACTIVE auctions have reached their (possibly extended) end?" (MAZAD-024+).
AuctionSchema.index({ status: 1, currentEndAt: 1 }, { name: 'auction_status_end_schedule' });
// Public auction listing/discovery, newest first, filtered by status.
AuctionSchema.index({ status: 1, createdAt: -1 }, { name: 'auction_public_listing_newest' });
