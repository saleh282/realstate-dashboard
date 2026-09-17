import { SystemRole } from '../auth/roles.enum';
import {
  AccountStatus,
  AccountType,
  BrokerStatus,
  VerificationTrustState,
} from '../users/identity.types';

export type AuthorizationPrincipal = {
  userId: string;
  systemRole: SystemRole;
  accountType: AccountType;
  accountStatus: AccountStatus;
  brokerStatus: BrokerStatus;
  verificationTrustState?: VerificationTrustState;
};

export type AuthorizationIdentity = Partial<AuthorizationPrincipal> & {
  _id?: { toString(): string } | string;
  role?: string;
  isActive?: boolean;
};
