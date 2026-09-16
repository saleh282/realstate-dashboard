import { normalizeIdentifier } from '../common/validators/identifier.validator';
import { SystemRole } from '../auth/roles.enum';

export enum AccountType {
  USER = 'USER',
  BROKER = 'BROKER',
  COMPANY = 'COMPANY',
}

export enum AccountStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  BLOCKED = 'BLOCKED',
  PERMANENTLY_BANNED = 'PERMANENTLY_BANNED',
}

export enum BrokerStatus {
  NOT_APPLIED = 'NOT_APPLIED',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  SUSPENDED = 'SUSPENDED',
  REVOKED = 'REVOKED',
}

export enum VerificationTrustState {
  VERIFIED = 'VERIFIED',
  UNVERIFIED = 'UNVERIFIED',
}

export enum PrimaryIdentifierType {
  EMAIL = 'email',
  PHONE = 'phone',
}

type IdentitySource = {
  systemRole?: SystemRole;
  accountType?: AccountType;
  accountStatus?: AccountStatus;
  brokerStatus?: BrokerStatus;
  verificationTrustState?: VerificationTrustState;
  primaryIdentifierType?: PrimaryIdentifierType | string;
  email?: string;
  phone?: string;
  emailVerifiedAt?: Date | string;
  phoneVerifiedAt?: Date | string;
  legacyVerifiedIdentifierType?: PrimaryIdentifierType | string;
  role?: string;
  isActive?: boolean;
  emailVerified?: boolean;
  kycStatus?: string;
};

export function resolveSystemRole(user: IdentitySource): SystemRole {
  if (Object.values(SystemRole).includes(user.systemRole as SystemRole)) {
    return user.systemRole as SystemRole;
  }
  return user.role?.toLowerCase() === 'admin' ? SystemRole.ADMIN : SystemRole.USER;
}

export function resolveAccountType(user: IdentitySource): AccountType {
  return Object.values(AccountType).includes(user.accountType as AccountType)
    ? (user.accountType as AccountType)
    : AccountType.USER;
}

export function resolveAccountStatus(user: IdentitySource): AccountStatus {
  if (Object.values(AccountStatus).includes(user.accountStatus as AccountStatus)) {
    return user.accountStatus as AccountStatus;
  }
  return user.isActive === false ? AccountStatus.SUSPENDED : AccountStatus.ACTIVE;
}

export function resolveBrokerStatus(user: IdentitySource): BrokerStatus {
  return Object.values(BrokerStatus).includes(user.brokerStatus as BrokerStatus)
    ? (user.brokerStatus as BrokerStatus)
    : BrokerStatus.NOT_APPLIED;
}

export function resolveVerificationTrustState(user: IdentitySource): VerificationTrustState {
  if (
    Object.values(VerificationTrustState).includes(
      user.verificationTrustState as VerificationTrustState,
    )
  ) {
    return user.verificationTrustState as VerificationTrustState;
  }
  return user.kycStatus === 'verified'
    ? VerificationTrustState.VERIFIED
    : VerificationTrustState.UNVERIFIED;
}

export function resolvePrimaryIdentifierType(user: IdentitySource): PrimaryIdentifierType {
  if (user.primaryIdentifierType === PrimaryIdentifierType.EMAIL) {
    return PrimaryIdentifierType.EMAIL;
  }
  if (user.primaryIdentifierType === PrimaryIdentifierType.PHONE) {
    return PrimaryIdentifierType.PHONE;
  }
  return user.email ? PrimaryIdentifierType.EMAIL : PrimaryIdentifierType.PHONE;
}

export function isIdentifierVerified(user: IdentitySource, identifier: string): boolean {
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

export function identityProjection(user: IdentitySource) {
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
