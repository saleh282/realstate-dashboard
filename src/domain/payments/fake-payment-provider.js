'use strict';

const { ServiceUnavailableException } = require('../../common/http/errors');
const { randomUUID } = require('crypto');
const { PaymentErrorCode } = require('../../common/errors/payment-error-codes');
/**
 * Deterministic payment provider for LOCAL / DEVELOPMENT / TEST only, so the
 * whole payment lifecycle can be exercised before a real gateway is chosen.
 *
 * It implements the existing port unchanged and holds no credentials. The
 * scenario is never taken from a client or from the payment amount: it comes
 * from the server-side default (`FAKE_PAYMENT_SCENARIO`) or from an explicit
 * per-call queue that only code holding this instance (tests) can fill.
 * `settle` resolves a PENDING reference. The reference encodes the amount and
 * currency it was opened with, so `verify` needs no in-memory state and stays
 * correct across a process restart. The module refuses to build this class in
 * staging/production (see PaymentsModule).
 */
class FakePaymentProvider {
  constructor(defaultScenario = 'success') {
    this.defaultScenario = defaultScenario;
    this.providerKey = 'fake';
    this.configured = true;
    this.queue = [];
    this.settlements = new Map();
    this.verifyFailures = 0;
    this.calls = { initiate: 0, verify: 0 };
  }
  /** The next `initiate` calls use these scenarios, in order, before falling back to the default. */
  enqueue(...scenarios) {
    this.queue.push(...scenarios);
  }
  /** Resolve a PENDING payment to a terminal outcome for its next `verify`. */
  settle(providerReference, outcome) {
    this.settlements.set(providerReference, outcome);
  }
  /** True for a reference THIS provider issued in the `pending` scenario: the only kind `settle` can resolve. */
  isSettleable(providerReference) {
    const [prefix, scenario] = providerReference.split('~');
    return prefix === 'fake' && scenario === 'pending';
  }
  /** Make the next `count` verify calls throw, simulating a gateway outage during reconciliation. */
  failNextVerifications(count = 1) {
    this.verifyFailures += count;
  }
  reset() {
    this.queue.length = 0;
    this.settlements.clear();
    this.verifyFailures = 0;
    this.calls.initiate = 0;
    this.calls.verify = 0;
  }
  async initiate(request) {
    this.calls.initiate += 1;
    const scenario = this.queue.shift() ?? this.defaultScenario;
    if (scenario === 'error') throw this.unavailable();
    const providerReference = [
      'fake',
      scenario,
      request.amountMinor,
      request.currency,
      request.paymentId,
      randomUUID().slice(0, 8),
    ].join('~');
    return { providerReference, clientHandoff: `fake://checkout/${providerReference}` };
  }
  async verify(providerReference) {
    this.calls.verify += 1;
    if (this.verifyFailures > 0) {
      this.verifyFailures -= 1;
      throw this.unavailable();
    }
    const [prefix, scenario, amount, currency] = providerReference.split('~');
    const amountMinor = Number(amount);
    if (prefix !== 'fake' || !Number.isSafeInteger(amountMinor) || !currency)
      throw this.unavailable();
    const base = {
      providerReference,
      amountMinor,
      currency,
      providerEventId: `fake-event-${providerReference.slice(-8)}`,
    };
    const effective =
      scenario === 'pending' ? (this.settlements.get(providerReference) ?? 'pending') : scenario;
    if (effective === 'success') return { ...base, status: 'SUCCEEDED' };
    if (effective === 'failed') return { ...base, status: 'FAILED', failureCode: 'FAKE_DECLINED' };
    return { ...base, status: 'PENDING' };
  }
  unavailable() {
    return new ServiceUnavailableException({
      message: 'خدمة الدفع غير متاحة حالياً',
      code: PaymentErrorCode.PROVIDER_UNAVAILABLE,
    });
  }
}

Object.assign(exports, { FakePaymentProvider });
