'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
class Amenity {}
const AmenitySchema = new mongooseSchema(
  {
    code: {
      type: String,
      ...{ required: true, unique: true, trim: true, lowercase: true, maxlength: 50 },
    },
    nameAr: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    nameEn: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    descriptionAr: { type: String, ...{ trim: true, maxlength: 500 } },
    iconKey: { type: String, ...{ required: true, trim: true, maxlength: 50 } },
    category: {
      type: String,
      ...{ required: true, enum: ['feature', 'service', 'facility'], index: true },
    },
    isActive: { type: Boolean, ...{ default: true, index: true } },
    sortOrder: { type: Number, ...{ required: true, default: 0, index: true } },
    createdBy: { required: true, type: mongooseSchema.Types.Mixed, ref: 'User' },
    updatedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    usageCount: { type: Number, ...{ default: 0, min: 0 } },
  },
  { timestamps: true, collection: 'amenities' },
);
AmenitySchema.index({ isActive: 1, category: 1, sortOrder: 1, nameAr: 1 });

Object.assign(exports, { Amenity, AmenitySchema });
