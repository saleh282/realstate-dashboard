import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { PROPERTY_OPTION_GROUPS } from '../property-option.constants';
export type PropertyOptionDocument = PropertyOption & Document;
@Schema({ timestamps: true, collection: 'property_options' })
export class PropertyOption {
  @Prop({ required: true, trim: true, lowercase: true, maxlength: 50 }) code: string;
  @Prop({ required: true, enum: PROPERTY_OPTION_GROUPS, index: true }) group: string;
  @Prop({ required: true, trim: true, maxlength: 100 }) nameAr: string;
  @Prop({ required: true, trim: true, maxlength: 100 }) nameEn: string;
  @Prop({ trim: true, maxlength: 500 }) descriptionAr?: string;
  @Prop({ required: true, trim: true, maxlength: 50 }) iconKey: string;
  @Prop({ default: true, index: true }) isActive: boolean;
  @Prop({ default: false }) isDefault: boolean;
  @Prop({ required: true, default: 0, index: true }) sortOrder: number;
  @Prop({ type: Types.ObjectId, ref: 'User' }) createdBy?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User' }) updatedBy?: Types.ObjectId;
  @Prop({ default: 0, min: 0 }) usageCount: number;
}
export const PropertyOptionSchema = SchemaFactory.createForClass(PropertyOption);
PropertyOptionSchema.index({ group: 1, code: 1 }, { unique: true });
PropertyOptionSchema.index({ group: 1, isActive: 1, sortOrder: 1, nameAr: 1 });
PropertyOptionSchema.index({ group: 1, isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });
