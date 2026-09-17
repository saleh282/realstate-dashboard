export const ACCOUNT_DELETION_RECOVERY_DAYS = 30;
export const ACCOUNT_DELETION_BLOCKER_PROVIDERS = Symbol('ACCOUNT_DELETION_BLOCKER_PROVIDERS');

export enum AccountDeletionState {
  PENDING = 'PENDING',
  RESTORED = 'RESTORED',
  ANONYMIZING = 'ANONYMIZING',
  ANONYMIZED = 'ANONYMIZED',
  PURGE_DISABLED = 'PURGE_DISABLED',
}

export type AccountDeletionBlocker = {
  code: string;
  category: 'COMMERCIAL' | 'LEGAL' | 'RESOURCE';
  count?: number;
};

export interface AccountDeletionBlockerProvider {
  blockersForAccount(userId: string): Promise<AccountDeletionBlocker[]>;
}
