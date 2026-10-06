'use strict';

const { ForbiddenException } = require('../common/http/errors');
const { SystemRole } = require('../domain/auth/roles.enum');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
  resolveAccountStatus,
  resolveAccountType,
  resolveBrokerStatus,
  resolveSystemRole,
  resolveVerificationTrustState,
} = require('../domain/users/identity.types');
const { AuthorizationErrorCode } = require('../domain/authorization/authorization-error-codes');
const { Capability } = require('../domain/authorization/capability');
const MARKETPLACE_CAPABILITIES = new Set([
  Capability.KYC_SELF_READ,
  Capability.KYC_SELF_SUBMIT,
  Capability.BROKER_APPLICATION_READ_OWN,
  Capability.BROKER_APPLICATION_SUBMIT,
  Capability.LISTING_CREATE,
  Capability.LISTING_MANAGE_OWN,
  Capability.LISTING_REPORT,
  Capability.FAVOURITE_MANAGE_OWN,
]);
class AuthorizationPolicyService {
  static principal(identity) {
    const rawId = identity.userId ?? identity._id;
    return {
      userId: typeof rawId === 'string' ? rawId : (rawId?.toString() ?? ''),
      systemRole: resolveSystemRole(identity),
      accountType: resolveAccountType(identity),
      accountStatus: resolveAccountStatus(identity),
      brokerStatus: resolveBrokerStatus(identity),
      verificationTrustState: resolveVerificationTrustState(identity),
    };
  }
  static can(identity, capability) {
    const principal = this.principal(identity);
    if (!principal.userId) return false;
    const staff =
      principal.systemRole === SystemRole.ADMIN || principal.systemRole === SystemRole.SUPER_ADMIN;
    const authenticated =
      principal.accountStatus === AccountStatus.ACTIVE ||
      principal.accountStatus === AccountStatus.SUSPENDED;
    if (!authenticated) return false;
    if (
      capability === Capability.ACCOUNT_SELF_READ ||
      capability === Capability.ACCOUNT_SELF_MANAGE
    ) {
      return true;
    }
    if (capability === Capability.GEOCODING_USE) {
      // Address lookup backs listing entry: active accounts, and brokers
      // only once approved.
      if (principal.accountStatus !== AccountStatus.ACTIVE) return false;
      if (staff) return true;
      return (
        principal.systemRole === SystemRole.USER &&
        (principal.accountType !== AccountType.BROKER ||
          principal.brokerStatus === BrokerStatus.APPROVED)
      );
    }
    if (capability === Capability.ADMIN_LISTING_REVIEW) {
      return staff && principal.accountStatus === AccountStatus.ACTIVE;
    }
    if (staff) return false;
    const marketplace = principal.systemRole === SystemRole.USER;
    if (!marketplace) return false;
    if (
      capability === Capability.KYC_SELF_READ ||
      capability === Capability.KYC_SELF_SUBMIT ||
      capability === Capability.BROKER_APPLICATION_READ_OWN
    ) {
      return true;
    }
    if (capability === Capability.FAVOURITE_MANAGE_OWN) {
      // A suspended account still sees and tidies what it saved.
      return true;
    }
    if (capability === Capability.LISTING_MANAGE_OWN) {
      // A suspended account may still read, close and delete what it posted.
      return true;
    }
    if (capability === Capability.LISTING_REPORT) {
      return principal.accountStatus === AccountStatus.ACTIVE;
    }
    if (capability === Capability.LISTING_CREATE) {
      return (
        principal.accountStatus === AccountStatus.ACTIVE &&
        (principal.accountType !== AccountType.BROKER ||
          principal.brokerStatus === BrokerStatus.APPROVED)
      );
    }
    if (capability === Capability.BROKER_APPLICATION_SUBMIT) {
      return (
        principal.accountStatus === AccountStatus.ACTIVE &&
        principal.accountType === AccountType.USER &&
        [BrokerStatus.NOT_APPLIED, BrokerStatus.REJECTED, BrokerStatus.REVOKED].includes(
          principal.brokerStatus,
        )
      );
    }
    return false;
  }
  static assert(identity, capability) {
    if (this.can(identity, capability)) return;
    const principal = this.principal(identity);
    if (principal.accountStatus === AccountStatus.SUSPENDED) {
      throw this.denied(
        'الحساب الموقوف لا يمكنه تنفيذ هذا الإجراء',
        AuthorizationErrorCode.ACCOUNT_SUSPENDED,
      );
    }
    if (
      (principal.systemRole === SystemRole.ADMIN ||
        principal.systemRole === SystemRole.SUPER_ADMIN) &&
      MARKETPLACE_CAPABILITIES.has(capability)
    ) {
      throw this.denied(
        'حسابات الإدارة لا تنفذ نشاطاً شخصياً في السوق',
        AuthorizationErrorCode.ADMIN_MARKETPLACE_FORBIDDEN,
      );
    }
    if (
      principal.accountType === AccountType.BROKER &&
      principal.brokerStatus !== BrokerStatus.APPROVED
    ) {
      throw this.denied(
        'هذه العملية تتطلب حساب وسيط معتمداً ونشطاً',
        AuthorizationErrorCode.BROKER_CAPABILITY_REQUIRED,
      );
    }
    throw this.denied('ليس لديك صلاحية لتنفيذ هذا الإجراء', AuthorizationErrorCode.FORBIDDEN);
  }
  static denied(message, code) {
    return new ForbiddenException({ message, code });
  }
}

Object.assign(exports, { AuthorizationPolicyService });
