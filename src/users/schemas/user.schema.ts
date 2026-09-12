import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { UserRole } from '../../auth/roles.enum';

export type UserDocument = User & Document;

export enum KycStatus {
  NOT_SUBMITTED = 'not_submitted',
  PENDING = 'pending',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
}

export enum IdentifierType {
  EMAIL = 'email',
  PHONE = 'phone',
}

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, trim: true })
  fullName: string;

  @Prop({ trim: true, lowercase: true, sparse: true, unique: true })
  email?: string;

  @Prop({ trim: true, sparse: true, unique: true })
  phone?: string;

  @Prop({ required: true, select: false })
  password: string;

  @Prop({ required: true, enum: UserRole, default: UserRole.USER, index: true })
  role: UserRole;

 
  @Prop({ default: false })
  emailVerified: boolean;

  // ---- Brute-force login protection ----
  @Prop({ default: 0, select: false })
  failedLoginAttempts: number;

  @Prop({ select: false })
  accountLockedUntil?: Date;

  // ---- KYC fields ----
  @Prop({ enum: KycStatus, default: KycStatus.NOT_SUBMITTED })
  kycStatus: KycStatus;

  @Prop()
  idFrontUrl?: string;

  @Prop({ type: Object })
  idFrontAsset?: KycAssetMetadata;

  @Prop()
  idBackUrl?: string;

  @Prop({ type: Object })
  idBackAsset?: KycAssetMetadata;

  @Prop()
  selfieUrl?: string;

  @Prop({ type: Object })
  selfieAsset?: KycAssetMetadata;

  @Prop()
  kycSubmittedAt?: Date;

  @Prop()
  kycReviewedAt?: Date;

  @Prop()
  kycRejectionReason?: string;
}

export interface KycAssetMetadata {
  publicId: string;
  secureUrl: string;
  resourceType: 'image';
  deliveryType: 'authenticated';
}

export const UserSchema = SchemaFactory.createForClass(User);
