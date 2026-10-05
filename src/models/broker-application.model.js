'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
const { BrokerApplicationStatus } = require('../domain/broker-applications/broker.types');
class BrokerApplication {}
const BrokerApplicationSchema = new mongooseSchema(
  {
    applicantAccountId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'User',
      required: true,
      immutable: true,
    },
    applicationVersion: { type: Number, ...{ required: true, min: 1, immutable: true } },
    status: {
      type: String,
      ...{
        required: true,
        enum: BrokerApplicationStatus,
        default: BrokerApplicationStatus.PENDING,
      },
    },
    documentIds: {
      type: [mongooseSchema.Types.Mixed],
      ref: 'BrokerVerificationDocument',
      immutable: true,
    },
    submittedAt: { type: Date, ...{ required: true, immutable: true } },
    submittedByActorId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'User',
      required: true,
      immutable: true,
    },
    idempotencyKeyHash: { type: String, ...{ required: true, immutable: true, maxlength: 64 } },
    reviewedAt: { type: Date, ...{} },
    reviewedByActorId: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    reviewReason: { type: String, ...{ trim: true, maxlength: 500 } },
    version: { type: Number, ...{ required: true, default: 0, min: 0 } },
  },
  {
    timestamps: true,
    collection: 'broker_applications',
    optimisticConcurrency: true,
  },
);
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

Object.assign(exports, { BrokerApplication, BrokerApplicationSchema });
