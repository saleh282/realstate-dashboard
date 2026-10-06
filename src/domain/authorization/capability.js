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
})(Capability || (Capability = {}));

Object.assign(exports, { Capability });
