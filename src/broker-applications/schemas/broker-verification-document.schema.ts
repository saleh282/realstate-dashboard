import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { StoredAssetMetadata } from '../../config/evidence-asset.types';

export type BrokerVerificationDocumentDocument =
  HydratedDocument<BrokerVerificationDocument>;

@Schema({ timestamps: true, collection: 'broker_verification_documents' })
export class BrokerVerificationDocument {
  @Prop({ type: Types.ObjectId, ref: 'BrokerApplication', required: true, immutable: true })
  applicationId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true, immutable: true })
  applicantAccountId: Types.ObjectId;

  @Prop({ required: true, uppercase: true, maxlength: 80, immutable: true })
  requirementCode: string;

  @Prop({ required: true, min: 0, immutable: true })
  requirementVersion: number;

  @Prop({ required: true, maxlength: 200, immutable: true })
  requirementLabelAr: string;

  @Prop({ maxlength: 200, immutable: true })
  requirementLabelEn?: string;

  @Prop({ type: Object, required: true, immutable: true })
  assetRef: StoredAssetMetadata;

  @Prop({ required: true, immutable: true })
  submittedAt: Date;
}

export const BrokerVerificationDocumentSchema =
  SchemaFactory.createForClass(BrokerVerificationDocument);

BrokerVerificationDocumentSchema.index(
  { applicationId: 1, requirementCode: 1 },
  { unique: true, name: 'broker_document_application_requirement_unique' },
);
BrokerVerificationDocumentSchema.index(
  { applicantAccountId: 1, submittedAt: -1 },
  { name: 'broker_document_applicant_history' },
);
