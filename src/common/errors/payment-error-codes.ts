export enum PaymentErrorCode {
  /** The auction has no admin-configured entry fee: paid bidding fails closed (never treated as free). */
  ENTRY_FEE_NOT_CONFIGURED = 'PAYMENT_ENTRY_FEE_NOT_CONFIGURED',
  /** An entry fee was already configured for this auction; it is write-once. */
  ENTRY_FEE_ALREADY_CONFIGURED = 'PAYMENT_ENTRY_FEE_ALREADY_CONFIGURED',
  /** The fee amount is not a non-negative integer within the platform money bounds (0 = explicitly FREE). */
  ENTRY_FEE_INVALID = 'PAYMENT_ENTRY_FEE_INVALID',
  /** The auction can no longer accept entry payments (ended, cancelled, completed). */
  AUCTION_NOT_PAYABLE = 'PAYMENT_AUCTION_NOT_PAYABLE',
  /** This bidder already holds an entitlement / a succeeded payment for this auction. */
  ALREADY_PAID = 'PAYMENT_ALREADY_PAID',
  NOT_FOUND = 'PAYMENT_NOT_FOUND',
  /** No payment provider is configured: production fails closed. */
  PROVIDER_UNAVAILABLE = 'PAYMENT_PROVIDER_UNAVAILABLE',
  /** The provider's verified amount, currency or reference disagrees with the server-owned payment; nothing is granted. */
  VERIFICATION_MISMATCH = 'PAYMENT_VERIFICATION_MISMATCH',
  /** The provider reported success for a payment the server had already recorded as failed; needs manual reconciliation. */
  CONFIRMED_AFTER_FAILURE = 'PAYMENT_CONFIRMED_AFTER_FAILURE',
  /** Concurrent confirmation kept invalidating the attempt; safe to retry. */
  RETRY_EXHAUSTED = 'PAYMENT_RETRY_EXHAUSTED',
  /** Persistent state disagrees with itself (e.g. entitlement/payment mismatch); never retried. */
  STATE_INCONSISTENT = 'PAYMENT_STATE_INCONSISTENT',
  /** The managed-marketing request is not in a payable state (not approved, cancelled, or already paid). */
  REQUEST_NOT_PAYABLE = 'PAYMENT_REQUEST_NOT_PAYABLE',
  /** The request is parked for operator reconciliation; no further payment action is accepted automatically. */
  RECONCILIATION_REQUIRED = 'PAYMENT_RECONCILIATION_REQUIRED',
  /** MAZAD-035: the auction's configured entry fee is explicitly 0 (FREE auction); there is nothing to pay. */
  NOT_REQUIRED = 'PAYMENT_NOT_REQUIRED',
}
