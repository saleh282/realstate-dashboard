'use strict';

class ManagedMarketingController {
  constructor(service, payments, clock) {
    this.service = service;
    this.payments = payments;
    this.clock = clock;
  }
  listPackages() {
    return this.service.listActivePackages();
  }
  mine(req) {
    return this.service.listMine(req.user.userId);
  }
  create(req, dto) {
    return this.service.createRequest(req.user.userId, dto, req.ip);
  }
  cancel(req, id, dto) {
    return this.service.cancel(req.user.userId, id, dto.reason, req.ip);
  }
  /**
   * MAZAD-028: opens (or returns) the payment attempt of the caller's OWN Admin-approved request. The body is EMPTY:
   * the amount is the request's immutable package snapshot price and the payer is the authenticated account. Initiating
   * grants nothing — the request becomes PAID only through server-side confirmation of a provider-verified outcome, and
   * there is no route that confirms a payment.
   */
  async pay(req, id, _body) {
    const payment = await this.payments.initiate(req.user.userId, id, req.ip);
    return {
      message: payment.reused ? 'محاولة الدفع قائمة بالفعل' : 'تم بدء عملية الدفع',
      payment: {
        paymentId: payment.paymentId,
        requestId: payment.requestId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        status: payment.status,
        clientHandoff: payment.clientHandoff ?? null,
        reused: payment.reused,
      },
      serverTime: this.clock.now(),
    };
  }
}

Object.assign(exports, { ManagedMarketingController });
