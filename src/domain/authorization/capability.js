'use strict';

var Capability;
(function (Capability) {
  Capability['ACCOUNT_SELF_READ'] = 'ACCOUNT_SELF_READ';
  Capability['ACCOUNT_SELF_MANAGE'] = 'ACCOUNT_SELF_MANAGE';
  Capability['KYC_SELF_READ'] = 'KYC_SELF_READ';
  Capability['KYC_SELF_SUBMIT'] = 'KYC_SELF_SUBMIT';
  Capability['GEOCODING_USE'] = 'GEOCODING_USE';
  Capability['BROKER_APPLICATION_READ_OWN'] = 'BROKER_APPLICATION_READ_OWN';
  Capability['BROKER_APPLICATION_SUBMIT'] = 'BROKER_APPLICATION_SUBMIT';
  Capability['LISTING_CREATE'] = 'LISTING_CREATE';
  Capability['LISTING_MANAGE_OWN'] = 'LISTING_MANAGE_OWN';
  Capability['FAVOURITE_MANAGE_OWN'] = 'FAVOURITE_MANAGE_OWN';
  Capability['LISTING_REPORT'] = 'LISTING_REPORT';
  Capability['ADMIN_KYC_REVIEW'] = 'ADMIN_KYC_REVIEW';
  Capability['ADMIN_BROKER_REVIEW'] = 'ADMIN_BROKER_REVIEW';
  Capability['ADMIN_USER_MANAGE'] = 'ADMIN_USER_MANAGE';
  Capability['ADMIN_LISTING_REVIEW'] = 'ADMIN_LISTING_REVIEW';
})(Capability || (Capability = {}));

Object.assign(exports, { Capability });
