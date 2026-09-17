import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BrokerVerificationRequirementDocument =
  HydratedDocument<BrokerVerificationRequirement>;

@Schema({
  timestamps: true,
  collection: 'broker_verification_requirements',
  optimisticConcurrency: true,
})
export class BrokerVerificationRequirement {
  @Prop({ required: true, trim: true, uppercase: true, maxlength: 80 })
  code: string;

  @Prop({ required: true, trim: true, maxlength: 200 })
  labelAr: string;

  @Prop({ trim: true, maxlength: 200 })
  labelEn?: string;

  @Prop({ required: true, default: true })
  required: boolean;

  @Prop({ required: true, default: true })
  isActive: boolean;

  @Prop({ required: true, default: 0, min: 0, max: 10000 })
  sortOrder: number;

  @Prop({ required: true, default: 0, min: 0 })
  version: number;

  @Prop()
  archivedAt?: Date;
}

export const BrokerVerificationRequirementSchema =
  SchemaFactory.createForClass(BrokerVerificationRequirement);

BrokerVerificationRequirementSchema.index(
  { code: 1 },
  { unique: true, name: 'broker_requirement_code_unique' },
);
BrokerVerificationRequirementSchema.index(
  { isActive: 1, sortOrder: 1, code: 1 },
  { name: 'broker_requirement_active_order' },
);
