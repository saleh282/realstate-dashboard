import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { AssetClassification, EvidenceDeliveryType, EvidenceResourceType } from '../evidence-asset.types';

export type EvidenceCleanupTaskDocument = HydratedDocument<EvidenceCleanupTask>;

@Schema({ timestamps: true, collection: 'evidence_cleanup_tasks' })
export class EvidenceCleanupTask {
  @Prop({ required: true, unique: true, index: true }) publicId: string;
  @Prop({ required: true, enum: ['image', 'raw'] }) resourceType: EvidenceResourceType;
  @Prop({ required: true, enum: ['authenticated', 'upload'] }) deliveryType: EvidenceDeliveryType;
  @Prop({ required: true, enum: AssetClassification }) classification: AssetClassification;
  @Prop({ required: true, enum: ['pending', 'completed'], default: 'pending', index: true }) status: 'pending' | 'completed';
  @Prop({ required: true, maxlength: 100 }) reason: string;
  @Prop({ default: 0, min: 0 }) attempts: number;
  @Prop({ maxlength: 500 }) lastError?: string;
  @Prop() completedAt?: Date;
  // Lease while a worker holds the task, then the earliest retry time after a failure.
  @Prop() nextAttemptAt?: Date;
}

export const EvidenceCleanupTaskSchema = SchemaFactory.createForClass(EvidenceCleanupTask);
EvidenceCleanupTaskSchema.index({ status: 1, createdAt: 1 });
