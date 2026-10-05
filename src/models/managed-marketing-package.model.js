'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
const { EGP_CURRENCY, isMoneyMinorAmount } = require('../common/money/money');
class ManagedMarketingPackage {}
const ManagedMarketingPackageSchema = new mongooseSchema(
  {
    code: { type: String, ...{ required: true, trim: true, lowercase: true, maxlength: 50 } },
    nameAr: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    nameEn: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    detailsAr: { type: String, ...{ trim: true, maxlength: 1000 } },
    detailsEn: { type: String, ...{ trim: true, maxlength: 1000 } },
    includedServiceCodes: { type: [String], required: true, default: [] },
    benefitsAr: { type: [String], required: true, default: [] },
    benefitsEn: { type: [String], required: true, default: [] },
    priceMinor: {
      type: Number,
      ...{
        validate: {
          validator: (value) =>
            value === undefined || isMoneyMinorAmount(value, { positive: true }),
        },
      },
    },
    currency: { type: String, enum: [EGP_CURRENCY], default: EGP_CURRENCY, immutable: true },
    isActive: { type: Boolean, ...{ default: false, index: true } },
    sortOrder: { type: Number, ...{ default: 0, min: 0, index: true } },
    version: { type: Number, ...{ default: 1, min: 1 } },
    createdByActorId: { type: mongooseSchema.Types.Mixed, ref: 'User', required: true },
    updatedByActorId: { type: mongooseSchema.Types.Mixed, ref: 'User' },
  },
  { timestamps: true, collection: 'managed_marketing_packages', versionKey: false },
);
ManagedMarketingPackageSchema.index(
  { code: 1 },
  { unique: true, name: 'managed_marketing_package_code_unique' },
);
ManagedMarketingPackageSchema.index(
  { isActive: 1, sortOrder: 1, nameAr: 1 },
  { name: 'managed_marketing_package_active_order' },
);

Object.assign(exports, { ManagedMarketingPackage, ManagedMarketingPackageSchema });
