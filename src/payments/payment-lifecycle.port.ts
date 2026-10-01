import { EntryPaymentStatus, PaymentPurpose } from './payment.types';

/**
 * What the shared payment lifecycle (confirmation routing, reconciliation
 * worker, expiry) needs from ONE payment purpose. The purpose-specific
 * fulfilment (auction entitlement, managed-marketing PAID) stays inside the
 * purpose's own confirmation service; nothing here carries a business effect.
 *
 * None of these methods accepts an outcome: `confirm` asks the provider itself.
 */
export interface PaymentLifecyclePort {
  readonly purpose: PaymentPurpose;
  /** Server-to-server verification + the purpose's authoritative transition. Throws on a provider outage or a flagged disagreement. */
  confirm(paymentId: string): Promise<{ status: EntryPaymentStatus; pending: boolean }>;
  /** INITIATED → EXPIRED (terminal). False when the attempt was no longer an unflagged INITIATED one. */
  expire(paymentId: string): Promise<boolean>;
  /** Fails an INITIATED attempt that never received a provider reference. False when it gained one meanwhile. */
  failAbandoned(paymentId: string): Promise<boolean>;
}
