'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
var AuditAction;
(function (AuditAction) {
  AuditAction['LOGIN_SUCCESS'] = 'login_success';
  AuditAction['LOGIN_FAILED'] = 'login_failed';
  AuditAction['REGISTER'] = 'register';
  AuditAction['OTP_FAILED'] = 'otp_failed';
  AuditAction['PASSWORD_RESET'] = 'password_reset';
  AuditAction['PASSWORD_CHANGED'] = 'password_changed';
  AuditAction['PROFILE_UPDATED'] = 'profile_updated';
  AuditAction['LOGOUT'] = 'logout';
  AuditAction['ACCOUNT_DELETED'] = 'account_deleted';
  AuditAction['ADMIN_USER_DELETED'] = 'admin_user_deleted';
  AuditAction['ACCOUNT_DELETION_REQUESTED'] = 'account_deletion_requested';
  AuditAction['ACCOUNT_DELETION_RESTORED'] = 'account_deletion_restored';
  AuditAction['ACCOUNT_LEGAL_HOLD_PLACED'] = 'account_legal_hold_placed';
  AuditAction['ACCOUNT_LEGAL_HOLD_REMOVED'] = 'account_legal_hold_removed';
  AuditAction['ACCOUNT_ANONYMIZATION_STARTED'] = 'account_anonymization_started';
  AuditAction['ACCOUNT_ANONYMIZATION_COMPLETED'] = 'account_anonymization_completed';
  AuditAction['ACCOUNT_PURGE_ELIGIBILITY_REVIEWED'] = 'account_purge_eligibility_reviewed';
  AuditAction['ADMIN_USER_STATUS_UPDATED'] = 'admin_user_status_updated';
  AuditAction['ADMIN_USER_SESSIONS_REVOKED'] = 'admin_user_sessions_revoked';
  AuditAction['ADMIN_USER_ROLE_UPDATED'] = 'admin_user_role_updated';
  AuditAction['ADMIN_USER_PHOTO_REMOVED'] = 'admin_user_photo_removed';
  AuditAction['ADMIN_KYC_REVIEWED'] = 'admin_kyc_reviewed';
  AuditAction['ADMIN_LEGAL_DOCUMENT_DRAFT_CREATED'] = 'admin_legal_document_draft_created';
  AuditAction['ADMIN_LEGAL_DOCUMENT_DRAFT_UPDATED'] = 'admin_legal_document_draft_updated';
  AuditAction['ADMIN_LEGAL_DOCUMENT_PUBLISHED'] = 'admin_legal_document_published';
  AuditAction['ADMIN_GOVERNORATE_CREATED'] = 'admin_governorate_created';
  AuditAction['ADMIN_GOVERNORATE_UPDATED'] = 'admin_governorate_updated';
  AuditAction['ADMIN_GOVERNORATE_DELETED'] = 'admin_governorate_deleted';
  AuditAction['ADMIN_CITY_CREATED'] = 'admin_city_created';
  AuditAction['ADMIN_CITY_UPDATED'] = 'admin_city_updated';
  AuditAction['ADMIN_CITY_DELETED'] = 'admin_city_deleted';
  AuditAction['PRIVATE_EVIDENCE_UPLOADED'] = 'private_evidence_uploaded';
  AuditAction['PRIVATE_EVIDENCE_ACCESSED'] = 'private_evidence_accessed';
  AuditAction['BROKER_APPLICATION_SUBMITTED'] = 'broker_application_submitted';
  AuditAction['ADMIN_BROKER_APPLICATION_REVIEWED'] = 'admin_broker_application_reviewed';
  AuditAction['ADMIN_BROKER_SUSPENDED'] = 'admin_broker_suspended';
  AuditAction['ADMIN_BROKER_RESTORED'] = 'admin_broker_restored';
  AuditAction['ADMIN_BROKER_REVOKED'] = 'admin_broker_revoked';
})(AuditAction || (AuditAction = {}));
class AuditLog {}
const AuditLogSchema = new mongooseSchema(
  {
    userId: { type: mongooseSchema.Types.Mixed, ref: 'User', default: null },
    action: { type: String, ...{ required: true, enum: AuditAction } },
    ip: { type: String, ...{} },
    actorUserId: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    targetUserId: { type: mongooseSchema.Types.Mixed, ref: 'User' },
    reason: { type: String, ...{ maxlength: 500 } },
    targetResourceId: { type: String, ...{ maxlength: 100 } },
    metadata: { type: Object },
    requestId: { type: String, ...{ required: true, maxlength: 100, index: true } },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'audit_logs' },
);

Object.assign(exports, { AuditAction, AuditLog, AuditLogSchema });
