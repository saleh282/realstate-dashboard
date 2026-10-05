'use strict';

const { ConflictException, HttpException, NotFoundException } = require('../common/http/errors');
const { Types } = require('mongoose');
const { PaymentErrorCode } = require('../common/errors/payment-error-codes');
const { FakePaymentProvider } = require('../domain/payments/fake-payment-provider');
const { PaymentPurpose } = require('../domain/payments/payment.types');
const OWNER_FIELD = {
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
class FakePaymentsDevService {
  constructor(router, provider) {
    this.router = router;
    this.provider = provider;
  }
  async settle(actorId, paymentId, outcome, trigger) {
    const fake = this.provider;
    if (!(fake instanceof FakePaymentProvider)) throw this.notFound();
    if (!Types.ObjectId.isValid(paymentId) || !Types.ObjectId.isValid(actorId))
      throw this.notFound();
    for (const routed of this.router.purposes()) {
      // Owner-scoped: someone else's payment is indistinguishable from a missing one.
      const payment = await routed.payments
        .findOne({
          _id: new Types.ObjectId(paymentId),
          [OWNER_FIELD[routed.purpose]]: new Types.ObjectId(actorId),
        })
        .select('provider providerReference')
        .lean()
        .exec();
      if (!payment) continue;
      if (payment.provider !== fake.providerKey || !payment.providerReference) {
        throw new ConflictException({
          message: 'عملية الدفع لم تُفتح لدى مزود الدفع التجريبي',
          code: PaymentErrorCode.STATE_INCONSISTENT,
        });
      }
      if (!fake.isSettleable(payment.providerReference)) {
        throw new ConflictException({
          message: 'مزود الدفع التجريبي حسم هذه العملية مسبقاً',
          code: 'FAKE_PAYMENT_NOT_PENDING',
        });
      }
      fake.settle(payment.providerReference, outcome);
      const result = {
        settled: true,
        paymentId,
        purpose: routed.purpose,
        outcome,
        triggered: trigger,
      };
      if (trigger)
        result.confirmation = await this.trigger(fake.providerKey, payment.providerReference);
      return result;
    }
    throw this.notFound();
  }
  /** Exactly what a provider callback does: name the reference, let the server verify. No outcome is passed. */
  async trigger(provider, providerReference) {
    try {
      const confirmed = await this.router.confirmByProviderReference(provider, providerReference);
      return { status: confirmed.status, pending: confirmed.pending };
    } catch (error) {
      const code = error instanceof HttpException ? error.getResponse()?.code : undefined;
      if (typeof code === 'string') return { rejectedCode: code };
      throw error;
    }
  }
  notFound() {
    return new NotFoundException({
      message: 'عملية الدفع غير موجودة',
      code: PaymentErrorCode.NOT_FOUND,
    });
  }
}

Object.assign(exports, { FakePaymentsDevService });
