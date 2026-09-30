import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../../common/money/money';
import { AccountType } from '../../users/identity.types';
import { AUCTION_NOTE_MAX_LENGTH, AuctionRequestHistoryAction, AuctionRequestStatus } from '../auction-request.types';

export type AuctionRequestDocument = HydratedDocument<AuctionRequest>;

/** Unique while a request is live on a property (see `liveKey`); the single race-safe origination guard. */
export const AUCTION_REQUEST_LIVE_PROPERTY_INDEX = 'auction_request_live_property';

const positiveMoney = { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }), message: 'amount is outside the safe integer range' };

/** The seller-proposed terms. Editable only through `AuctionRequestsService` while the request allows it. */
@Schema({ _id: false })
export class AuctionRequestTermsRecord {
  @Prop({ type: Number, required: true, validate: positiveMoney }) startingPriceMinor: number;
  @Prop({ type: Number, required: true, validate: positiveMoney }) minimumBidStepMinor: number;
  @Prop({ type: String, required: true, enum: [EGP_CURRENCY], default: EGP_CURRENCY }) currency: typeof EGP_CURRENCY;
  @Prop({ type: Date, required: true }) proposedStartAt: Date;
  @Prop({ type: Date, required: true }) proposedEndAt: Date;
}

const AuctionRequestTermsSchema = SchemaFactory.createForClass(AuctionRequestTermsRecord);

/**
 * One append-only history entry. Review entries carry the exact terms and
 * property revision the decision was made against, so every proposal and
 * every decision stays auditable after later edits. `internalNote` is
 * Admin-only and never leaves the Admin projection.
 */
@Schema({ _id: false })
export class AuctionRequestHistoryEntry {
  @Prop({ type: String, required: true, enum: AuctionRequestHistoryAction }) action: AuctionRequestHistoryAction;
  @Prop({ type: Date, required: true }) at: Date;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) actorId: Types.ObjectId;
  /** The request revision this entry produced. */
  @Prop({ type: Number, required: true, min: 1 }) revision: number;
  @Prop({ type: AuctionRequestTermsSchema, required: true }) terms: AuctionRequestTermsRecord;
  @Prop({ type: Types.ObjectId, ref: 'PropertyRevision', required: true }) propertyRevisionId: Types.ObjectId;
  // --- review decisions ---
  @Prop({ type: Number, validate: { validator: (value: unknown) => value === undefined || value === null || isMoneyMinorAmount(value), message: 'entryFeeMinor is outside the safe integer range' } }) entryFeeMinor?: number;
  @Prop({ type: Types.ObjectId, ref: 'Auction' }) auctionId?: Types.ObjectId;
  @Prop({ type: String, maxlength: 64 }) reasonCode?: string;
  /** Seller-visible explanation (rejections). */
  @Prop({ type: String, trim: true, maxlength: AUCTION_NOTE_MAX_LENGTH }) sellerNote?: string;
  /** Admin-only note; never projected to the seller. */
  @Prop({ type: String, trim: true, maxlength: AUCTION_NOTE_MAX_LENGTH }) internalNote?: string;
}

const AuctionRequestHistoryEntrySchema = SchemaFactory.createForClass(AuctionRequestHistoryEntry);

/**
 * MAZAD-035 AuctionRequest aggregate (collection `auction_requests`). See
 * `auction-request.types.ts` for the state machine. The real `Auction` is
 * created only by approval, with the approved terms and the explicit entry fee
 * (including 0 = FREE), linked back through `Auction.originRequestId`.
 *
 * CONCURRENCY. `revision` is the optimistic-concurrency token: every write is
 * a conditional update on `{status, revision}` that increments it, and every
 * seller/Admin command must send `expectedRevision` (Mongoose's own
 * versionKey is disabled: it is not bumped by `findOneAndUpdate`).
 *
 * ONE LIVE ORIGINATION PER PROPERTY. `liveKey` holds the property id while
 * the request is live (pending review, rejected, or approved — the latter
 * until its auction is no longer scheduled/active) and is removed on
 * withdrawal. A partial unique index over it makes two live requests for one
 * property impossible even under concurrency; a new submission lazily
 * releases the key of an approved request whose auction has already ended or
 * been cancelled, inside its own transaction.
 */
@Schema({ timestamps: true, collection: 'auction_requests', versionKey: false })
export class AuctionRequest {
  @Prop({ type: Types.ObjectId, ref: 'Property', required: true, immutable: true }) propertyId: Types.ObjectId;
  /** The property's public revision the current terms are anchored to (re-anchored on every seller edit/resubmission). */
  @Prop({ type: Types.ObjectId, ref: 'PropertyRevision', required: true }) propertyRevisionId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true }) advertiserAccountId: Types.ObjectId;
  @Prop({ type: String, enum: AccountType, required: true }) advertiserAccountTypeSnapshot: AccountType;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true }) createdByActorId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: AuctionRequestStatus }) status: AuctionRequestStatus;
  @Prop({ type: AuctionRequestTermsSchema, required: true }) terms: AuctionRequestTermsRecord;
  @Prop({ type: Number, required: true, min: 1 }) revision: number;
  @Prop({ type: Types.ObjectId }) liveKey?: Types.ObjectId;

  /** When the current review round started (submission, resubmission, or reopening after an approved edit). Orders the review queue. */
  @Prop({ type: Date, required: true }) submittedAt: Date;
  @Prop({ type: [AuctionRequestHistoryEntrySchema], default: [] }) history: AuctionRequestHistoryEntry[];

  /** The auction created by the latest approval (absent while pending/rejected/withdrawn, or after that auction was superseded). */
  @Prop({ type: Types.ObjectId, ref: 'Auction' }) auctionId?: Types.ObjectId;
  /** Auctions this request produced that were cancelled because the seller revised the approved terms before start. */
  @Prop({ type: [Types.ObjectId], default: [] }) supersededAuctionIds: Types.ObjectId[];
  @Prop({ type: Date }) withdrawnAt?: Date;
}

export const AuctionRequestSchema = SchemaFactory.createForClass(AuctionRequest);

export const AUCTION_REQUEST_INDEXES = [
  { key: { liveKey: 1 }, options: { unique: true, partialFilterExpression: { liveKey: { $exists: true } }, name: AUCTION_REQUEST_LIVE_PROPERTY_INDEX } },
  { key: { status: 1, submittedAt: 1, _id: 1 }, options: { name: 'auction_request_review_queue' } },
  { key: { advertiserAccountId: 1, createdAt: -1 }, options: { name: 'auction_request_advertiser_history' } },
  { key: { propertyId: 1, createdAt: -1 }, options: { name: 'auction_request_property_history' } },
  { key: { auctionId: 1 }, options: { partialFilterExpression: { auctionId: { $exists: true } }, name: 'auction_request_auction' } },
] as const;

for (const index of AUCTION_REQUEST_INDEXES) AuctionRequestSchema.index(index.key as any, index.options as any);
