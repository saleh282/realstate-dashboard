'use strict';

var PaymentErrorCode;
(function (PaymentErrorCode) {
  /** This request already has a succeeded payment. */
  PaymentErrorCode['ALREADY_PAID'] = 'PAYMENT_ALREADY_PAID';
  PaymentErrorCode['NOT_FOUND'] = 'PAYMENT_NOT_FOUND';
  /** No payment provider is configured: production fails closed. */
  PaymentErrorCode['PROVIDER_UNAVAILABLE'] = 'PAYMENT_PROVIDER_UNAVAILABLE';
  /** The provider's verified amount, currency or reference disagrees with the server-owned payment; nothing is granted. */
  PaymentErrorCode['VERIFICATION_MISMATCH'] = 'PAYMENT_VERIFICATION_MISMATCH';
  /** The provider reported success for a payment the server had already recorded as failed; needs manual reconciliation. */
  PaymentErrorCode['CONFIRMED_AFTER_FAILURE'] = 'PAYMENT_CONFIRMED_AFTER_FAILURE';
  /** The provider reported success for a payment the server had already expired locally; needs manual reconciliation. */
  PaymentErrorCode['CONFIRMED_AFTER_EXPIRY'] = 'PAYMENT_CONFIRMED_AFTER_EXPIRY';
  /** Another request is opening this very attempt with the provider right now; re-read the state shortly. */
  PaymentErrorCode['INITIATION_IN_PROGRESS'] = 'PAYMENT_INITIATION_IN_PROGRESS';
  /** Concurrent confirmation kept invalidating the attempt; safe to retry. */
  PaymentErrorCode['RETRY_EXHAUSTED'] = 'PAYMENT_RETRY_EXHAUSTED';
  /** Persistent state disagrees with itself (e.g. request/payment mismatch); never retried. */
  PaymentErrorCode['STATE_INCONSISTENT'] = 'PAYMENT_STATE_INCONSISTENT';
  /** The managed-marketing request is not in a payable state (not approved, cancelled, or already paid). */
  PaymentErrorCode['REQUEST_NOT_PAYABLE'] = 'PAYMENT_REQUEST_NOT_PAYABLE';
  /** The request is parked for operator reconciliation; no further payment action is accepted automatically. */
  PaymentErrorCode['RECONCILIATION_REQUIRED'] = 'PAYMENT_RECONCILIATION_REQUIRED';
})(PaymentErrorCode || (PaymentErrorCode = {}));

Object.assign(exports, { PaymentErrorCode });
