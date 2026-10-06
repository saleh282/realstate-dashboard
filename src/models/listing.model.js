'use strict';

const { Schema } = require('mongoose');
const {
  ListingCategory,
  ListingPurpose,
  ListingStatus,
  AreaUnit,
  FINISHINGS,
  LEGAL_STATUSES,
  WATER_SOURCES,
  PAYMENT_METHODS,
  RENT_PERIODS,
} = require('../domain/listings/listing.types');

/** A stored photo or video. `publicId` is what the storage needs to delete it. */
const mediaFields = {
  publicId: { type: String, required: true },
  url: { type: String, required: true },
  bytes: { type: Number },
};
const ListingPhotoSchema = new Schema({
  ...mediaFields,
  // The required shot this photo fills; absent on the extra photos.
  shot: { type: String },
  // Place among the extra photos; the required shots keep their own order.
  order: { type: Number, default: 0 },
});
const ListingVideoSchema = new Schema({ ...mediaFields }, { _id: false });
const TransferTermsSchema = new Schema(
  {
    monthlyInstallment: { type: Number, required: true },
    totalYears: { type: Number, required: true },
    paidYears: { type: Number, required: true },
    // Kept beside the two above so the remaining years can be filtered on.
    remainingYears: { type: Number, required: true },
    developer: { type: String },
  },
  { _id: false },
);

/** A property offered for sale, for rent or for transfer of its instalment contract. */
const ListingSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    status: {
      type: String,
      required: true,
      enum: Object.values(ListingStatus),
      default: ListingStatus.DRAFT,
    },
    // Counts the changes, so two edits of the same listing cannot overwrite each other.
    version: { type: Number, required: true, default: 1 },

    category: { type: String, required: true, enum: Object.values(ListingCategory) },
    purpose: { type: String, required: true, enum: Object.values(ListingPurpose) },
    subtype: { type: String, required: true },

    titleAr: { type: String, required: true, maxlength: 150 },
    titleEn: { type: String, maxlength: 150 },
    descriptionAr: { type: String, required: true, maxlength: 3000 },
    descriptionEn: { type: String, maxlength: 3000 },

    area: { type: Number, required: true },
    areaUnit: { type: String, required: true, enum: Object.values(AreaUnit) },
    // `area` in square metres whatever its unit, for filtering and sorting.
    areaSqm: { type: Number, required: true },
    bedrooms: { type: Number },
    bathrooms: { type: Number },
    floor: { type: Number },
    totalFloors: { type: Number },
    buildingYear: { type: Number },
    finishing: { type: String, enum: FINISHINGS },
    frontage: { type: Number },
    builtArea: { type: Number },
    ceilingHeight: { type: Number },
    powerKw: { type: Number },
    hasOperatingLicence: { type: Boolean },
    streets: { type: Number },
    waterSource: { type: String, enum: WATER_SOURCES },
    legalStatus: { type: String, enum: LEGAL_STATUSES },
    amenities: { type: [String], default: [] },

    // GeoJSON: coordinates are [longitude, latitude].
    location: {
      type: { type: String, required: true, enum: ['Point'] },
      coordinates: { type: [Number], required: true },
    },
    governorate: { type: String, required: true, maxlength: 80 },
    city: { type: String, maxlength: 80 },
    district: { type: String, required: true, maxlength: 120 },
    street: { type: String, maxlength: 160 },
    addressDetails: { type: String, maxlength: 300 },

    // Sale price, rent for one `rentPeriod`, or the amount asked for a transfer, in EGP.
    price: { type: Number, required: true },
    negotiable: { type: Boolean, default: false },
    paymentMethod: { type: String, enum: PAYMENT_METHODS },
    downPayment: { type: Number },
    rentPeriod: { type: String, enum: RENT_PERIODS },
    furnished: { type: Boolean },
    deposit: { type: Number },
    minContractMonths: { type: Number },
    transfer: { type: TransferTermsSchema },

    photos: { type: [ListingPhotoSchema], default: [] },
    video: { type: ListingVideoSchema },

    contactPhone: { type: String, required: true },
    showPhone: { type: Boolean, default: true },
    allowWhatsapp: { type: Boolean, default: true },

    // Why the review turned it down; set with the rejected status.
    rejectionReason: { type: String, maxlength: 500 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    submittedAt: { type: Date },
    publishedAt: { type: Date },
    closedAt: { type: Date },
  },
  { collection: 'listings', timestamps: true, versionKey: false },
);

ListingSchema.index({ status: 1, category: 1, purpose: 1, publishedAt: -1 });
ListingSchema.index({ ownerId: 1, status: 1, updatedAt: -1 });
ListingSchema.index({ status: 1, submittedAt: 1 });
ListingSchema.index({ location: '2dsphere' });

module.exports = { ListingSchema };
