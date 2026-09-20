import { ForbiddenException, Injectable } from '@nestjs/common';
import { SystemRole } from '../auth/roles.enum';
import {
  AccountStatus,
  AccountType,
  BrokerStatus,
  resolveAccountStatus,
  resolveAccountType,
  resolveBrokerStatus,
  resolveSystemRole,
  resolveVerificationTrustState,
} from '../users/identity.types';
import { AuthorizationErrorCode } from './authorization-error-codes';
import { AuthorizationIdentity, AuthorizationPrincipal } from './authorization.types';
import { Capability } from './capability';

const ADMIN_CAPABILITIES = new Set<Capability>([
  Capability.COMPANY_CREATE,
  Capability.ADMIN_ACCOUNT_READ,
  Capability.ADMIN_ACCOUNT_MANAGE,
  Capability.ADMIN_AUDIT_READ,
  Capability.ADMIN_DASHBOARD_READ,
  Capability.ADMIN_KYC_REVIEW,
  Capability.ADMIN_PROPERTY_REVIEW,
  Capability.ADMIN_PROPERTY_PROXY_CREATE,
  Capability.ADMIN_BROKER_REVIEW,
  Capability.ADMIN_CATALOG_MANAGE,
  Capability.ADMIN_MANAGED_MARKETING_MANAGE,
]);

const MARKETPLACE_MUTATIONS = new Set<Capability>([
  Capability.PROPERTY_CREATE,
  Capability.PROPERTY_MANAGE_OWN,
  Capability.MANAGED_MARKETING_REQUEST,
  Capability.BROKER_APPLICATION_SUBMIT,
  Capability.BROKER_INTEREST_MANAGE,
  Capability.AUCTION_CREATE_OWN,
  Capability.BID_PLACE,
  Capability.PAYMENT_ENTRY_INITIATE,
]);

const MARKETPLACE_CAPABILITIES = new Set<Capability>([
  Capability.KYC_SELF_READ,
  Capability.KYC_SELF_SUBMIT,
  Capability.PROPERTY_CREATE,
  Capability.PROPERTY_READ_OWN,
  Capability.PROPERTY_MANAGE_OWN,
  Capability.MANAGED_MARKETING_REQUEST,
  Capability.BROKER_APPLICATION_READ_OWN,
  Capability.BROKER_APPLICATION_SUBMIT,
  Capability.BROKER_INTEREST_MANAGE,
  Capability.AUCTION_CREATE_OWN,
  Capability.BID_PLACE,
  Capability.PAYMENT_ENTRY_INITIATE,
]);

@Injectable()
export class AuthorizationPolicyService {
  static principal(identity: AuthorizationIdentity): AuthorizationPrincipal {
    const rawId = identity.userId ?? identity._id;
    return {
      userId: typeof rawId === 'string' ? rawId : rawId?.toString() ?? '',
      systemRole: resolveSystemRole(identity),
      accountType: resolveAccountType(identity),
      accountStatus: resolveAccountStatus(identity),
      brokerStatus: resolveBrokerStatus(identity),
      verificationTrustState: resolveVerificationTrustState(identity),
    };
  }

  static capabilitiesFor(identity: AuthorizationIdentity): Capability[] {
    const principal = this.principal(identity);
    if (!principal.userId) return [];
    return Object.values(Capability).filter((capability) => this.can(principal, capability));
  }

  static can(identity: AuthorizationIdentity, capability: Capability): boolean {
    const principal = this.principal(identity);
    if (!principal.userId) return false;
    const staff = principal.systemRole === SystemRole.ADMIN || principal.systemRole === SystemRole.SUPER_ADMIN;
    const authenticated = principal.accountStatus === AccountStatus.ACTIVE || principal.accountStatus === AccountStatus.SUSPENDED;
    if (!authenticated) return false;

    if (capability === Capability.ACCOUNT_SELF_READ || capability === Capability.ACCOUNT_SELF_MANAGE) {
      return true;
    }
    if (capability === Capability.SUPER_ADMIN_ROLE_MANAGE) {
      return principal.systemRole === SystemRole.SUPER_ADMIN && principal.accountStatus === AccountStatus.ACTIVE;
    }
    if (ADMIN_CAPABILITIES.has(capability)) {
      return staff && principal.accountStatus === AccountStatus.ACTIVE;
    }
    if (staff) return false;

    const marketplace = principal.systemRole === SystemRole.USER;
    if (!marketplace) return false;
    if (
      capability === Capability.KYC_SELF_READ ||
      capability === Capability.KYC_SELF_SUBMIT ||
      capability === Capability.PROPERTY_READ_OWN ||
      capability === Capability.BROKER_APPLICATION_READ_OWN
    ) {
      return true;
    }
    if (MARKETPLACE_MUTATIONS.has(capability) && principal.accountStatus !== AccountStatus.ACTIVE) {
      return false;
    }
    if (capability === Capability.BROKER_APPLICATION_SUBMIT) {
      return principal.accountType === AccountType.USER && [
        BrokerStatus.NOT_APPLIED,
        BrokerStatus.REJECTED,
        BrokerStatus.REVOKED,
      ].includes(principal.brokerStatus);
    }
    if (capability === Capability.BROKER_INTEREST_MANAGE) {
      return principal.accountType === AccountType.BROKER && principal.brokerStatus === BrokerStatus.APPROVED;
    }
    if (capability === Capability.MANAGED_MARKETING_REQUEST) {
      // A managed-marketing request is an own-property platform service, not a
      // broker activity. Property commands retain their broker eligibility
      // rules, while the service enforces ownership and revision eligibility.
      return true;
    }
    if (
      capability === Capability.PROPERTY_CREATE ||
      capability === Capability.PROPERTY_MANAGE_OWN ||
      capability === Capability.AUCTION_CREATE_OWN ||
      capability === Capability.BID_PLACE ||
      capability === Capability.PAYMENT_ENTRY_INITIATE
    ) {
      return principal.accountType !== AccountType.BROKER || principal.brokerStatus === BrokerStatus.APPROVED;
    }
    return false;
  }

  static assert(identity: AuthorizationIdentity, capability: Capability): void {
    if (this.can(identity, capability)) return;
    const principal = this.principal(identity);
    if (principal.accountStatus === AccountStatus.SUSPENDED) {
      throw this.denied('الحساب الموقوف لا يمكنه تنفيذ هذا الإجراء', AuthorizationErrorCode.ACCOUNT_SUSPENDED);
    }
    if (
      (principal.systemRole === SystemRole.ADMIN || principal.systemRole === SystemRole.SUPER_ADMIN) &&
      MARKETPLACE_CAPABILITIES.has(capability)
    ) {
      throw this.denied('حسابات الإدارة لا تنفذ نشاطاً شخصياً في السوق', AuthorizationErrorCode.ADMIN_MARKETPLACE_FORBIDDEN);
    }
    if (
      capability === Capability.BROKER_INTEREST_MANAGE ||
      (principal.accountType === AccountType.BROKER && principal.brokerStatus !== BrokerStatus.APPROVED)
    ) {
      throw this.denied('هذه العملية تتطلب حساب وسيط معتمداً ونشطاً', AuthorizationErrorCode.BROKER_CAPABILITY_REQUIRED);
    }
    throw this.denied('ليس لديك صلاحية لتنفيذ هذا الإجراء', AuthorizationErrorCode.FORBIDDEN);
  }

  static assertPropertyAttribution(
    actorIdentity: AuthorizationIdentity,
    advertiserIdentity: AuthorizationIdentity,
    proxy: boolean,
  ): AccountType {
    const actor = this.principal(actorIdentity);
    const advertiser = this.principal(advertiserIdentity);
    if (proxy) {
      this.assert(actor, Capability.ADMIN_PROPERTY_PROXY_CREATE);
      if (
        advertiser.systemRole !== SystemRole.USER ||
        advertiser.accountStatus !== AccountStatus.ACTIVE ||
        (advertiser.accountType === AccountType.BROKER && advertiser.brokerStatus !== BrokerStatus.APPROVED)
      ) {
        throw this.denied('الحساب المحدد غير مؤهل لعملية الإدارة بالنيابة', AuthorizationErrorCode.PROXY_TARGET_INVALID);
      }
      return advertiser.accountType;
    }
    if (actor.userId !== advertiser.userId) {
      throw this.denied('لا يمكنك تنفيذ عملية على موارد حساب آخر', AuthorizationErrorCode.RESOURCE_ACCESS_FORBIDDEN);
    }
    this.assert(actor, Capability.PROPERTY_CREATE);
    return advertiser.accountType;
  }

  static assertOwnResource(identity: AuthorizationIdentity, ownerAccountId: string): void {
    const principal = this.principal(identity);
    if (principal.systemRole !== SystemRole.USER || principal.userId !== ownerAccountId) {
      throw this.denied('لا يمكنك الوصول إلى هذا المورد', AuthorizationErrorCode.RESOURCE_ACCESS_FORBIDDEN);
    }
  }

  static assertBid(identity: AuthorizationIdentity, advertiserAccountId: string): void {
    this.assert(identity, Capability.BID_PLACE);
    if (this.principal(identity).userId === advertiserAccountId) {
      throw this.denied('لا يمكن للحساب المعلن المزايدة على إعلانه', AuthorizationErrorCode.SELF_BID_FORBIDDEN);
    }
  }

  private static denied(message: string, code: AuthorizationErrorCode) {
    return new ForbiddenException({ message, code });
  }
}
