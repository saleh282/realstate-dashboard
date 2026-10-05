'use strict';

var CompanyErrorCode;
(function (CompanyErrorCode) {
  CompanyErrorCode['PAYLOAD_INVALID'] = 'COMPANY_PAYLOAD_INVALID';
  CompanyErrorCode['PRIVILEGED_ASSIGNMENT_FORBIDDEN'] = 'COMPANY_PRIVILEGED_ASSIGNMENT_FORBIDDEN';
  CompanyErrorCode['EMAIL_ALREADY_EXISTS'] = 'COMPANY_EMAIL_ALREADY_EXISTS';
  CompanyErrorCode['PHONE_ALREADY_EXISTS'] = 'COMPANY_PHONE_ALREADY_EXISTS';
  CompanyErrorCode['CONTACT_PHONE_INVALID'] = 'COMPANY_CONTACT_PHONE_INVALID';
  CompanyErrorCode['CREATION_CONFLICT'] = 'COMPANY_ACCOUNT_CREATION_CONFLICT';
})(CompanyErrorCode || (CompanyErrorCode = {}));

Object.assign(exports, { CompanyErrorCode });
