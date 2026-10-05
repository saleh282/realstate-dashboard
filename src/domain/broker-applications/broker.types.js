'use strict';

var BrokerApplicationStatus;
(function (BrokerApplicationStatus) {
  BrokerApplicationStatus['PENDING'] = 'PENDING';
  BrokerApplicationStatus['APPROVED'] = 'APPROVED';
  BrokerApplicationStatus['REJECTED'] = 'REJECTED';
})(BrokerApplicationStatus || (BrokerApplicationStatus = {}));

Object.assign(exports, { BrokerApplicationStatus });
