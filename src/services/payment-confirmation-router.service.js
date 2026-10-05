'use strict';

const { NotFoundException } = require('../common/http/errors');
const { PaymentErrorCode } = require('../common/errors/payment-error-codes');
const { PaymentPurpose } = require('../domain/payments/payment.types');
/**
 * The one internal entry point a TRIGGER uses (MAZAD-028): a provider callback
 * adapter, the reconciliation worker, or the development settle route.
 *
 * A trigger names a payment — by `(provider, providerReference)` or by id —
 * and NOTHING ELSE: there is no parameter for an outcome, an amount or a
 * status. The router resolves which purpose owns the payment and hands it to
 * that purpose's confirmation service, which asks the provider itself. The owning confirmation service fulfils it.
 *
 * No public route exposes this; a real provider's signed-webhook route is part
 * of the provider integration ticket and will call `confirmByProviderReference`
 * after its adapter authenticated the callback.
 */
class PaymentConfirmationRouter {
  constructor(marketingPayments, managedMarketing) {
    this.marketingPayments = marketingPayments;
    this.managedMarketing = managedMarketing;
  }
  /** Every purpose the shared lifecycle covers, with its own collection. */
  purposes() {
    return [
      {
        purpose: PaymentPurpose.MANAGED_MARKETING,
        lifecycle: this.managedMarketing,
        payments: this.marketingPayments,
      },
    ];
  }
  /** Verifies and applies the payment that owns this provider reference. The caller supplies no outcome. */
  async confirmByProviderReference(provider, providerReference) {
    if (
      typeof provider !== 'string' ||
      typeof providerReference !== 'string' ||
      !provider ||
      !providerReference
    )
      throw this.notFound();
    for (const routed of this.purposes()) {
      // Served by the unique (provider, providerReference) index of each collection.
      const payment = await routed.payments
        .findOne({ provider, providerReference })
        .select('_id')
        .lean()
        .exec();
      if (!payment) continue;
      const paymentId = payment._id.toString();
      const result = await routed.lifecycle.confirm(paymentId);
      return { purpose: routed.purpose, paymentId, status: result.status, pending: result.pending };
    }
    throw this.notFound();
  }
  notFound() {
    return new NotFoundException({
      message: 'عملية الدفع غير موجودة',
      code: PaymentErrorCode.NOT_FOUND,
    });
  }
}

Object.assign(exports, { PaymentConfirmationRouter });
