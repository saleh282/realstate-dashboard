import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { AccountDeletionState } from '../account-deletion.types';

export type AccountDeletionRequestDocument = HydratedDocument<AccountDeletionRequest>;

@Schema({ _id: false })
export class DeletionBlockerSnapshot {
  @Prop({ required: true, maxlength: 100 }) code: string;
  @Prop({ required: true, enum: ['COMMERCIAL', 'LEGAL', 'RESOURCE'] }) category: string;
  @Prop({ min: 0 }) count?: number;
}
const DeletionBlockerSnapshotSchema = SchemaFactory.createForClass(DeletionBlockerSnapshot);

@Schema({ timestamps: true, collection: 'account_deletion_requests', versionKey: 'version' })
export class AccountDeletionRequest {
  version?: number;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true }) userId: Types.ObjectId;
  @Prop({ required: true, min: 1 }) workflowVersion: number;
  @Prop({ required: true, enum: AccountDeletionState, index: true }) state: AccountDeletionState;
  @Prop({ required: true }) requestedAt: Date;
  @Prop({ required: true, index: true }) recoverableUntil: Date;
  @Prop({ enum: ['SELF', 'ADMIN'], required: true }) source: 'SELF' | 'ADMIN';
  @Prop({ type: Types.ObjectId, ref: 'User' }) requestedByActorId?: Types.ObjectId;
  @Prop({ maxlength: 500 }) reason?: string;
  @Prop({ type: [DeletionBlockerSnapshotSchema], default: [] }) blockers: DeletionBlockerSnapshot[];
  @Prop({ default: false, index: true }) legalHold: boolean;
  @Prop({ maxlength: 500, select: false }) legalHoldReason?: string;
  @Prop({ type: Types.ObjectId, ref: 'User' }) legalHoldPlacedBy?: Types.ObjectId;
  @Prop() legalHoldPlacedAt?: Date;
  @Prop({ type: Types.ObjectId, ref: 'User' }) legalHoldRemovedBy?: Types.ObjectId;
  @Prop() legalHoldRemovedAt?: Date;
  @Prop({ maxlength: 500, select: false }) legalHoldRemovalReason?: string;
  @Prop() restoredAt?: Date;
  @Prop({ type: Types.ObjectId, ref: 'User' }) restoredByActorId?: Types.ObjectId;
  @Prop() anonymizationStartedAt?: Date;
  @Prop() anonymizedAt?: Date;
  @Prop({ maxlength: 100 }) failureCode?: string;
  @Prop() lastAttemptAt?: Date;
  @Prop({ required: true, enum: ['RETAIN_PENDING_POLICY'], default: 'RETAIN_PENDING_POLICY' })
  evidenceRetentionState: 'RETAIN_PENDING_POLICY';
  @Prop({ default: false }) finalPurgeEligible: boolean;
}

export const AccountDeletionRequestSchema = SchemaFactory.createForClass(AccountDeletionRequest);
AccountDeletionRequestSchema.index(
  { userId: 1, workflowVersion: 1 },
  { unique: true, name: 'account_deletion_user_version_unique' },
);
AccountDeletionRequestSchema.index(
  { userId: 1, state: 1 },
  {
    unique: true,
    partialFilterExpression: { state: { $in: ['PENDING', 'ANONYMIZING'] } },
    name: 'account_deletion_active_unique',
  },
);
AccountDeletionRequestSchema.index(
  { state: 1, recoverableUntil: 1, legalHold: 1 },
  { name: 'account_deletion_processing_queue' },
);
