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
  AuditAction['ADMIN_COMPANY_ACCOUNT_CREATED'] = 'admin_company_account_created';
  AuditAction['ADMIN_KYC_REVIEWED'] = 'admin_kyc_reviewed';
  AuditAction['ADMIN_PROPERTY_TYPE_CREATED'] = 'admin_property_type_created';
  AuditAction['ADMIN_PROPERTY_TYPE_UPDATED'] = 'admin_property_type_updated';
  AuditAction['ADMIN_PROPERTY_TYPE_DELETED'] = 'admin_property_type_deleted';
  AuditAction['ADMIN_PROPERTY_PURPOSE_CREATED'] = 'admin_property_purpose_created';
  AuditAction['ADMIN_PROPERTY_PURPOSE_UPDATED'] = 'admin_property_purpose_updated';
  AuditAction['ADMIN_AMENITY_CREATED'] = 'admin_amenity_created';
  AuditAction['ADMIN_AMENITY_UPDATED'] = 'admin_amenity_updated';
  AuditAction['ADMIN_AMENITY_DELETED'] = 'admin_amenity_deleted';
  AuditAction['ADMIN_LEGAL_DOCUMENT_DRAFT_CREATED'] = 'admin_legal_document_draft_created';
  AuditAction['ADMIN_LEGAL_DOCUMENT_DRAFT_UPDATED'] = 'admin_legal_document_draft_updated';
  AuditAction['ADMIN_LEGAL_DOCUMENT_PUBLISHED'] = 'admin_legal_document_published';
  AuditAction['ADMIN_PROPERTY_OPTION_CREATED'] = 'admin_property_option_created';
  AuditAction['ADMIN_PROPERTY_OPTION_UPDATED'] = 'admin_property_option_updated';
  AuditAction['ADMIN_PROPERTY_OPTION_DELETED'] = 'admin_property_option_deleted';
  AuditAction['ADMIN_GOVERNORATE_CREATED'] = 'admin_governorate_created';
  AuditAction['ADMIN_GOVERNORATE_UPDATED'] = 'admin_governorate_updated';
  AuditAction['ADMIN_GOVERNORATE_DELETED'] = 'admin_governorate_deleted';
  AuditAction['ADMIN_CITY_CREATED'] = 'admin_city_created';
  AuditAction['ADMIN_CITY_UPDATED'] = 'admin_city_updated';
  AuditAction['ADMIN_CITY_DELETED'] = 'admin_city_deleted';
  AuditAction['ADMIN_FORM_DEFINITION_CREATED'] = 'admin_form_definition_created';
  AuditAction['ADMIN_FORM_DRAFT_CREATED'] = 'admin_form_draft_created';
  AuditAction['ADMIN_FORM_DRAFT_UPDATED'] = 'admin_form_draft_updated';
  AuditAction['ADMIN_FORM_DRAFT_DISCARDED'] = 'admin_form_draft_discarded';
  AuditAction['ADMIN_FORM_VERSION_PUBLISHED'] = 'admin_form_version_published';
  AuditAction['ADMIN_FORM_DEFINITION_ARCHIVED'] = 'admin_form_definition_archived';
  AuditAction['ADMIN_FORM_DEFINITION_RESTORED'] = 'admin_form_definition_restored';
  AuditAction['ADMIN_PROPERTY_STATUS_UPDATED'] = 'admin_property_status_updated';
  AuditAction['PROPERTY_CREATED'] = 'property_created';
  AuditAction['PROPERTY_REVISION_CREATED'] = 'property_revision_created';
  AuditAction['PROPERTY_REVISION_DRAFT_UPDATED'] = 'property_revision_draft_updated';
  AuditAction['PROPERTY_REVISION_SUBMITTED'] = 'property_revision_submitted';
  AuditAction['PROPERTY_REVISION_APPROVED'] = 'property_revision_approved';
  AuditAction['PROPERTY_REVISION_REJECTED'] = 'property_revision_rejected';
  AuditAction['PROPERTY_ARCHIVED'] = 'property_archived';
  AuditAction['PROPERTY_RESTORED'] = 'property_restored';
  AuditAction['PROPERTY_ADMIN_HIDDEN'] = 'property_admin_hidden';
  AuditAction['PROPERTY_ADMIN_RESTORED'] = 'property_admin_restored';
  AuditAction['ADMIN_PROPERTY_PROXY_CREATED'] = 'admin_property_proxy_created';
  AuditAction['PRIVATE_EVIDENCE_UPLOADED'] = 'private_evidence_uploaded';
  AuditAction['PRIVATE_EVIDENCE_ACCESSED'] = 'private_evidence_accessed';
  AuditAction['PROPERTY_MEDIA_UPLOADED'] = 'property_media_uploaded';
  AuditAction['PROPERTY_MEDIA_REPLACED'] = 'property_media_replaced';
  AuditAction['PROPERTY_MEDIA_UPDATED'] = 'property_media_updated';
  AuditAction['PROPERTY_MEDIA_REMOVED'] = 'property_media_removed';
  AuditAction['PROPERTY_MEDIA_ACCESSED'] = 'property_media_accessed';
  AuditAction['BROKER_APPLICATION_SUBMITTED'] = 'broker_application_submitted';
  AuditAction['ADMIN_BROKER_APPLICATION_REVIEWED'] = 'admin_broker_application_reviewed';
  AuditAction['ADMIN_BROKER_SUSPENDED'] = 'admin_broker_suspended';
  AuditAction['ADMIN_BROKER_RESTORED'] = 'admin_broker_restored';
  AuditAction['ADMIN_BROKER_REVOKED'] = 'admin_broker_revoked';
  AuditAction['ADMIN_BROKER_REQUIREMENT_CREATED'] = 'admin_broker_requirement_created';
  AuditAction['ADMIN_BROKER_REQUIREMENT_UPDATED'] = 'admin_broker_requirement_updated';
  AuditAction['ADMIN_BROKER_REQUIREMENT_ARCHIVED'] = 'admin_broker_requirement_archived';
  AuditAction['ADMIN_MANAGED_MARKETING_PACKAGE_CREATED'] =
    'admin_managed_marketing_package_created';
  AuditAction['ADMIN_MANAGED_MARKETING_PACKAGE_UPDATED'] =
    'admin_managed_marketing_package_updated';
  AuditAction['MANAGED_MARKETING_REQUEST_CREATED'] = 'managed_marketing_request_created';
  AuditAction['MANAGED_MARKETING_REQUEST_CANCELLED'] = 'managed_marketing_request_cancelled';
  AuditAction['ADMIN_MANAGED_MARKETING_REQUEST_REVIEWED'] =
    'admin_managed_marketing_request_reviewed';
  AuditAction['MANAGED_MARKETING_PAYMENT_INITIATED'] = 'managed_marketing_payment_initiated';
  AuditAction['MANAGED_MARKETING_PAYMENT_CONFIRMED'] = 'managed_marketing_payment_confirmed';
  AuditAction['MANAGED_MARKETING_PAYMENT_FAILED'] = 'managed_marketing_payment_failed';
  AuditAction['MANAGED_MARKETING_PAYMENT_REJECTED'] = 'managed_marketing_payment_rejected';
  AuditAction['MANAGED_MARKETING_PAYMENT_EXPIRED'] = 'managed_marketing_payment_expired';
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
