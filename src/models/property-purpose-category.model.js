'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
class PropertyPurposeCategory {}
const PropertyPurposeCategorySchema = new mongooseSchema(
  {
    code: { type: String, ...{ required: true, trim: true, lowercase: true, maxlength: 50 } },
    nameAr: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    nameEn: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    descriptionAr: { type: String, ...{ trim: true, maxlength: 500 } },
    isActive: { type: Boolean, ...{ default: true, index: true } },
    sortOrder: { type: Number, ...{ required: true, default: 0, index: true } },
    version: { type: Number, ...{ required: true, default: 1, min: 1 } },
    createdBy: { type: mongooseSchema.Types.Mixed, ref: 'User', required: true },
    updatedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    usageCount: { type: Number, ...{ default: 0, min: 0 } },
  },
  { timestamps: true, collection: 'property_purpose_categories', versionKey: false },
);
PropertyPurposeCategorySchema.index(
  { code: 1 },
  { unique: true, name: 'property_purpose_code_unique' },
);
PropertyPurposeCategorySchema.index(
  { isActive: 1, sortOrder: 1, nameAr: 1 },
  { name: 'property_purpose_active_order' },
);

Object.assign(exports, { PropertyPurposeCategory, PropertyPurposeCategorySchema });
