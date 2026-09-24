import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BidErrorCode } from '../../common/errors/bid-error-codes';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../../common/money/money';
import { AccountType } from '../../users/identity.types';

export type BidDocument = HydratedDocument<Bid>;

/** Thrown when application code tries to alter or remove an accepted bid. */
export class BidLedgerImmutableError extends Error {
  readonly code = BidErrorCode.LEDGER_IMMUTABLE;
  constructor(operation: string) {
    super(`Bid ledger is append-only: ${operation} is not permitted`);
    this.name = 'BidLedgerImmutableError';
  }
}

/**
 * One accepted bid — a row in the append-only bid ledger (MAZAD-026).
 *
 * Only *accepted* bids are ever persisted: a bid that fails validation in
 * the (future, MAZAD-027) acceptance transaction is rejected before it
 * reaches this collection, so "a Bid document exists" already means "this
 * bid is valid and counts". There is deliberately no status, withdrawn or
 * deleted flag: bids cannot be withdrawn, edited or removed.
 *
 * Every field is `immutable`, and the schema-level guards below reject any
 * update/replace/delete/bulkWrite/save-of-existing issued through Mongoose.
 * That is application-layer enforcement, not a database guarantee:
 * direct driver access (maintenance scripts, migrations, a DBA) can still
 * modify the collection, which is why the ledger service exposes no write
 * path other than the future acceptance transaction.
 *
 * Nothing here is client-authoritative: bidder identity comes from the
 * verified token, `acceptedAt` from the server clock, `sequence` from the
 * ledger itself, and `amountMinor` is validated against the auction's rules
 * by the acceptance transaction before the insert.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'bids', versionKey: false })
export class Bid {
  /** The auction this bid belongs to. A bid can never be moved to another auction. */
  @Prop({ type: Types.ObjectId, ref: 'Auction', required: true, immutable: true }) auctionId: Types.ObjectId;

  /**
   * The bidding account, taken from the authenticated principal. Internal
   * only: public bid history must anonymise it (see `bid-projections.ts`);
   * the bidder themselves may be told which bids are theirs.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true }) bidderAccountId: Types.ObjectId;

  /** The bidder's account type at bid time (USER/BROKER/COMPANY), mirroring `Auction.advertiserAccountTypeSnapshot`. */
  @Prop({ type: String, enum: AccountType, required: true, immutable: true }) bidderAccountTypeSnapshot: AccountType;

  /**
   * Dense, 1-based, per-auction position in the ledger. Total order of an
   * auction's bids is `sequence` ascending — never client time, never
   * `acceptedAt` (equal timestamps are possible), never `_id`. Unique per
   * auction (see indexes). MAZAD-027 allocates it inside the acceptance
   * transaction; see `BidLedgerService.nextSequenceFor`.
   */
  @Prop({ type: Number, required: true, min: 1, immutable: true, validate: { validator: Number.isInteger, message: 'sequence must be an integer' } }) sequence: number;

  /** EGP integer minor units; same bounds as every other money field in the platform. */
  @Prop({
    type: Number,
    required: true,
    immutable: true,
    validate: { validator: (value: unknown) => isMoneyMinorAmount(value, { positive: true }), message: 'amountMinor is outside the safe integer range' },
  })
  amountMinor: number;

  @Prop({ type: String, required: true, enum: [EGP_CURRENCY], default: EGP_CURRENCY, immutable: true }) currency: typeof EGP_CURRENCY;

  /**
   * The server-authoritative instant the bid was accepted (the same clock
   * reading the acceptance transaction used to check `currentEndAt`).
   * Required and supplied by the server; no request field maps to it.
   */
  @Prop({ type: Date, required: true, immutable: true }) acceptedAt: Date;
}

export const BidSchema = SchemaFactory.createForClass(Bid);

// --- Immutability guards -----------------------------------------------------

const BLOCKED_QUERY_OPERATIONS = [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
] as const;

BidSchema.pre([...BLOCKED_QUERY_OPERATIONS], { document: false, query: true }, function () {
  throw new BidLedgerImmutableError('query update/delete');
});
BidSchema.pre('updateOne', { document: true, query: false }, function () {
  throw new BidLedgerImmutableError('document update');
});
BidSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new BidLedgerImmutableError('document delete');
});
BidSchema.pre('bulkWrite', function () {
  throw new BidLedgerImmutableError('bulkWrite');
});
BidSchema.pre('save', function () {
  if (!this.isNew) throw new BidLedgerImmutableError('saving an existing bid');
});

// --- Indexes (access patterns MAZAD-027+ will use; nothing speculative) --------

// Deterministic auction history, "latest bid" (reverse scan), auction existence, and the one-position-per-sequence guarantee.
BidSchema.index({ auctionId: 1, sequence: 1 }, { unique: true, name: 'bid_auction_sequence' });
// "My bids" across auctions, newest first.
BidSchema.index({ bidderAccountId: 1, createdAt: -1 }, { name: 'bid_bidder_history' });
// A bidder's bids on one auction (own-bid markers, per-bidder checks).
BidSchema.index({ auctionId: 1, bidderAccountId: 1, sequence: -1 }, { name: 'bid_auction_bidder' });
