import { PaymentReconciliationFlag, VerifiedProviderOutcome } from './payment.types';

/** What to do with a provider's verified answer about a payment attempt that is still INITIATED. */
export type OutcomeDecision =
  | { kind: 'PENDING' }
  | { kind: 'FAILED' }
  | { kind: 'SUCCEEDED' }
  | { kind: 'MISMATCH'; flag: PaymentReconciliationFlag };

/**
 * The purpose-independent verification rules, shared by both payment purposes.
 * The expected values always come from the SERVER-owned payment row (itself
 * copied from an authoritative snapshot), never from the caller or the
 * provider. Success is granted only when reference, currency and amount all
 * match exactly. Pure: no I/O, no business effect.
 */
export function decideOutcome(
  expected: { providerReference?: string; amountMinor: number; currency: string },
  outcome: VerifiedProviderOutcome,
): OutcomeDecision {
  if (outcome.providerReference !== expected.providerReference) return { kind: 'MISMATCH', flag: PaymentReconciliationFlag.REFERENCE_MISMATCH };
  if (outcome.status === 'PENDING') return { kind: 'PENDING' };
  if (outcome.status === 'FAILED') return { kind: 'FAILED' };
  if (outcome.currency !== expected.currency) return { kind: 'MISMATCH', flag: PaymentReconciliationFlag.CURRENCY_MISMATCH };
  if (outcome.amountMinor !== expected.amountMinor) return { kind: 'MISMATCH', flag: PaymentReconciliationFlag.AMOUNT_MISMATCH };
  return { kind: 'SUCCEEDED' };
}
