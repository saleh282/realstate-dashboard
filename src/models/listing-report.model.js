'use strict';

const { Schema } = require('mongoose');

const REPORT_REASONS = Object.freeze([
  'misleading',
  'unavailable',
  'wrong_price',
  'duplicate',
  'fraud',
  'inappropriate',
  'other',
]);
const ReportStatus = Object.freeze({ OPEN: 'open', REVIEWED: 'reviewed' });

/** One account's complaint about a published listing, for staff to look at. */
const ListingReportSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: 'Listing', required: true, immutable: true },
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    reason: { type: String, required: true, enum: REPORT_REASONS },
    details: { type: String, maxlength: 500 },
    status: {
      type: String,
      required: true,
      enum: Object.values(ReportStatus),
      default: ReportStatus.OPEN,
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
  },
  { collection: 'listing_reports', timestamps: true, versionKey: false },
);

// An account reports a listing once.
ListingReportSchema.index({ listingId: 1, reporterId: 1 }, { unique: true });
ListingReportSchema.index({ status: 1, createdAt: -1 });

module.exports = { ListingReportSchema, REPORT_REASONS, ReportStatus };
