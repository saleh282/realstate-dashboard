import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PropertyTypeDocument = PropertyType & Document;

@Schema({ timestamps: true, collection: 'property_types' })
export class PropertyType {
  @Prop({ required: true, unique: true, trim: true, lowercase: true, maxlength: 50 })
  code: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  nameAr: string;

  @Prop({ trim: true, maxlength: 100 })
  nameEn?: string;

  @Prop({ trim: true, maxlength: 500 })
  descriptionAr?: string;

  @Prop({ trim: true, maxlength: 50 })
  iconKey?: string;

  @Prop({ default: true, index: true })
  isActive: boolean;

  @Prop({ required: true, default: 0, index: true })
  sortOrder: number;

  @Prop({ required: true, type: Types.ObjectId, ref: 'User' })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId;

  @Prop({ default: 0, min: 0 })
  usageCount: number;
}

export const PropertyTypeSchema = SchemaFactory.createForClass(PropertyType);
PropertyTypeSchema.index({ isActive: 1, sortOrder: 1, nameAr: 1 });
