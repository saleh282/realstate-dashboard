import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  LEGAL_DOCUMENTS_COLLECTION,
  LegalDocumentStatus,
  LegalDocumentType,
} from '../legal-document.types';

export type LegalDocumentDocument = LegalDocument & Document;

@Schema({ _id: false })
export class LegalDocumentSection {
  @Prop({ required: true, trim: true, maxlength: 200 })
  headingAr: string;

  @Prop({ required: true, trim: true, maxlength: 200 })
  headingEn: string;

  @Prop({ required: true, trim: true, maxlength: 10000 })
  bodyAr: string;

  @Prop({ required: true, trim: true, maxlength: 10000 })
  bodyEn: string;
}

const LegalDocumentSectionSchema = SchemaFactory.createForClass(LegalDocumentSection);

@Schema({ timestamps: true, collection: LEGAL_DOCUMENTS_COLLECTION })
export class LegalDocument {
  @Prop({ required: true, enum: LegalDocumentType })
  type: LegalDocumentType;

  // Increases per type. A published version is immutable: every change is a
  // new version, so the text a user accepted stays retrievable.
  @Prop({ required: true, min: 1 })
  version: number;

  @Prop({ required: true, enum: LegalDocumentStatus, default: LegalDocumentStatus.DRAFT })
  status: LegalDocumentStatus;

  @Prop({ required: true, trim: true, maxlength: 200 })
  titleAr: string;

  @Prop({ required: true, trim: true, maxlength: 200 })
  titleEn: string;

  @Prop({ type: [LegalDocumentSectionSchema], default: [] })
  sections: LegalDocumentSection[];

  @Prop({ trim: true, maxlength: 500 })
  changeSummary?: string;

  @Prop()
  publishedAt?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  publishedBy?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId;
}

export const LegalDocumentSchema = SchemaFactory.createForClass(LegalDocument);
LegalDocumentSchema.index({ type: 1, version: 1 }, { unique: true, name: 'legal_document_type_version_unique' });
LegalDocumentSchema.index({ type: 1, status: 1, version: -1 }, { name: 'legal_document_current_lookup' });
