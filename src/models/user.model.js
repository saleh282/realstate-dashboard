'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { SystemRole } = require('../domain/auth/roles.enum');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
} = require('../domain/users/identity.types');
var KycStatus;
(function (KycStatus) {
  KycStatus['NOT_SUBMITTED'] = 'not_submitted';
  KycStatus['PENDING'] = 'pending';
  KycStatus['VERIFIED'] = 'verified';
  KycStatus['REJECTED'] = 'rejected';
})(KycStatus || (KycStatus = {}));
var IdentifierType;
(function (IdentifierType) {
  IdentifierType['EMAIL'] = 'email';
  IdentifierType['PHONE'] = 'phone';
})(IdentifierType || (IdentifierType = {}));
class User {}
const UserSchema = new mongooseSchema(
  {
    fullName: { type: String, ...{ required: true, trim: true } },
    email: { type: String, ...{ trim: true, lowercase: true, sparse: true, unique: true } },
    phone: { type: String, ...{ trim: true, sparse: true, unique: true } },
    password: { type: String, ...{ required: true, select: false } },
    systemRole: { type: String, ...{ enum: SystemRole, index: true } },
    accountType: { type: String, ...{ enum: AccountType, index: true } },
    accountStatus: { type: String, ...{ enum: AccountStatus, index: true } },
    brokerStatus: { type: String, ...{ enum: BrokerStatus, index: true } },
    brokerVersion: { type: Number, ...{ default: 0, min: 0 } },
    verificationTrustState: { type: String, ...{ enum: VerificationTrustState, index: true } },
    primaryIdentifierType: { type: String, ...{ enum: PrimaryIdentifierType } },
    emailVerifiedAt: { type: Date, ...{} },
    phoneVerifiedAt: { type: Date, ...{} },
    legacyVerifiedIdentifierType: { type: String, ...{ enum: PrimaryIdentifierType } },
    identityMigratedAt: { type: Date, ...{} },
    identityMigrationRunId: { type: String, ...{} },
    identityMigrationVersion: { type: Number, ...{} },
    role: { type: String, ...{ enum: ['user', 'admin'], index: true } },
    emailVerified: { type: Boolean, ...{ default: false } },
    isActive: { type: Boolean, ...{ default: true } },
    suspendReason: { type: String, ...{ trim: true } },
    suspendedAt: { type: Date, ...{} },
    legalAcceptance: { type: Object },
    profilePhoto: { type: Object },
    deletionRequestedAt: { type: Date, ...{ index: true } },
    deletionRecoverableUntil: { type: Date, ...{} },
    anonymizationStartedAt: { type: Date, ...{} },
    anonymizedAt: { type: Date, ...{} },
    pseudonymousActorId: { type: String, ...{ trim: true, maxlength: 100, select: false } },
    failedLoginAttempts: { type: Number, ...{ default: 0, select: false } },
    accountLockedUntil: { type: Date, ...{ select: false } },
    kycStatus: { type: String, ...{ enum: KycStatus, default: KycStatus.NOT_SUBMITTED } },
    idFrontUrl: { type: String, ...{} },
    idFrontAsset: { type: Object },
    idBackUrl: { type: String, ...{} },
    idBackAsset: { type: Object },
    selfieUrl: { type: String, ...{} },
    selfieAsset: { type: Object },
    kycSubmittedAt: { type: Date, ...{} },
    kycReviewedAt: { type: Date, ...{} },
    kycRejectionReason: { type: String, ...{} },
    kycVersion: { type: Number, ...{ default: 0, min: 0 } },
  },
  { timestamps: true },
);

Object.assign(exports, { KycStatus, IdentifierType, User, UserSchema });
