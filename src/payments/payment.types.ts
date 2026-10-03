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

export enum EntryPaymentStatus {
  INITIATED = 'INITIATED',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED'
}

/** Set (never cleared) when server-side verification disagreed with the server-owned payment. */
export enum PaymentReconciliationFlag {
  AMOUNT_MISMATCH = 'AMOUNT_MISMATCH',
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',
  REFERENCE_MISMATCH = 'REFERENCE_MISMATCH',
  CONFIRMED_AFTER_FAILURE = 'CONFIRMED_AFTER_FAILURE',
  /** The provider reported success for an attempt the server had already EXPIRED locally. Nothing is granted. */
  CONFIRMED_AFTER_EXPIRY = 'CONFIRMED_AFTER_EXPIRY'
}

/** What the provider, asked server-to-server, says about one payment. Produced ONLY by the provider port. */
export type VerifiedProviderOutcome = {
  status: 'SUCCEEDED' | 'FAILED' | 'PENDING';
  providerReference: string;
  amountMinor: number;
  currency: string;
  /** Provider's own event/transaction id, kept for reconciliation (never a secret, never the raw payload). */
  providerEventId?: string;
  failureCode?: string;
};

/** The business purpose stamped immutably on each payment. */
export enum PaymentPurpose {
  MANAGED_MARKETING = 'MANAGED_MARKETING'
}

/** Shared payment attempt state machine. */
export const PaymentAttemptStatus = EntryPaymentStatus;
export type PaymentAttemptStatus = EntryPaymentStatus;
