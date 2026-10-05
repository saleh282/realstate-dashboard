'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
const { EGP_CURRENCY, isMoneyMinorAmount } = require('../common/money/money');
const {
  ManagedMarketingPaymentStatus,
  ManagedMarketingRequestStatus,
} = require('../domain/managed-marketing/managed-marketing.types');
class ManagedMarketingPackageSnapshot {}
const ManagedMarketingPackageSnapshotSchema = new mongooseSchema(
  {
    packageId: { type: mongooseSchema.Types.Mixed, required: true, immutable: true },
    packageVersion: { type: Number, ...{ required: true, immutable: true } },
    code: { type: String, ...{ required: true, trim: true, immutable: true } },
    nameAr: { type: String, ...{ required: true, trim: true, immutable: true } },
    nameEn: { type: String, ...{ required: true, trim: true, immutable: true } },
    detailsAr: { type: String, ...{ trim: true, immutable: true } },
    detailsEn: { type: String, ...{ trim: true, immutable: true } },
    includedServiceCodes: { type: [String], required: true, immutable: true },
    benefitsAr: { type: [String], required: true, immutable: true },
    benefitsEn: { type: [String], required: true, immutable: true },
    priceMinor: {
      type: Number,
      ...{
        required: true,
        immutable: true,
        validate: { validator: (value) => isMoneyMinorAmount(value, { positive: true }) },
      },
    },
    currency: { type: String, required: true, enum: [EGP_CURRENCY], immutable: true },
  },
  { _id: false },
);
class ManagedMarketingRequest {}
const ManagedMarketingRequestSchema = new mongooseSchema(
  {
    propertyId: { type: mongooseSchema.Types.Mixed, ref: 'Property', required: true, index: true },
    propertyRevisionId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'PropertyRevision',
      required: true,
      index: true,
    },
    advertiserAccountId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'User',
      required: true,
      index: true,
    },
    createdByActorId: { type: mongooseSchema.Types.Mixed, ref: 'User', required: true },
    packageSnapshot: {
      type: ManagedMarketingPackageSnapshotSchema,
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      ...{
        required: true,
        enum: ManagedMarketingRequestStatus,
        default: ManagedMarketingRequestStatus.PENDING_REVIEW,
        index: true,
      },
    },
    paymentStatus: {
      type: String,
      ...{
        required: true,
        enum: ManagedMarketingPaymentStatus,
        default: ManagedMarketingPaymentStatus.NOT_ELIGIBLE,
        index: true,
      },
    },
    reviewedByActorId: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    reviewedAt: { type: Date, ...{} },
    reviewReason: { type: String, ...{ trim: true, maxlength: 1000 } },
    cancellationReason: { type: String, ...{ trim: true, maxlength: 1000 } },
    cancelledAt: { type: Date, ...{} },
    paidAt: { type: Date, ...{} },
    paidPaymentId: { type: mongooseSchema.Types.Mixed, ref: 'ManagedMarketingPayment' },
  },
  { timestamps: true, collection: 'managed_marketing_requests', versionKey: 'version' },
);
ManagedMarketingRequestSchema.index(
  { advertiserAccountId: 1, createdAt: -1 },
  { name: 'managed_marketing_request_advertiser_history' },
);
ManagedMarketingRequestSchema.index(
  { status: 1, createdAt: 1, _id: 1 },
  { name: 'managed_marketing_request_review_queue' },
);
ManagedMarketingRequestSchema.index(
  { propertyRevisionId: 1 },
  { unique: true, name: 'managed_marketing_request_revision_unique' },
);

Object.assign(exports, {
  ManagedMarketingPackageSnapshot,
  ManagedMarketingRequest,
  ManagedMarketingRequestSchema,
});
