import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OtpVerificationDocument = OtpVerification & Document;

export enum OtpPurpose {
  REGISTER = 'register',
  PASSWORD_RESET = 'password_reset',
}

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'otp_verifications' })
export class OtpVerification {
  @Prop({ required: true, index: true })
  identifier: string; 

  @Prop({ required: true })
  otpHash: string;

  @Prop({ required: true, enum: OtpPurpose })
  purpose: OtpPurpose;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ default: false })
  isUsed: boolean;

  @Prop({ required: true })
  expiresAt: Date;
}

export const OtpVerificationSchema = SchemaFactory.createForClass(OtpVerification);
// TTL index: MongoDB auto-deletes expired OTP docs, keeping the collection clean.
OtpVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
