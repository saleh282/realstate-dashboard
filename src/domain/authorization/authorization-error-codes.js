'use strict';

var AuthorizationErrorCode;
(function (AuthorizationErrorCode) {
  AuthorizationErrorCode['FORBIDDEN'] = 'FORBIDDEN';
  AuthorizationErrorCode['ACCOUNT_SUSPENDED'] = 'ACCOUNT_SUSPENDED';
  AuthorizationErrorCode['ADMIN_MARKETPLACE_FORBIDDEN'] = 'ADMIN_MARKETPLACE_FORBIDDEN';
  AuthorizationErrorCode['BROKER_CAPABILITY_REQUIRED'] = 'BROKER_CAPABILITY_REQUIRED';
  AuthorizationErrorCode['RESOURCE_ACCESS_FORBIDDEN'] = 'RESOURCE_ACCESS_FORBIDDEN';
  AuthorizationErrorCode['PROXY_TARGET_INVALID'] = 'PROXY_TARGET_INVALID';
})(AuthorizationErrorCode || (AuthorizationErrorCode = {}));

Object.assign(exports, { AuthorizationErrorCode });
