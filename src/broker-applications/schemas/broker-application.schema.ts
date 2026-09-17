import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BrokerApplicationStatus } from '../broker.types';

export type BrokerApplicationDocument = HydratedDocument<BrokerApplication>;

@Schema({
  timestamps: true,
  collection: 'broker_applications',
  optimisticConcurrency: true,
})
export class BrokerApplication {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true })
  applicantAccountId: Types.ObjectId;

  @Prop({ required: true, min: 1, immutable: true })
  applicationVersion: number;

  @Prop({
    required: true,
    enum: BrokerApplicationStatus,
    default: BrokerApplicationStatus.PENDING,
  })
  status: BrokerApplicationStatus;

  @Prop({ type: [Types.ObjectId], ref: 'BrokerVerificationDocument', immutable: true })
  documentIds: Types.ObjectId[];

  @Prop({ required: true, immutable: true })
  submittedAt: Date;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true })
  submittedByActorId: Types.ObjectId;

  @Prop({ required: true, immutable: true, maxlength: 64 })
  idempotencyKeyHash: string;

  @Prop()
  reviewedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  reviewedByActorId?: Types.ObjectId;

  @Prop({ trim: true, maxlength: 500 })
  reviewReason?: string;

  @Prop({ required: true, default: 0, min: 0 })
  version: number;
}

export const BrokerApplicationSchema = SchemaFactory.createForClass(BrokerApplication);

BrokerApplicationSchema.index(
  { applicantAccountId: 1, applicationVersion: 1 },
  { unique: true, name: 'broker_application_version_unique' },
);
BrokerApplicationSchema.index(
  { applicantAccountId: 1, idempotencyKeyHash: 1 },
  { unique: true, name: 'broker_application_idempotency_unique' },
);
BrokerApplicationSchema.index(
  { applicantAccountId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: BrokerApplicationStatus.PENDING },
    name: 'broker_application_pending_unique',
  },
);
BrokerApplicationSchema.index(
  { status: 1, submittedAt: 1, _id: 1 },
  { name: 'broker_application_review_queue' },
);
