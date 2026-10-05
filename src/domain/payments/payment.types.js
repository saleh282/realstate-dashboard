'use strict';

/**
 * Payment attempt state machine (MAZAD-028):
 *
 *   INITIATED ──(server-verified success)──▶ SUCCEEDED   (terminal)
 *       │
 *       ├────(server-verified failure)────▶ FAILED       (terminal)
 *       │
 *       └────(local expiry, after a final verification still said PENDING)──▶ EXPIRED (terminal)
 *
 * Only the server-side confirmation service moves a payment out of INITIATED,
 * and only from an outcome it obtained itself from the provider port. There is
 * no client-reachable transition. A verified success for a FAILED or EXPIRED
 * payment is NOT a transition: it is flagged for manual reconciliation.
 *
 * EXPIRED is a record, never garbage: the row is kept for history/audit, it
 * releases the live-attempt slot (a new attempt may be opened) and it never
 * grants anything.
 */
var EntryPaymentStatus;
(function (EntryPaymentStatus) {
  EntryPaymentStatus['INITIATED'] = 'INITIATED';
  EntryPaymentStatus['SUCCEEDED'] = 'SUCCEEDED';
  EntryPaymentStatus['FAILED'] = 'FAILED';
  EntryPaymentStatus['EXPIRED'] = 'EXPIRED';
})(EntryPaymentStatus || (EntryPaymentStatus = {}));
/** Set (never cleared) when server-side verification disagreed with the server-owned payment. */
var PaymentReconciliationFlag;
(function (PaymentReconciliationFlag) {
  PaymentReconciliationFlag['AMOUNT_MISMATCH'] = 'AMOUNT_MISMATCH';
  PaymentReconciliationFlag['CURRENCY_MISMATCH'] = 'CURRENCY_MISMATCH';
  PaymentReconciliationFlag['REFERENCE_MISMATCH'] = 'REFERENCE_MISMATCH';
  PaymentReconciliationFlag['CONFIRMED_AFTER_FAILURE'] = 'CONFIRMED_AFTER_FAILURE';
  /** The provider reported success for an attempt the server had already EXPIRED locally. Nothing is granted. */
  PaymentReconciliationFlag['CONFIRMED_AFTER_EXPIRY'] = 'CONFIRMED_AFTER_EXPIRY';
})(PaymentReconciliationFlag || (PaymentReconciliationFlag = {}));
/** The business purpose stamped immutably on each payment. */
var PaymentPurpose;
(function (PaymentPurpose) {
  PaymentPurpose['MANAGED_MARKETING'] = 'MANAGED_MARKETING';
})(PaymentPurpose || (PaymentPurpose = {}));
/** Shared payment attempt state machine. */
const PaymentAttemptStatus = EntryPaymentStatus;

Object.assign(exports, {
  EntryPaymentStatus,
  PaymentReconciliationFlag,
  PaymentPurpose,
  PaymentAttemptStatus,
});
