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
  ADMIN_PROPERTY_TYPE_CREATED = 'admin_property_type_created',
  ADMIN_PROPERTY_TYPE_UPDATED = 'admin_property_type_updated',
  ADMIN_PROPERTY_TYPE_DELETED = 'admin_property_type_deleted',
  ADMIN_AMENITY_CREATED = 'admin_amenity_created',
  ADMIN_AMENITY_UPDATED = 'admin_amenity_updated',
  ADMIN_AMENITY_DELETED = 'admin_amenity_deleted',
  ADMIN_PROPERTY_OPTION_CREATED = 'admin_property_option_created',
  ADMIN_PROPERTY_OPTION_UPDATED = 'admin_property_option_updated',
  ADMIN_PROPERTY_OPTION_DELETED = 'admin_property_option_deleted',
  ADMIN_GOVERNORATE_CREATED = 'admin_governorate_created',
  ADMIN_GOVERNORATE_UPDATED = 'admin_governorate_updated',
  ADMIN_GOVERNORATE_DELETED = 'admin_governorate_deleted',
  ADMIN_PROPERTY_STATUS_UPDATED = 'admin_property_status_updated',
  PRIVATE_EVIDENCE_UPLOADED = 'private_evidence_uploaded',
  PRIVATE_EVIDENCE_ACCESSED = 'private_evidence_accessed',
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

  @Prop({ maxlength: 100 })
  targetResourceId?: string;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
