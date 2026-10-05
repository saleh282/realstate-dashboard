'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
class City {}
const CitySchema = new mongooseSchema(
  {
    governorateId: {
      required: true,
      type: mongooseSchema.Types.Mixed,
      ref: 'Governorate',
      index: true,
    },
    code: { type: String, ...{ required: true, trim: true, lowercase: true, maxlength: 50 } },
    nameAr: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    nameEn: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    isActive: { type: Boolean, ...{ default: true, index: true } },
    sortOrder: { type: Number, ...{ required: true, default: 0, index: true } },
    createdBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    updatedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    usageCount: { type: Number, ...{ default: 0, min: 0 } },
  },
  { timestamps: true, collection: 'cities' },
);
CitySchema.index({ governorateId: 1, code: 1 }, { unique: true });
CitySchema.index({ governorateId: 1, nameAr: 1 }, { unique: true });
CitySchema.index({ governorateId: 1, isActive: 1, sortOrder: 1, nameAr: 1 });

Object.assign(exports, { City, CitySchema });
