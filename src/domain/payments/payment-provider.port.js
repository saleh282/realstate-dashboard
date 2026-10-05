'use strict';

const { ServiceUnavailableException } = require('../../common/http/errors');
const { PaymentErrorCode } = require('../../common/errors/payment-error-codes');
const PAYMENT_PROVIDER_PORT = Symbol('PAYMENT_PROVIDER_PORT');
/** Production default until a real gateway adapter is bound: fail closed. Pretends nothing. */
class UnconfiguredPaymentProvider {
  constructor() {
    this.providerKey = 'unconfigured';
    this.configured = false;
  }
  async initiate() {
    throw this.unavailable();
  }
  async verify() {
    throw this.unavailable();
  }
  unavailable() {
    return new ServiceUnavailableException({
      message: 'خدمة الدفع غير متاحة حالياً',
      code: PaymentErrorCode.PROVIDER_UNAVAILABLE,
    });
  }
}

Object.assign(exports, { PAYMENT_PROVIDER_PORT, UnconfiguredPaymentProvider });
