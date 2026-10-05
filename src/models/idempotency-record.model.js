'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
class IdempotencyRecord {}
const IdempotencyRecordSchema = new mongooseSchema(
  {
    scope: { type: String, ...{ required: true } },
    accountId: { required: true, type: mongooseSchema.Types.Mixed },
    keyHash: { type: String, ...{ required: true } },
    fingerprint: { type: String, ...{ required: true } },
    status: { type: String, ...{ required: true, enum: ['in_progress', 'completed'] } },
    response: { type: Object },
    leaseExpiresAt: { type: Date, ...{ required: true } },
    expiresAt: { type: Date, ...{ required: true } },
  },
  { timestamps: true, collection: 'idempotency_records' },
);
IdempotencyRecordSchema.index(
  { accountId: 1, scope: 1, keyHash: 1 },
  { unique: true, name: 'idempotency_account_scope_key_unique' },
);
IdempotencyRecordSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'idempotency_expiry_ttl' },
);

Object.assign(exports, { IdempotencyRecord, IdempotencyRecordSchema });
