'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { AssetClassification } = require('../config/evidence-asset.types');
class EvidenceCleanupTask {}
const EvidenceCleanupTaskSchema = new mongooseSchema(
  {
    publicId: { type: String, ...{ required: true, unique: true, index: true } },
    resourceType: { type: String, ...{ required: true, enum: ['image', 'raw'] } },
    deliveryType: { type: String, ...{ required: true, enum: ['authenticated', 'upload'] } },
    classification: { type: String, ...{ required: true, enum: AssetClassification } },
    status: {
      type: String,
      ...{ required: true, enum: ['pending', 'completed'], default: 'pending', index: true },
    },
    reason: { type: String, ...{ required: true, maxlength: 100 } },
    attempts: { type: Number, ...{ default: 0, min: 0 } },
    lastError: { type: String, ...{ maxlength: 500 } },
    completedAt: { type: Date, ...{} },
    nextAttemptAt: { type: Date, ...{} },
  },
  { timestamps: true, collection: 'evidence_cleanup_tasks' },
);
EvidenceCleanupTaskSchema.index({ status: 1, createdAt: 1 });

Object.assign(exports, { EvidenceCleanupTask, EvidenceCleanupTaskSchema });
