'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
class Governorate {}
const GovernorateSchema = new mongooseSchema(
  {
    code: {
      type: String,
      ...{ required: true, unique: true, trim: true, lowercase: true, maxlength: 50 },
    },
    nameAr: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    nameEn: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    iconKey: {
      type: String,
      ...{ required: true, trim: true, maxlength: 50, default: 'location' },
    },
    isActive: { type: Boolean, ...{ default: true, index: true } },
    sortOrder: { type: Number, ...{ required: true, default: 0, index: true } },
    createdBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    updatedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    usageCount: { type: Number, ...{ default: 0, min: 0 } },
    mapViewport: { type: Object },
  },
  { timestamps: true, collection: 'governorates' },
);
GovernorateSchema.index({ isActive: 1, sortOrder: 1, nameAr: 1 });

Object.assign(exports, { Governorate, GovernorateSchema });
