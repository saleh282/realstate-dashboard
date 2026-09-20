import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CityDocument = City & Document;

@Schema({ timestamps: true, collection: 'cities' })
export class City {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Governorate', index: true })
  governorateId: Types.ObjectId;

  @Prop({ required: true, trim: true, lowercase: true, maxlength: 50 })
  code: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  nameAr: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  nameEn: string;

  @Prop({ default: true, index: true })
  isActive: boolean;

  @Prop({ required: true, default: 0, index: true })
  sortOrder: number;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  updatedBy?: Types.ObjectId;

  @Prop({ default: 0, min: 0 })
  usageCount: number;
}

export const CitySchema = SchemaFactory.createForClass(City);
CitySchema.index({ governorateId: 1, code: 1 }, { unique: true });
CitySchema.index({ governorateId: 1, nameAr: 1 }, { unique: true });
CitySchema.index({ governorateId: 1, isActive: 1, sortOrder: 1, nameAr: 1 });
