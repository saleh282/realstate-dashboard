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
  ACCOUNT_DELETION_REQUESTED = 'account_deletion_requested',
  ACCOUNT_DELETION_RESTORED = 'account_deletion_restored',
  ACCOUNT_LEGAL_HOLD_PLACED = 'account_legal_hold_placed',
  ACCOUNT_LEGAL_HOLD_REMOVED = 'account_legal_hold_removed',
  ACCOUNT_ANONYMIZATION_STARTED = 'account_anonymization_started',
  ACCOUNT_ANONYMIZATION_COMPLETED = 'account_anonymization_completed',
  ACCOUNT_PURGE_ELIGIBILITY_REVIEWED = 'account_purge_eligibility_reviewed',
  ADMIN_USER_STATUS_UPDATED = 'admin_user_status_updated',
  ADMIN_USER_SESSIONS_REVOKED = 'admin_user_sessions_revoked',
  ADMIN_USER_ROLE_UPDATED = 'admin_user_role_updated',
  ADMIN_COMPANY_ACCOUNT_CREATED = 'admin_company_account_created',
  ADMIN_KYC_REVIEWED = 'admin_kyc_reviewed',
  ADMIN_PROPERTY_TYPE_CREATED = 'admin_property_type_created',
  ADMIN_PROPERTY_TYPE_UPDATED = 'admin_property_type_updated',
  ADMIN_PROPERTY_TYPE_DELETED = 'admin_property_type_deleted',
  ADMIN_PROPERTY_PURPOSE_CREATED = 'admin_property_purpose_created',
  ADMIN_PROPERTY_PURPOSE_UPDATED = 'admin_property_purpose_updated',
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
  PROPERTY_CREATED = 'property_created',
  PROPERTY_REVISION_CREATED = 'property_revision_created',
  PROPERTY_REVISION_DRAFT_UPDATED = 'property_revision_draft_updated',
  PROPERTY_REVISION_SUBMITTED = 'property_revision_submitted',
  PROPERTY_REVISION_APPROVED = 'property_revision_approved',
  PROPERTY_REVISION_REJECTED = 'property_revision_rejected',
  PROPERTY_ARCHIVED = 'property_archived',
  PROPERTY_RESTORED = 'property_restored',
  PROPERTY_ADMIN_HIDDEN = 'property_admin_hidden',
  PROPERTY_ADMIN_RESTORED = 'property_admin_restored',
  ADMIN_PROPERTY_PROXY_CREATED = 'admin_property_proxy_created',
  PRIVATE_EVIDENCE_UPLOADED = 'private_evidence_uploaded',
  PRIVATE_EVIDENCE_ACCESSED = 'private_evidence_accessed',
  PROPERTY_MEDIA_UPLOADED = 'property_media_uploaded',
  PROPERTY_MEDIA_REPLACED = 'property_media_replaced',
  PROPERTY_MEDIA_UPDATED = 'property_media_updated',
  PROPERTY_MEDIA_REMOVED = 'property_media_removed',
  PROPERTY_MEDIA_ACCESSED = 'property_media_accessed',
  BROKER_APPLICATION_SUBMITTED = 'broker_application_submitted',
  ADMIN_BROKER_APPLICATION_REVIEWED = 'admin_broker_application_reviewed',
  ADMIN_BROKER_SUSPENDED = 'admin_broker_suspended',
  ADMIN_BROKER_RESTORED = 'admin_broker_restored',
  ADMIN_BROKER_REVOKED = 'admin_broker_revoked',
  ADMIN_BROKER_REQUIREMENT_CREATED = 'admin_broker_requirement_created',
  ADMIN_BROKER_REQUIREMENT_UPDATED = 'admin_broker_requirement_updated',
  ADMIN_BROKER_REQUIREMENT_ARCHIVED = 'admin_broker_requirement_archived',
  ADMIN_MANAGED_MARKETING_PACKAGE_CREATED = 'admin_managed_marketing_package_created',
  ADMIN_MANAGED_MARKETING_PACKAGE_UPDATED = 'admin_managed_marketing_package_updated',
  MANAGED_MARKETING_REQUEST_CREATED = 'managed_marketing_request_created',
  MANAGED_MARKETING_REQUEST_CANCELLED = 'managed_marketing_request_cancelled',
  ADMIN_MANAGED_MARKETING_REQUEST_REVIEWED = 'admin_managed_marketing_request_reviewed',
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

  @Prop({ required: true, maxlength: 100, index: true })
  requestId: string;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
