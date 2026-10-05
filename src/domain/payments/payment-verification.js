'use strict';

const { PaymentReconciliationFlag } = require('./payment.types');
/**
 * The purpose-independent verification rules, shared by both payment purposes.
 * The expected values always come from the SERVER-owned payment row (itself
 * copied from an authoritative snapshot), never from the caller or the
 * provider. Success is granted only when reference, currency and amount all
 * match exactly. Pure: no I/O, no business effect.
 */
function decideOutcome(expected, outcome) {
  if (outcome.providerReference !== expected.providerReference)
    return { kind: 'MISMATCH', flag: PaymentReconciliationFlag.REFERENCE_MISMATCH };
  if (outcome.status === 'PENDING') return { kind: 'PENDING' };
  if (outcome.status === 'FAILED') return { kind: 'FAILED' };
  if (outcome.currency !== expected.currency)
    return { kind: 'MISMATCH', flag: PaymentReconciliationFlag.CURRENCY_MISMATCH };
  if (outcome.amountMinor !== expected.amountMinor)
    return { kind: 'MISMATCH', flag: PaymentReconciliationFlag.AMOUNT_MISMATCH };
  return { kind: 'SUCCEEDED' };
}

Object.assign(exports, { decideOutcome });
