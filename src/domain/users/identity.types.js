'use strict';

const { normalizeIdentifier } = require('../../common/validators/identifier.validator');
const { SystemRole } = require('../auth/roles.enum');
var AccountType;
(function (AccountType) {
  AccountType['USER'] = 'USER';
  AccountType['BROKER'] = 'BROKER';
})(AccountType || (AccountType = {}));
var AccountStatus;
(function (AccountStatus) {
  AccountStatus['ACTIVE'] = 'ACTIVE';
  AccountStatus['SUSPENDED'] = 'SUSPENDED';
  AccountStatus['BLOCKED'] = 'BLOCKED';
  AccountStatus['PERMANENTLY_BANNED'] = 'PERMANENTLY_BANNED';
  AccountStatus['DELETION_PENDING'] = 'DELETION_PENDING';
  AccountStatus['ANONYMIZED'] = 'ANONYMIZED';
})(AccountStatus || (AccountStatus = {}));
var BrokerStatus;
(function (BrokerStatus) {
  BrokerStatus['NOT_APPLIED'] = 'NOT_APPLIED';
  BrokerStatus['PENDING'] = 'PENDING';
  BrokerStatus['APPROVED'] = 'APPROVED';
  BrokerStatus['REJECTED'] = 'REJECTED';
  BrokerStatus['SUSPENDED'] = 'SUSPENDED';
  BrokerStatus['REVOKED'] = 'REVOKED';
})(BrokerStatus || (BrokerStatus = {}));
var VerificationTrustState;
(function (VerificationTrustState) {
  VerificationTrustState['VERIFIED'] = 'VERIFIED';
  VerificationTrustState['UNVERIFIED'] = 'UNVERIFIED';
})(VerificationTrustState || (VerificationTrustState = {}));
var PrimaryIdentifierType;
(function (PrimaryIdentifierType) {
  PrimaryIdentifierType['EMAIL'] = 'email';
  PrimaryIdentifierType['PHONE'] = 'phone';
})(PrimaryIdentifierType || (PrimaryIdentifierType = {}));
function resolveSystemRole(user) {
  if (Object.values(SystemRole).includes(user.systemRole)) {
    return user.systemRole;
  }
  return user.role?.toLowerCase() === 'admin' ? SystemRole.ADMIN : SystemRole.USER;
}
function resolveAccountType(user) {
  return Object.values(AccountType).includes(user.accountType)
    ? user.accountType
    : AccountType.USER;
}
function resolveAccountStatus(user) {
  if (Object.values(AccountStatus).includes(user.accountStatus)) {
    return user.accountStatus;
  }
  return user.isActive === false ? AccountStatus.SUSPENDED : AccountStatus.ACTIVE;
}
function resolveBrokerStatus(user) {
  return Object.values(BrokerStatus).includes(user.brokerStatus)
    ? user.brokerStatus
    : BrokerStatus.NOT_APPLIED;
}
function resolveVerificationTrustState(user) {
  if (Object.values(VerificationTrustState).includes(user.verificationTrustState)) {
    return user.verificationTrustState;
  }
  return user.kycStatus === 'verified'
    ? VerificationTrustState.VERIFIED
    : VerificationTrustState.UNVERIFIED;
}
function resolvePrimaryIdentifierType(user) {
  if (user.primaryIdentifierType === PrimaryIdentifierType.EMAIL) {
    return PrimaryIdentifierType.EMAIL;
  }
  if (user.primaryIdentifierType === PrimaryIdentifierType.PHONE) {
    return PrimaryIdentifierType.PHONE;
  }
  return user.email ? PrimaryIdentifierType.EMAIL : PrimaryIdentifierType.PHONE;
}
function isIdentifierVerified(user, identifier) {
  const normalized = normalizeIdentifier(identifier);
  if (!normalized) return false;
  if (normalized.kind === 'email') {
    if (user.emailVerifiedAt) return true;
    return (
      user.emailVerified === true &&
      (user.legacyVerifiedIdentifierType === PrimaryIdentifierType.EMAIL ||
        (!user.phone && Boolean(user.email)))
    );
  }
  if (user.phoneVerifiedAt) return true;
  return (
    user.emailVerified === true &&
    (user.legacyVerifiedIdentifierType === PrimaryIdentifierType.PHONE ||
      (!user.email && Boolean(user.phone)))
  );
}
function identityProjection(user) {
  const systemRole = resolveSystemRole(user);
  const accountStatus = resolveAccountStatus(user);
  const primaryIdentifierType = resolvePrimaryIdentifierType(user);
  const emailVerified = user.email ? isIdentifierVerified(user, user.email) : false;
  const phoneVerified = user.phone ? isIdentifierVerified(user, user.phone) : false;
  return {
    systemRole,
    accountType: resolveAccountType(user),
    accountStatus,
    brokerStatus: resolveBrokerStatus(user),
    brokerVersion: user.brokerVersion ?? 0,
    verificationTrustState: resolveVerificationTrustState(user),
    primaryIdentifierType,
    emailVerification: { isVerified: emailVerified, verifiedAt: user.emailVerifiedAt },
    phoneVerification: { isVerified: phoneVerified, verifiedAt: user.phoneVerifiedAt },
    // Read-only aliases for clients during the bounded compatibility window.
    role: systemRole === SystemRole.USER ? 'user' : 'admin',
    isActive: accountStatus === AccountStatus.ACTIVE,
    emailVerified:
      primaryIdentifierType === PrimaryIdentifierType.EMAIL ? emailVerified : phoneVerified,
  };
}

Object.assign(exports, {
  AccountType,
  AccountStatus,
  BrokerStatus,
  VerificationTrustState,
  PrimaryIdentifierType,
  resolveSystemRole,
  resolveAccountType,
  resolveAccountStatus,
  resolveBrokerStatus,
  resolveVerificationTrustState,
  resolvePrimaryIdentifierType,
  isIdentifierVerified,
  identityProjection,
});
