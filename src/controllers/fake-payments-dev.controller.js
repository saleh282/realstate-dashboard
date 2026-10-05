'use strict';

const { IsBoolean, IsIn, IsOptional } = require('class-validator');
class SettleFakePaymentDto {}
IsIn(['success', 'failed'])(SettleFakePaymentDto.prototype, 'outcome');
IsBoolean()(SettleFakePaymentDto.prototype, 'trigger');
IsOptional()(SettleFakePaymentDto.prototype, 'trigger');
/**
 * DEVELOPMENT ONLY (MAZAD-028): `POST /dev/fake-payments/:paymentId/settle`.
 *
 * Simulates the customer finishing a `pending` FakePaymentProvider checkout.
 * `FakePaymentsDevGuard` runs first and answers 404 unless this is a
 * local/development process running the fake provider, so the route does not
 * exist in staging/production (where the fake provider cannot even be built).
 * Authenticated and owner-scoped; it changes provider truth only and can never
 * grant an entitlement or mark anything paid.
 */
class FakePaymentsDevController {
  constructor(settlement) {
    this.settlement = settlement;
  }
  settle(req, paymentId, body) {
    return this.settlement.settle(req.user.userId, paymentId, body.outcome, body.trigger === true);
  }
}

Object.assign(exports, { SettleFakePaymentDto, FakePaymentsDevController });
