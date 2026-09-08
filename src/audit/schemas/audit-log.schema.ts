import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AuditLogDocument = AuditLog & Document;

export enum AuditAction {
  LOGIN_SUCCESS = 'login_success',
  LOGIN_FAILED = 'login_failed',
  REGISTER = 'register',
  OTP_FAILED = 'otp_failed',
  PASSWORD_RESET = 'password_reset',
  LOGOUT = 'logout',
  ACCOUNT_DELETED = 'account_deleted',
}

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'audit_logs' })
export class AuditLog {
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  userId: Types.ObjectId | null; // null when the actor couldn't be identified (e.g. login with unknown identifier)

  @Prop({ required: true, enum: AuditAction })
  action: AuditAction;

  @Prop()
  ip: string;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
