import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../../common/money/money';

export type ManagedMarketingPackageDocument = HydratedDocument<ManagedMarketingPackage>;

@Schema({ timestamps: true, collection: 'managed_marketing_packages', versionKey: false })
export class ManagedMarketingPackage {
  @Prop({ required: true, trim: true, lowercase: true, maxlength: 50 }) code: string;
  @Prop({ required: true, trim: true, maxlength: 100 }) nameAr: string;
  @Prop({ required: true, trim: true, maxlength: 100 }) nameEn: string;
  @Prop({ trim: true, maxlength: 1000 }) detailsAr?: string;
  @Prop({ trim: true, maxlength: 1000 }) detailsEn?: string;
  @Prop({ type: [String], required: true, default: [] }) includedServiceCodes: string[];
  @Prop({ validate: { validator: (value: unknown) => value === undefined || isMoneyMinorAmount(value, { positive: true }) } }) priceMinor?: number;
  @Prop({ type: String, enum: [EGP_CURRENCY], default: EGP_CURRENCY, immutable: true }) currency: typeof EGP_CURRENCY;
  @Prop({ default: false, index: true }) isActive: boolean;
  @Prop({ default: 0, min: 0, index: true }) sortOrder: number;
  @Prop({ default: 1, min: 1 }) version: number;
  @Prop({ type: Types.ObjectId, ref: 'User', required: true }) createdByActorId: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: 'User' }) updatedByActorId?: Types.ObjectId;
}

export const ManagedMarketingPackageSchema = SchemaFactory.createForClass(ManagedMarketingPackage);
ManagedMarketingPackageSchema.index({ code: 1 }, { unique: true, name: 'managed_marketing_package_code_unique' });
ManagedMarketingPackageSchema.index({ isActive: 1, sortOrder: 1, nameAr: 1 }, { name: 'managed_marketing_package_active_order' });
