import { ForbiddenException } from '@nestjs/common';
import { SystemRole } from '../src/auth/roles.enum';
import { AuthorizationErrorCode } from '../src/authorization/authorization-error-codes';
import { AuthorizationPolicyService } from '../src/authorization/authorization-policy.service';
import { Capability } from '../src/authorization/capability';
import {
  AccountStatus,
  AccountType,
  BrokerStatus,
  VerificationTrustState,
} from '../src/users/identity.types';

const id = {
  user: '64b000000000000000000001',
  other: '64b000000000000000000002',
  admin: '64b000000000000000000003',
};

function principal(overrides: Record<string, unknown> = {}) {
  return {
    userId: id.user,
    systemRole: SystemRole.USER,
    accountType: AccountType.USER,
    accountStatus: AccountStatus.ACTIVE,
    brokerStatus: BrokerStatus.NOT_APPLIED,
    verificationTrustState: VerificationTrustState.UNVERIFIED,
    ...overrides,
  } as any;
}

function codeOf(action: () => void) {
  try {
    action();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    return (error as ForbiddenException).getResponse() as { code?: string };
  }
}

describe('MAZAD-016 authorization policy matrix', () => {
  it('defaults to deny without an authenticated principal', () => {
    expect(AuthorizationPolicyService.can({}, Capability.PROPERTY_CREATE)).toBe(false);
  });

  it.each([
    [AccountType.USER, BrokerStatus.NOT_APPLIED],
    [AccountType.BROKER, BrokerStatus.APPROVED],
    [AccountType.COMPANY, BrokerStatus.NOT_APPLIED],
  ])('allows active %s marketplace property commands', (accountType, brokerStatus) => {
    expect(AuthorizationPolicyService.can(principal({ accountType, brokerStatus }), Capability.PROPERTY_CREATE)).toBe(true);
    expect(AuthorizationPolicyService.can(principal({ accountType, brokerStatus }), Capability.PROPERTY_MANAGE_OWN)).toBe(true);
  });

  it.each([AccountStatus.SUSPENDED, AccountStatus.BLOCKED, AccountStatus.PERMANENTLY_BANNED])(
    'denies marketplace mutation for %s accounts',
    (accountStatus) => {
      expect(AuthorizationPolicyService.can(principal({ accountStatus }), Capability.PROPERTY_CREATE)).toBe(false);
    },
  );

  it('keeps suspended accounts read-capable and returns a stable mutation error', () => {
    const suspended = principal({ accountStatus: AccountStatus.SUSPENDED });
    expect(AuthorizationPolicyService.can(suspended, Capability.PROPERTY_READ_OWN)).toBe(true);
    expect(codeOf(() => AuthorizationPolicyService.assert(suspended, Capability.PROPERTY_CREATE)))
      .toMatchObject({ code: AuthorizationErrorCode.ACCOUNT_SUSPENDED });
  });

  it('does not use KYC trust state as a marketplace gate', () => {
    const unverified = principal({ verificationTrustState: VerificationTrustState.UNVERIFIED });
    const verified = principal({ verificationTrustState: VerificationTrustState.VERIFIED });
    expect(AuthorizationPolicyService.can(unverified, Capability.PROPERTY_CREATE)).toBe(true);
    expect(AuthorizationPolicyService.can(verified, Capability.PROPERTY_CREATE)).toBe(true);
  });

  it.each([
    [AccountType.USER, BrokerStatus.NOT_APPLIED],
    [AccountType.BROKER, BrokerStatus.APPROVED],
    [AccountType.COMPANY, BrokerStatus.NOT_APPLIED],
  ])('allows active %s accounts to request managed marketing without a KYC gate', (accountType, brokerStatus) => {
    const identity = principal({
      accountType,
      brokerStatus,
      verificationTrustState: VerificationTrustState.UNVERIFIED,
    });
    expect(AuthorizationPolicyService.can(identity, Capability.MANAGED_MARKETING_REQUEST)).toBe(true);
  });

  it('does not turn managed marketing into a broker-only capability', () => {
    expect(() => AuthorizationPolicyService.assert(
      principal({ accountType: AccountType.USER, brokerStatus: BrokerStatus.NOT_APPLIED }),
      Capability.MANAGED_MARKETING_REQUEST,
    )).not.toThrow();
  });

  it('keeps broker approval scoped to broker/property commands, not the platform service request', () => {
    const pendingBroker = principal({
      accountType: AccountType.BROKER,
      brokerStatus: BrokerStatus.PENDING,
    });
    expect(AuthorizationPolicyService.can(
      pendingBroker,
      Capability.MANAGED_MARKETING_REQUEST,
    )).toBe(true);
    expect(AuthorizationPolicyService.can(pendingBroker, Capability.PROPERTY_CREATE)).toBe(false);
  });

  it.each([AccountStatus.SUSPENDED, AccountStatus.BLOCKED, AccountStatus.PERMANENTLY_BANNED])(
    'keeps managed-marketing mutations blocked for %s accounts',
    (accountStatus) => {
      expect(AuthorizationPolicyService.can(
        principal({ accountStatus }),
        Capability.MANAGED_MARKETING_REQUEST,
      )).toBe(false);
    },
  );

  it('requires an approved active broker for broker-only capabilities', () => {
    const approved = principal({ accountType: AccountType.BROKER, brokerStatus: BrokerStatus.APPROVED });
    const suspended = principal({ accountType: AccountType.BROKER, brokerStatus: BrokerStatus.SUSPENDED });
    expect(AuthorizationPolicyService.can(approved, Capability.BROKER_INTEREST_MANAGE)).toBe(true);
    expect(AuthorizationPolicyService.can(suspended, Capability.BROKER_INTEREST_MANAGE)).toBe(false);
    expect(codeOf(() => AuthorizationPolicyService.assert(suspended, Capability.BROKER_INTEREST_MANAGE)))
      .toMatchObject({ code: AuthorizationErrorCode.BROKER_CAPABILITY_REQUIRED });
  });

  it.each([BrokerStatus.NOT_APPLIED, BrokerStatus.REJECTED, BrokerStatus.REVOKED])(
    'allows an ACTIVE USER with broker state %s to apply',
    (brokerStatus) => {
      expect(AuthorizationPolicyService.can(principal({ brokerStatus }), Capability.BROKER_APPLICATION_SUBMIT)).toBe(true);
    },
  );

  it('keeps staff administrative-only and preserves SUPER_ADMIN governance', () => {
    const admin = principal({ userId: id.admin, systemRole: SystemRole.ADMIN });
    const superAdmin = principal({ userId: id.admin, systemRole: SystemRole.SUPER_ADMIN });
    expect(AuthorizationPolicyService.can(admin, Capability.ADMIN_PROPERTY_REVIEW)).toBe(true);
    expect(AuthorizationPolicyService.can(admin, Capability.PROPERTY_CREATE)).toBe(false);
    expect(AuthorizationPolicyService.can(admin, Capability.SUPER_ADMIN_ROLE_MANAGE)).toBe(false);
    expect(AuthorizationPolicyService.can(superAdmin, Capability.SUPER_ADMIN_ROLE_MANAGE)).toBe(true);
    expect(codeOf(() => AuthorizationPolicyService.assert(admin, Capability.PROPERTY_CREATE)))
      .toMatchObject({ code: AuthorizationErrorCode.ADMIN_MARKETPLACE_FORBIDDEN });
  });

  it('default-denies privileged operations for a suspended staff account', () => {
    const suspendedAdmin = principal({
      userId: id.admin,
      systemRole: SystemRole.ADMIN,
      accountStatus: AccountStatus.SUSPENDED,
    });
    expect(AuthorizationPolicyService.can(suspendedAdmin, Capability.ACCOUNT_SELF_READ)).toBe(true);
    expect(AuthorizationPolicyService.can(suspendedAdmin, Capability.ADMIN_ACCOUNT_MANAGE)).toBe(false);
    expect(AuthorizationPolicyService.can(
      { ...suspendedAdmin, systemRole: SystemRole.SUPER_ADMIN },
      Capability.SUPER_ADMIN_ROLE_MANAGE,
    )).toBe(false);
  });

  it('allows only Admin proxy creation for an eligible marketplace target', () => {
    const admin = principal({ userId: id.admin, systemRole: SystemRole.ADMIN });
    const target = principal({ userId: id.other, accountType: AccountType.COMPANY });
    expect(AuthorizationPolicyService.assertPropertyAttribution(admin, target, true)).toBe(AccountType.COMPANY);
    expect(codeOf(() => AuthorizationPolicyService.assertPropertyAttribution(principal(), target, true)))
      .toMatchObject({ code: AuthorizationErrorCode.FORBIDDEN });
  });

  it.each([
    { systemRole: SystemRole.ADMIN },
    { accountStatus: AccountStatus.SUSPENDED },
    { accountType: AccountType.BROKER, brokerStatus: BrokerStatus.SUSPENDED },
  ])('rejects an ineligible or forged proxy target %#', (targetOverrides) => {
    const admin = principal({ userId: id.admin, systemRole: SystemRole.ADMIN });
    const target = principal({ userId: id.other, ...targetOverrides });
    expect(codeOf(() => AuthorizationPolicyService.assertPropertyAttribution(admin, target, true)))
      .toMatchObject({ code: AuthorizationErrorCode.PROXY_TARGET_INVALID });
  });

  it.each([
    [AccountType.USER, BrokerStatus.NOT_APPLIED],
    [AccountType.BROKER, BrokerStatus.APPROVED],
    [AccountType.COMPANY, BrokerStatus.NOT_APPLIED],
  ])('enforces own-resource and IDOR boundaries for %s', (accountType, brokerStatus) => {
    const actor = principal({ accountType, brokerStatus });
    expect(() => AuthorizationPolicyService.assertOwnResource(actor, id.user)).not.toThrow();
    expect(codeOf(() => AuthorizationPolicyService.assertOwnResource(actor, id.other)))
      .toMatchObject({ code: AuthorizationErrorCode.RESOURCE_ACCESS_FORBIDDEN });
  });

  it('provides a future-safe exact-account self-bid hook', () => {
    expect(() => AuthorizationPolicyService.assertBid(principal(), id.other)).not.toThrow();
    expect(codeOf(() => AuthorizationPolicyService.assertBid(principal(), id.user)))
      .toMatchObject({ code: AuthorizationErrorCode.SELF_BID_FORBIDDEN });
  });

  it('returns computed capabilities as advisory UI hints only', () => {
    const capabilities = AuthorizationPolicyService.capabilitiesFor(principal());
    expect(capabilities).toContain(Capability.PROPERTY_CREATE);
    expect(capabilities).not.toContain(Capability.ADMIN_PROPERTY_REVIEW);
  });

  it('grants FAVORITE_MANAGE_OWN to any authenticated marketplace account, not gated by broker approval (MAZAD-022)', () => {
    expect(AuthorizationPolicyService.can({}, Capability.FAVORITE_MANAGE_OWN)).toBe(false);
    expect(AuthorizationPolicyService.can(principal({ accountType: AccountType.USER }), Capability.FAVORITE_MANAGE_OWN)).toBe(true);
    expect(AuthorizationPolicyService.can(principal({ accountType: AccountType.COMPANY }), Capability.FAVORITE_MANAGE_OWN)).toBe(true);
    expect(AuthorizationPolicyService.can(
      principal({ accountType: AccountType.BROKER, brokerStatus: BrokerStatus.NOT_APPLIED }),
      Capability.FAVORITE_MANAGE_OWN,
    )).toBe(true);
    const admin = principal({ userId: id.admin, systemRole: SystemRole.ADMIN, accountType: AccountType.USER });
    expect(AuthorizationPolicyService.can(admin, Capability.FAVORITE_MANAGE_OWN)).toBe(false);
    expect(codeOf(() => AuthorizationPolicyService.assert(admin, Capability.FAVORITE_MANAGE_OWN)))
      .toMatchObject({ code: AuthorizationErrorCode.ADMIN_MARKETPLACE_FORBIDDEN });
  });

  it('gates AUCTION_CREATE_OWN like PROPERTY_CREATE: broker approval required, admins forbidden (MAZAD-023)', () => {
    expect(AuthorizationPolicyService.can(principal({ accountType: AccountType.USER }), Capability.AUCTION_CREATE_OWN)).toBe(true);
    expect(AuthorizationPolicyService.can(principal({ accountType: AccountType.COMPANY }), Capability.AUCTION_CREATE_OWN)).toBe(true);
    expect(AuthorizationPolicyService.can(
      principal({ accountType: AccountType.BROKER, brokerStatus: BrokerStatus.APPROVED }),
      Capability.AUCTION_CREATE_OWN,
    )).toBe(true);
    expect(AuthorizationPolicyService.can(
      principal({ accountType: AccountType.BROKER, brokerStatus: BrokerStatus.PENDING }),
      Capability.AUCTION_CREATE_OWN,
    )).toBe(false);
    const admin = principal({ userId: id.admin, systemRole: SystemRole.ADMIN, accountType: AccountType.USER });
    expect(AuthorizationPolicyService.can(admin, Capability.AUCTION_CREATE_OWN)).toBe(false);
    expect(codeOf(() => AuthorizationPolicyService.assert(admin, Capability.AUCTION_CREATE_OWN)))
      .toMatchObject({ code: AuthorizationErrorCode.ADMIN_MARKETPLACE_FORBIDDEN });
  });

  it('confirms the frozen V1 bid-eligibility rules the auction foundation relies on: admins cannot bid, an advertiser cannot bid on their own listing (MAZAD-023)', () => {
    const admin = principal({ userId: id.admin, systemRole: SystemRole.ADMIN, accountType: AccountType.USER });
    expect(AuthorizationPolicyService.can(admin, Capability.BID_PLACE)).toBe(false);
    expect(codeOf(() => AuthorizationPolicyService.assertBid(admin, id.other)))
      .toMatchObject({ code: AuthorizationErrorCode.ADMIN_MARKETPLACE_FORBIDDEN });
    expect(codeOf(() => AuthorizationPolicyService.assertBid(principal(), id.user)))
      .toMatchObject({ code: AuthorizationErrorCode.SELF_BID_FORBIDDEN });
  });
});
