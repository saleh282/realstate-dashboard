'use strict';

const { ForbiddenException } = require('../src/common/http/errors');
const { SystemRole } = require('../src/domain/auth/roles.enum');
const { AuthorizationErrorCode } = require('../src/domain/authorization/authorization-error-codes');
const { AuthorizationPolicyService } = require('../src/services/authorization-policy.service');
const { Capability } = require('../src/domain/authorization/capability');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
  VerificationTrustState,
} = require('../src/domain/users/identity.types');
const id = {
  user: '64b000000000000000000001',
  other: '64b000000000000000000002',
  admin: '64b000000000000000000003',
};
function principal(overrides = {}) {
  return {
    userId: id.user,
    systemRole: SystemRole.USER,
    accountType: AccountType.USER,
    accountStatus: AccountStatus.ACTIVE,
    brokerStatus: BrokerStatus.NOT_APPLIED,
    verificationTrustState: VerificationTrustState.UNVERIFIED,
    ...overrides,
  };
}
function codeOf(action) {
  try {
    action();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    return error.getResponse();
  }
}
describe('authorization policy', () => {
  const can = (identity, capability) => AuthorizationPolicyService.can(identity, capability);
  it('defaults to deny without an authenticated principal', () => {
    for (const capability of Object.values(Capability)) {
      expect(can({}, capability)).toBe(false);
    }
  });
  it.each([AccountStatus.BLOCKED, AccountStatus.PERMANENTLY_BANNED])(
    'denies everything to %s accounts',
    (accountStatus) => {
      for (const capability of Object.values(Capability)) {
        expect(can(principal({ accountStatus }), capability)).toBe(false);
      }
    },
  );
  it('lets an active user do everything but the staff reviews', () => {
    for (const capability of Object.values(Capability)) {
      expect(can(principal(), capability)).toBe(!capability.startsWith('ADMIN_'));
    }
  });
  it('lets a suspended account manage its listings but not post new ones', () => {
    const suspended = principal({ accountStatus: AccountStatus.SUSPENDED });
    expect(can(suspended, Capability.LISTING_MANAGE_OWN)).toBe(true);
    expect(can(suspended, Capability.LISTING_CREATE)).toBe(false);
  });
  it('lets a broker post listings only once approved', () => {
    const broker = (brokerStatus) => principal({ accountType: AccountType.BROKER, brokerStatus });
    expect(can(broker(BrokerStatus.APPROVED), Capability.LISTING_CREATE)).toBe(true);
    expect(can(broker(BrokerStatus.PENDING), Capability.LISTING_CREATE)).toBe(false);
    expect(can(broker(BrokerStatus.SUSPENDED), Capability.LISTING_CREATE)).toBe(false);
  });
  it.each([SystemRole.ADMIN, SystemRole.SUPER_ADMIN])(
    'lets an active %s review listings but not post any',
    (systemRole) => {
      const staff = principal({ userId: id.admin, systemRole });
      for (const review of ['ADMIN_LISTING_REVIEW', 'ADMIN_KYC_REVIEW', 'ADMIN_BROKER_REVIEW']) {
        expect(can(staff, Capability[review])).toBe(true);
        expect(can({ ...staff, accountStatus: AccountStatus.SUSPENDED }, Capability[review])).toBe(
          false,
        );
      }
      expect(can(staff, Capability.LISTING_CREATE)).toBe(false);
      expect(can(staff, Capability.LISTING_MANAGE_OWN)).toBe(false);
      expect(
        can({ ...staff, accountStatus: AccountStatus.SUSPENDED }, Capability.ADMIN_LISTING_REVIEW),
      ).toBe(false);
    },
  );
  it('keeps suspended accounts read-capable and returns a stable mutation error', () => {
    const suspended = principal({ accountStatus: AccountStatus.SUSPENDED });
    expect(can(suspended, Capability.ACCOUNT_SELF_READ)).toBe(true);
    expect(can(suspended, Capability.KYC_SELF_READ)).toBe(true);
    expect(can(suspended, Capability.BROKER_APPLICATION_READ_OWN)).toBe(true);
    expect(can(suspended, Capability.GEOCODING_USE)).toBe(false);
    expect(
      codeOf(() =>
        AuthorizationPolicyService.assert(suspended, Capability.BROKER_APPLICATION_SUBMIT),
      ),
    ).toMatchObject({ code: AuthorizationErrorCode.ACCOUNT_SUSPENDED });
  });
  it('does not use KYC trust state as a gate', () => {
    const verified = principal({ verificationTrustState: VerificationTrustState.VERIFIED });
    for (const capability of Object.values(Capability)) {
      expect(can(verified, capability)).toBe(can(principal(), capability));
    }
  });
  it.each([BrokerStatus.NOT_APPLIED, BrokerStatus.REJECTED, BrokerStatus.REVOKED])(
    'allows an ACTIVE USER with broker state %s to apply',
    (brokerStatus) => {
      expect(can(principal({ brokerStatus }), Capability.BROKER_APPLICATION_SUBMIT)).toBe(true);
    },
  );
  it.each([BrokerStatus.PENDING, BrokerStatus.APPROVED, BrokerStatus.SUSPENDED])(
    'does not let a user with broker state %s apply again',
    (brokerStatus) => {
      expect(can(principal({ brokerStatus }), Capability.BROKER_APPLICATION_SUBMIT)).toBe(false);
    },
  );
  it('opens address lookup to a broker only once approved', () => {
    const broker = (brokerStatus) => principal({ accountType: AccountType.BROKER, brokerStatus });
    expect(can(broker(BrokerStatus.APPROVED), Capability.GEOCODING_USE)).toBe(true);
    expect(can(broker(BrokerStatus.PENDING), Capability.GEOCODING_USE)).toBe(false);
    expect(
      codeOf(() =>
        AuthorizationPolicyService.assert(broker(BrokerStatus.PENDING), Capability.GEOCODING_USE),
      ),
    ).toMatchObject({ code: AuthorizationErrorCode.BROKER_CAPABILITY_REQUIRED });
  });
  it.each([SystemRole.ADMIN, SystemRole.SUPER_ADMIN])(
    'keeps %s accounts out of personal marketplace activity',
    (systemRole) => {
      const staff = principal({ userId: id.admin, systemRole });
      expect(can(staff, Capability.ACCOUNT_SELF_MANAGE)).toBe(true);
      expect(can(staff, Capability.KYC_SELF_SUBMIT)).toBe(false);
      expect(can(staff, Capability.BROKER_APPLICATION_SUBMIT)).toBe(false);
      expect(
        codeOf(() => AuthorizationPolicyService.assert(staff, Capability.KYC_SELF_SUBMIT)),
      ).toMatchObject({ code: AuthorizationErrorCode.ADMIN_MARKETPLACE_FORBIDDEN });
    },
  );
});
