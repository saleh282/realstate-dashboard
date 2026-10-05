'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
class PropertyType {}
const PropertyTypeSchema = new mongooseSchema(
  {
    code: {
      type: String,
      ...{ required: true, unique: true, trim: true, lowercase: true, maxlength: 50 },
    },
    nameAr: { type: String, ...{ required: true, trim: true, maxlength: 100 } },
    nameEn: { type: String, ...{ trim: true, maxlength: 100 } },
    descriptionAr: { type: String, ...{ trim: true, maxlength: 500 } },
    iconKey: { type: String, ...{ trim: true, maxlength: 50 } },
    purposeCategoryId: {
      type: mongooseSchema.Types.Mixed,
      ref: 'PropertyPurposeCategory',
      index: true,
    },
    isActive: { type: Boolean, ...{ default: true, index: true } },
    sortOrder: { type: Number, ...{ required: true, default: 0, index: true } },
    createdBy: { required: true, type: mongooseSchema.Types.Mixed, ref: 'User' },
    updatedBy: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    usageCount: { type: Number, ...{ default: 0, min: 0 } },
    version: { type: Number, ...{ default: 0, min: 0 } },
  },
  { timestamps: true, collection: 'property_types' },
);
PropertyTypeSchema.index({ isActive: 1, sortOrder: 1, nameAr: 1 });
PropertyTypeSchema.index(
  { purposeCategoryId: 1, isActive: 1, sortOrder: 1 },
  { name: 'property_subcategory_parent_active_order' },
);

Object.assign(exports, { PropertyType, PropertyTypeSchema });
