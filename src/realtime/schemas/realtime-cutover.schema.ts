import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * The persistent activation cutover of the `realtime` outbox consumer (MAZAD-032 closure). ONE document per consumer,
 * keyed by the consumer's permanent name, written exactly once and never updated.
 *
 * `marks` is the cutover itself: for every auction that had committed outbox events when realtime was first activated,
 * the highest `aggregateVersion` that was COMMITTED at that moment — read from the outbox, never from a clock. An event
 * `(auctionId, version)` is history iff `version <= marks[auctionId]`; anything else (a higher version, an auction with no
 * mark) was committed after and is delivered. No timestamp is stored or consulted.
 *
 * It lives in its own collection and is NOT part of any outbox event: the outbox and its `delivery.<consumer>` state
 * machine are untouched by it. The fields are immutable by convention (only ever `$setOnInsert`), not by a schema flag,
 * because Mongoose's `immutable` interferes with upserts. `minimize: false` keeps an EMPTY `marks` object (a database
 * with no history at first activation) instead of silently dropping the field.
 */
@Schema({ collection: 'realtime_cutovers', versionKey: false, timestamps: false, minimize: false })
export class RealtimeCutover {
  /** The consumer's permanent name (`realtime`). */
  @Prop({ type: String, required: true }) _id: string;
  /** `auctionId → highest committed aggregateVersion at activation`. Keys are 24-hex ids; values are integers ≥ 1. */
  @Prop({ type: Object }) marks: Record<string, number>;
  /** `Object.keys(marks).length`, stored so a truncated or hand-edited record is detected rather than trusted. */
  @Prop({ type: Number, required: true, min: 0 }) aggregateCount: number;
  /** Opaque id of the process that established it (`pid-random`): diagnostics only, no host name. */
  @Prop({ type: String, required: true }) establishedBy: string;
}

export const RealtimeCutoverSchema = SchemaFactory.createForClass(RealtimeCutover);
