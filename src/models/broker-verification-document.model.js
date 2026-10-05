'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
class BrokerVerificationDocument {}
const BrokerVerificationDocumentSchema = new mongooseSchema(
  {
    applicationId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'BrokerApplication',
      required: true,
      immutable: true,
    },
    applicantAccountId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'User',
      required: true,
      immutable: true,
    },
    assetRef: { type: Object, required: true, immutable: true },
    submittedAt: { type: Date, ...{ required: true, immutable: true } },
  },
  { timestamps: true, collection: 'broker_verification_documents' },
);
BrokerVerificationDocumentSchema.index(
  { applicationId: 1, requirementCode: 1 },
  { unique: true, name: 'broker_document_application_requirement_unique' },
);
BrokerVerificationDocumentSchema.index(
  { applicantAccountId: 1, submittedAt: -1 },
  { name: 'broker_document_applicant_history' },
);

Object.assign(exports, { BrokerVerificationDocument, BrokerVerificationDocumentSchema });
