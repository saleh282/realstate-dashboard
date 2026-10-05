'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
const { EGP_CURRENCY, isMoneyMinorAmount } = require('../common/money/money');
const {
  EntryPaymentStatus,
  PaymentPurpose,
  PaymentReconciliationFlag,
} = require('../domain/payments/payment.types');
/** Managed-marketing payment attempts retain the server-owned package price snapshot and payment history. */
class ManagedMarketingPayment {}
const ManagedMarketingPaymentSchema = new mongooseSchema(
  {
    purpose: {
      type: String,
      enum: [PaymentPurpose.MANAGED_MARKETING],
      default: PaymentPurpose.MANAGED_MARKETING,
      required: true,
      immutable: true,
    },
    requestId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'ManagedMarketingRequest',
      required: true,
      immutable: true,
    },
    advertiserAccountId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'User',
      required: true,
      immutable: true,
    },
    amountMinor: {
      type: Number,
      required: true,
      immutable: true,
      validate: {
        validator: (value) => isMoneyMinorAmount(value, { positive: true }),
        message: 'amountMinor is outside the safe integer range',
      },
    },
    currency: { type: String, required: true, enum: [EGP_CURRENCY], immutable: true },
    status: {
      type: String,
      required: true,
      enum: EntryPaymentStatus,
      default: EntryPaymentStatus.INITIATED,
    },
    isLive: { type: Boolean },
    initiatedAt: { type: Date, required: true, immutable: true },
    confirmedAt: { type: Date },
    failedAt: { type: Date },
    failureCode: { type: String, maxlength: 100 },
    provider: { type: String, required: true, maxlength: 50, immutable: true },
    providerReference: { type: String, maxlength: 200 },
    providerEventId: { type: String, maxlength: 200 },
    reconciliationFlag: { type: String, enum: PaymentReconciliationFlag },
    lastVerifiedAt: { type: Date },
    expiredAt: { type: Date },
    clientHandoff: { type: String, maxlength: 2000 },
    nextVerifyAt: { type: Date },
    verifyAttempts: { type: Number, default: 0, min: 0 },
    initiationClaimedAt: { type: Date },
  },
  { timestamps: true, collection: 'managed_marketing_payments', versionKey: false },
);
ManagedMarketingPaymentSchema.index(
  { requestId: 1 },
  {
    unique: true,
    partialFilterExpression: { isLive: true },
    name: 'mm_payment_one_live_per_request',
  },
);
ManagedMarketingPaymentSchema.index(
  { provider: 1, providerReference: 1 },
  {
    unique: true,
    partialFilterExpression: { providerReference: { $type: 'string' } },
    name: 'mm_payment_provider_reference',
  },
);
ManagedMarketingPaymentSchema.index(
  { status: 1, initiatedAt: 1 },
  { name: 'mm_payment_status_initiated' },
);
ManagedMarketingPaymentSchema.index(
  { advertiserAccountId: 1, createdAt: -1 },
  { name: 'mm_payment_advertiser_history' },
);
// MAZAD-028 reconciliation worker: due INITIATED attempts, oldest first.
ManagedMarketingPaymentSchema.index(
  { status: 1, nextVerifyAt: 1 },
  { name: 'mm_payment_status_next_verify' },
);
ManagedMarketingPaymentSchema.index(
  { reconciliationFlag: 1 },
  {
    partialFilterExpression: { reconciliationFlag: { $exists: true } },
    name: 'mm_payment_reconciliation_flag',
  },
);

Object.assign(exports, { ManagedMarketingPayment, ManagedMarketingPaymentSchema });
