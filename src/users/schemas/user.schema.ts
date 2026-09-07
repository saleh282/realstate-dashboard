import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

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

  @Prop()
  idBackUrl?: string;

  @Prop()
  selfieUrl?: string;

  @Prop()
  kycSubmittedAt?: Date;

  @Prop()
  kycReviewedAt?: Date;

  @Prop()
  kycRejectionReason?: string;
}

export const UserSchema = SchemaFactory.createForClass(User);
