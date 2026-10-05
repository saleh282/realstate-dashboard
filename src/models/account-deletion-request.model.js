'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
const { AccountDeletionState } = require('../domain/account-deletion/account-deletion.types');
class DeletionBlockerSnapshot {}
const DeletionBlockerSnapshotSchema = new mongooseSchema(
  {
    code: { type: String, ...{ required: true, maxlength: 100 } },
    category: { type: String, ...{ required: true, enum: ['COMMERCIAL', 'LEGAL', 'RESOURCE'] } },
    count: { type: Number, ...{ min: 0 } },
  },
  { _id: false },
);
class AccountDeletionRequest {}
const AccountDeletionRequestSchema = new mongooseSchema(
  {
    userId: { type: mongooseSchema.Types.Mixed, ref: 'User', required: true, index: true },
    workflowVersion: { type: Number, ...{ required: true, min: 1 } },
    state: { type: String, ...{ required: true, enum: AccountDeletionState, index: true } },
    requestedAt: { type: Date, ...{ required: true } },
    recoverableUntil: { type: Date, ...{ required: true, index: true } },
    source: { type: String, ...{ enum: ['SELF', 'ADMIN'], required: true } },
    requestedByActorId: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    reason: { type: String, ...{ maxlength: 500 } },
    blockers: { type: [DeletionBlockerSnapshotSchema], default: [] },
    legalHold: { type: Boolean, ...{ default: false, index: true } },
    legalHoldReason: { type: String, ...{ maxlength: 500, select: false } },
    legalHoldPlacedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    legalHoldPlacedAt: { type: Date, ...{} },
    legalHoldRemovedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    legalHoldRemovedAt: { type: Date, ...{} },
    legalHoldRemovalReason: { type: String, ...{ maxlength: 500, select: false } },
    restoredAt: { type: Date, ...{} },
    restoredByActorId: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    anonymizationStartedAt: { type: Date, ...{} },
    anonymizedAt: { type: Date, ...{} },
    failureCode: { type: String, ...{ maxlength: 100 } },
    lastAttemptAt: { type: Date, ...{} },
    evidenceRetentionState: {
      type: String,
      ...{ required: true, enum: ['RETAIN_PENDING_POLICY'], default: 'RETAIN_PENDING_POLICY' },
    },
    finalPurgeEligible: { type: Boolean, ...{ default: false } },
  },
  { timestamps: true, collection: 'account_deletion_requests', versionKey: 'version' },
);
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

Object.assign(exports, {
  DeletionBlockerSnapshot,
  AccountDeletionRequest,
  AccountDeletionRequestSchema,
});
