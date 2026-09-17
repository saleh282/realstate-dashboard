import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PropertyPurposeCategoryDocument = HydratedDocument<PropertyPurposeCategory>;

@Schema({ timestamps: true, collection: 'property_purpose_categories', versionKey: false })
export class PropertyPurposeCategory {
  @Prop({ required: true, trim: true, lowercase: true, maxlength: 50 }) code: string;
  @Prop({ required: true, trim: true, maxlength: 100 }) nameAr: string;
  @Prop({ required: true, trim: true, maxlength: 100 }) nameEn: string;
  @Prop({ trim: true, maxlength: 500 }) descriptionAr?: string;
  @Prop({ default: true, index: true }) isActive: boolean;
  @Prop({ required: true, default: 0, index: true }) sortOrder: number;
  @Prop({ required: true, default: 1, min: 1 }) version: number;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) createdBy: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User' }) updatedBy?: Types.ObjectId;
  @Prop({ default: 0, min: 0 }) usageCount: number;
}

export const PropertyPurposeCategorySchema = SchemaFactory.createForClass(PropertyPurposeCategory);
PropertyPurposeCategorySchema.index({ code: 1 }, { unique: true, name: 'property_purpose_code_unique' });
PropertyPurposeCategorySchema.index({ isActive: 1, sortOrder: 1, nameAr: 1 }, { name: 'property_purpose_active_order' });
