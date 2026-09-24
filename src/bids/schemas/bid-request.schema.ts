import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type BidRequestDocument = HydratedDocument<BidRequest>;

/**
 * The durable record of one logical bid request (MAZAD-029 idempotency).
 *
 * It is inserted INSIDE the MAZAD-027 acceptance transaction, in the same
 * commit as the immutable `Bid` it produced — so "the Bid committed" and "the
 * request is recorded" are one atomic fact. There is no "in progress" state
 * and nothing to expire: a request row exists exactly when its Bid exists,
 * which is what lets a retry after a lost HTTP response replay the original
 * result instead of placing a second bid. Business rejections are never
 * recorded (their transaction aborts), so a rejected request can be retried
 * and re-decided against fresh state.
 *
 * Kept separate from the immutable `Bid` ledger on purpose: the ledger stays
 * free of HTTP/client concerns. Rows are never updated or deleted by the
 * application. Only a SHA-256 of the client key is stored. No TTL: expiring a
 * row would let an old retry create a second bid, so retention follows the
 * bid ledger's (an explicit policy follow-up).
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'bid_requests', versionKey: false })
export class BidRequest {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true }) bidderAccountId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'Auction', required: true, immutable: true }) auctionId: Types.ObjectId;
  /** SHA-256 of the client's Idempotency-Key. */
  @Prop({ type: String, required: true, immutable: true }) keyHash: string;
  /** SHA-256 over the canonical request content (the amount). Same key + different fingerprint = conflict. */
  @Prop({ type: String, required: true, immutable: true }) fingerprint: string;
  @Prop({ type: Types.ObjectId, ref: 'Bid', required: true, immutable: true }) bidId: Types.ObjectId;
  /** The authoritative acceptance result exactly as first produced; replays return it verbatim. */
  @Prop({ type: Object, required: true, immutable: true }) result: Record<string, unknown>;
}

export const BidRequestSchema = SchemaFactory.createForClass(BidRequest);

// Scope: actor + auction + key. Different actors or auctions never collide.
BidRequestSchema.index({ bidderAccountId: 1, auctionId: 1, keyHash: 1 }, { unique: true, name: 'bid_request_actor_auction_key' });
// One request record per bid.
BidRequestSchema.index({ bidId: 1 }, { unique: true, name: 'bid_request_bid' });
