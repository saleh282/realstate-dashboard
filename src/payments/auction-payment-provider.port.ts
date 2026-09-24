import { ServiceUnavailableException, Injectable } from '@nestjs/common';
import { PaymentErrorCode } from '../common/errors/payment-error-codes';
import { PaymentPurpose, VerifiedProviderOutcome } from './payment.types';

/**
 * The minimal, provider-neutral seam a future payment gateway adapter fills
 * (no gateway is selected or integrated in MAZAD-028). Shared by both payment
 * purposes (AUCTION_ENTRY, MANAGED_MARKETING); the purpose is passed so an
 * adapter can tag the gateway order, but the port carries no business effect.
 *
 * Contract for an adapter:
 *  - `initiate` opens a payment with the gateway for the SERVER-owned amount
 *    and returns the gateway's reference (plus an opaque client hand-off such
 *    as a redirect URL, which is presentation only and never proof of payment);
 *  - `verify` asks the gateway server-to-server what happened to a reference.
 *    The adapter authenticates the gateway (webhook signature, API credential)
 *    itself; a request merely reaching an endpoint proves nothing. Inbound
 *    callbacks are treated only as a *trigger* to call `verify`;
 *  - it must never return or log card data, credentials or raw payloads.
 * Reconciliation of uncertain payments is `verify` called again later.
 */
export interface AuctionPaymentProviderPort {
  /** Stable, non-secret identifier stored on each payment (e.g. an adapter name). */
  readonly providerKey: string;
  /** False when no gateway is configured: initiation and verification then fail closed. */
  readonly configured: boolean;
  initiate(request: { purpose: PaymentPurpose; paymentId: string; amountMinor: number; currency: string }): Promise<{ providerReference: string; clientHandoff?: string }>;
  verify(providerReference: string): Promise<VerifiedProviderOutcome>;
}

export const AUCTION_PAYMENT_PROVIDER_PORT = Symbol('AUCTION_PAYMENT_PROVIDER_PORT');

/** Production default until a real gateway adapter is bound: fail closed. Pretends nothing. */
@Injectable()
export class UnconfiguredPaymentProvider implements AuctionPaymentProviderPort {
  readonly providerKey = 'unconfigured';
  readonly configured = false;

  async initiate(): Promise<never> { throw this.unavailable(); }
  async verify(): Promise<never> { throw this.unavailable(); }

  private unavailable() {
    return new ServiceUnavailableException({
      message: 'خدمة الدفع غير متاحة حالياً',
      code: PaymentErrorCode.PROVIDER_UNAVAILABLE,
    });
  }
}
