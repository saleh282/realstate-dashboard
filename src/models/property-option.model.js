'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
const { PROPERTY_OPTION_GROUPS } = require('../domain/property-options/property-option.constants');
class PropertyOption {}
const PropertyOptionSchema = new mongooseSchema(
  {
    code: { type: String, ...{ required: true, trim: true, lowercase: true, maxlength: 50 } },
    group: { type: String, ...{ required: true, enum: PROPERTY_OPTION_GROUPS, index: true } },
    nameAr: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    nameEn: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    descriptionAr: { type: String, ...{ trim: true, maxlength: 500 } },
    iconKey: { type: String, ...{ required: true, trim: true, maxlength: 50 } },
    isActive: { type: Boolean, ...{ default: true, index: true } },
    isDefault: { type: Boolean, ...{ default: false } },
    sortOrder: { type: Number, ...{ required: true, default: 0, index: true } },
    createdBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    updatedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    usageCount: { type: Number, ...{ default: 0, min: 0 } },
  },
  { timestamps: true, collection: 'property_options' },
);
PropertyOptionSchema.index({ group: 1, code: 1 }, { unique: true });
PropertyOptionSchema.index({ group: 1, isActive: 1, sortOrder: 1, nameAr: 1 });
PropertyOptionSchema.index(
  { group: 1, isDefault: 1 },
  { unique: true, partialFilterExpression: { isDefault: true } },
);

Object.assign(exports, { PropertyOption, PropertyOptionSchema });
