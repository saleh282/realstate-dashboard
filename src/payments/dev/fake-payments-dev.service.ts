import { ConflictException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PaymentErrorCode } from '../../common/errors/payment-error-codes';
import { AUCTION_PAYMENT_PROVIDER_PORT, AuctionPaymentProviderPort } from '../auction-payment-provider.port';
import { FakePaymentProvider } from '../fake-payment-provider';
import { PaymentConfirmationRouter } from '../payment-confirmation-router.service';
import { EntryPaymentStatus, PaymentPurpose } from '../payment.types';

export type FakeSettlementResult = {
  settled: true;
  paymentId: string;
  purpose: PaymentPurpose;
  outcome: 'success' | 'failed';
  triggered: boolean;
  /** Present only with `trigger: true`: what the NORMAL confirmation path answered. */
  confirmation?: { status: EntryPaymentStatus; pending: boolean } | { rejectedCode: string };
};

const OWNER_FIELD: Record<PaymentPurpose, string> = {
  [PaymentPurpose.AUCTION_ENTRY]: 'bidderAccountId',
  [PaymentPurpose.MANAGED_MARKETING]: 'advertiserAccountId',
};

/**
 * Development stand-in for "the customer completed (or abandoned) the checkout
 * at the provider". It changes the FAKE PROVIDER'S TRUTH and nothing else: it
 * never writes a payment, an entitlement or a request. The payment only moves
 * when the normal confirmation path (reconciliation worker, or the optional
 * `trigger`, which is the same `confirmByProviderReference` a real callback
 * would use) asks the provider and applies the answer through the domain rules.
 */
@Injectable()
export class FakePaymentsDevService {
  constructor(
    private readonly router: PaymentConfirmationRouter,
    @Inject(AUCTION_PAYMENT_PROVIDER_PORT) private readonly provider: AuctionPaymentProviderPort,
  ) {}

  async settle(actorId: string, paymentId: string, outcome: 'success' | 'failed', trigger: boolean): Promise<FakeSettlementResult> {
    const fake = this.provider;
    if (!(fake instanceof FakePaymentProvider)) throw this.notFound();
    if (!Types.ObjectId.isValid(paymentId) || !Types.ObjectId.isValid(actorId)) throw this.notFound();

    for (const routed of this.router.purposes()) {
      // Owner-scoped: someone else's payment is indistinguishable from a missing one.
      const payment: any = await routed.payments
        .findOne({ _id: new Types.ObjectId(paymentId), [OWNER_FIELD[routed.purpose]]: new Types.ObjectId(actorId) })
        .select('provider providerReference')
        .lean()
        .exec();
      if (!payment) continue;
      if (payment.provider !== fake.providerKey || !payment.providerReference) {
        throw new ConflictException({ message: 'عملية الدفع لم تُفتح لدى مزود الدفع التجريبي', code: PaymentErrorCode.STATE_INCONSISTENT });
      }
      if (!fake.isSettleable(payment.providerReference)) {
        throw new ConflictException({ message: 'مزود الدفع التجريبي حسم هذه العملية مسبقاً', code: 'FAKE_PAYMENT_NOT_PENDING' });
      }
      fake.settle(payment.providerReference, outcome);
      const result: FakeSettlementResult = { settled: true, paymentId, purpose: routed.purpose, outcome, triggered: trigger };
      if (trigger) result.confirmation = await this.trigger(fake.providerKey, payment.providerReference);
      return result;
    }
    throw this.notFound();
  }

  /** Exactly what a provider callback does: name the reference, let the server verify. No outcome is passed. */
  private async trigger(provider: string, providerReference: string): Promise<NonNullable<FakeSettlementResult['confirmation']>> {
    try {
      const confirmed = await this.router.confirmByProviderReference(provider, providerReference);
      return { status: confirmed.status, pending: confirmed.pending };
    } catch (error) {
      const code = error instanceof HttpException ? (error.getResponse() as any)?.code : undefined;
      if (typeof code === 'string') return { rejectedCode: code };
      throw error;
    }
  }

  private notFound() {
    return new NotFoundException({ message: 'عملية الدفع غير موجودة', code: PaymentErrorCode.NOT_FOUND });
  }
}
