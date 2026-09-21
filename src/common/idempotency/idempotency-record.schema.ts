import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type IdempotencyRecordDocument = HydratedDocument<IdempotencyRecord>;

@Schema({ timestamps: true, collection: 'idempotency_records' })
export class IdempotencyRecord {
  @Prop({ required: true }) scope: string;
  @Prop({ required: true, type: Types.ObjectId }) accountId: Types.ObjectId;
  // Only a hash of the client key is stored.
  @Prop({ required: true }) keyHash: string;
  // Digest of the request content: the same key with different content is rejected.
  @Prop({ required: true }) fingerprint: string;
  @Prop({ required: true, enum: ['in_progress', 'completed'] }) status: 'in_progress' | 'completed';
  @Prop({ type: Object }) response?: unknown;
  // While in progress, the moment another request may take the work over
  // (the first one presumably crashed).
  @Prop({ required: true }) leaseExpiresAt: Date;
  @Prop({ required: true }) expiresAt: Date;
}

export const IdempotencyRecordSchema = SchemaFactory.createForClass(IdempotencyRecord);
IdempotencyRecordSchema.index(
  { accountId: 1, scope: 1, keyHash: 1 },
  { unique: true, name: 'idempotency_account_scope_key_unique' },
);
IdempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'idempotency_expiry_ttl' });
