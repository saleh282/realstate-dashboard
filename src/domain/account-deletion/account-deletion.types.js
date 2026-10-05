'use strict';

const ACCOUNT_DELETION_RECOVERY_DAYS = 30;
const ACCOUNT_DELETION_BLOCKER_PROVIDERS = Symbol('ACCOUNT_DELETION_BLOCKER_PROVIDERS');
var AccountDeletionState;
(function (AccountDeletionState) {
  AccountDeletionState['PENDING'] = 'PENDING';
  AccountDeletionState['RESTORED'] = 'RESTORED';
  AccountDeletionState['ANONYMIZING'] = 'ANONYMIZING';
  AccountDeletionState['ANONYMIZED'] = 'ANONYMIZED';
  AccountDeletionState['PURGE_DISABLED'] = 'PURGE_DISABLED';
})(AccountDeletionState || (AccountDeletionState = {}));

Object.assign(exports, {
  ACCOUNT_DELETION_RECOVERY_DAYS,
  ACCOUNT_DELETION_BLOCKER_PROVIDERS,
  AccountDeletionState,
});
