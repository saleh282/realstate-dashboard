'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
const {
  LEGAL_DOCUMENTS_COLLECTION,
  LegalDocumentStatus,
  LegalDocumentType,
} = require('../domain/legal-documents/legal-document.types');
class LegalDocumentSection {}
const LegalDocumentSectionSchema = new mongooseSchema(
  {
    headingAr: { type: String, ...{ required: true, trim: true, maxlength: 200 } },
    headingEn: { type: String, ...{ required: true, trim: true, maxlength: 200 } },
    bodyAr: { type: String, ...{ required: true, trim: true, maxlength: 10000 } },
    bodyEn: { type: String, ...{ required: true, trim: true, maxlength: 10000 } },
  },
  { _id: false },
);
class LegalDocument {}
const LegalDocumentSchema = new mongooseSchema(
  {
    type: { type: String, ...{ required: true, enum: LegalDocumentType } },
    version: { type: Number, ...{ required: true, min: 1 } },
    status: {
      type: String,
      ...{ required: true, enum: LegalDocumentStatus, default: LegalDocumentStatus.DRAFT },
    },
    titleAr: { type: String, ...{ required: true, trim: true, maxlength: 200 } },
    titleEn: { type: String, ...{ required: true, trim: true, maxlength: 200 } },
    sections: { type: [LegalDocumentSectionSchema], default: [] },
    changeSummary: { type: String, ...{ trim: true, maxlength: 500 } },
    publishedAt: { type: Date, ...{} },
    publishedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    createdBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    updatedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
  },
  { timestamps: true, collection: LEGAL_DOCUMENTS_COLLECTION },
);
LegalDocumentSchema.index(
  { type: 1, version: 1 },
  { unique: true, name: 'legal_document_type_version_unique' },
);
LegalDocumentSchema.index(
  { type: 1, status: 1, version: -1 },
  { name: 'legal_document_current_lookup' },
);

Object.assign(exports, { LegalDocumentSection, LegalDocument, LegalDocumentSchema });
