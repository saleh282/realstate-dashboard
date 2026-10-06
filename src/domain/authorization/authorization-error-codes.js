'use strict';

var AuthorizationErrorCode;
(function (AuthorizationErrorCode) {
  AuthorizationErrorCode['FORBIDDEN'] = 'FORBIDDEN';
  AuthorizationErrorCode['ACCOUNT_SUSPENDED'] = 'ACCOUNT_SUSPENDED';
  AuthorizationErrorCode['ADMIN_MARKETPLACE_FORBIDDEN'] = 'ADMIN_MARKETPLACE_FORBIDDEN';
  AuthorizationErrorCode['BROKER_CAPABILITY_REQUIRED'] = 'BROKER_CAPABILITY_REQUIRED';
})(AuthorizationErrorCode || (AuthorizationErrorCode = {}));

Object.assign(exports, { AuthorizationErrorCode });
