import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AuditLogDocument = AuditLog & Document;

export enum AuditAction {
  LOGIN_SUCCESS = 'login_success',
  LOGIN_FAILED = 'login_failed',
  REGISTER = 'register',
  OTP_FAILED = 'otp_failed',
  PASSWORD_RESET = 'password_reset',
  PASSWORD_CHANGED = 'password_changed',
  PROFILE_UPDATED = 'profile_updated',
  LOGOUT = 'logout',
  ACCOUNT_DELETED = 'account_deleted',
  ADMIN_USER_DELETED = 'admin_user_deleted',
  ADMIN_USER_STATUS_UPDATED = 'admin_user_status_updated',
  ADMIN_USER_SESSIONS_REVOKED = 'admin_user_sessions_revoked',
  ADMIN_USER_ROLE_UPDATED = 'admin_user_role_updated',
  ADMIN_KYC_REVIEWED = 'admin_kyc_reviewed',
}

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'audit_logs' })
export class AuditLog {
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  userId: Types.ObjectId | null; // null when the actor couldn't be identified (e.g. login with unknown identifier)

  @Prop({ required: true, enum: AuditAction })
  action: AuditAction;

  @Prop()
  ip: string;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  actorUserId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  targetUserId?: Types.ObjectId;

  @Prop({ maxlength: 500 })
  reason?: string;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
