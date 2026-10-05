'use strict';

var ManagedMarketingRequestStatus;
(function (ManagedMarketingRequestStatus) {
  ManagedMarketingRequestStatus['PENDING_REVIEW'] = 'PENDING_REVIEW';
  ManagedMarketingRequestStatus['APPROVED'] = 'APPROVED';
  ManagedMarketingRequestStatus['REJECTED'] = 'REJECTED';
  ManagedMarketingRequestStatus['CANCELLED'] = 'CANCELLED';
  ManagedMarketingRequestStatus['PAID'] = 'PAID';
  ManagedMarketingRequestStatus['INSPECTION_SCHEDULED'] = 'INSPECTION_SCHEDULED';
  ManagedMarketingRequestStatus['INSPECTION_COMPLETED'] = 'INSPECTION_COMPLETED';
  ManagedMarketingRequestStatus['PHOTOGRAPHY_SCHEDULED'] = 'PHOTOGRAPHY_SCHEDULED';
  ManagedMarketingRequestStatus['PHOTOGRAPHY_COMPLETED'] = 'PHOTOGRAPHY_COMPLETED';
  ManagedMarketingRequestStatus['MARKETING_ACTIVE'] = 'MARKETING_ACTIVE';
  ManagedMarketingRequestStatus['COMPLETED'] = 'COMPLETED';
})(ManagedMarketingRequestStatus || (ManagedMarketingRequestStatus = {}));
var ManagedMarketingPaymentStatus;
(function (ManagedMarketingPaymentStatus) {
  ManagedMarketingPaymentStatus['NOT_ELIGIBLE'] = 'NOT_ELIGIBLE';
  ManagedMarketingPaymentStatus['AWAITING_PAYMENT'] = 'AWAITING_PAYMENT';
  ManagedMarketingPaymentStatus['PENDING'] = 'PENDING';
  ManagedMarketingPaymentStatus['SUCCEEDED'] = 'SUCCEEDED';
  ManagedMarketingPaymentStatus['FAILED'] = 'FAILED';
  ManagedMarketingPaymentStatus['RECONCILIATION_REQUIRED'] = 'RECONCILIATION_REQUIRED';
})(ManagedMarketingPaymentStatus || (ManagedMarketingPaymentStatus = {}));

Object.assign(exports, { ManagedMarketingRequestStatus, ManagedMarketingPaymentStatus });
