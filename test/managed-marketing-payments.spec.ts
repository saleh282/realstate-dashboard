import { ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';
import { SystemRole } from '../src/auth/roles.enum';


import { PaymentErrorCode } from '../src/common/errors/payment-error-codes';
import { ManagedMarketingPaymentStatus, ManagedMarketingRequestStatus } from '../src/managed-marketing/managed-marketing.types';
import { ManagedMarketingService } from '../src/managed-marketing/managed-marketing.service';
import { PaymentProviderPort } from '../src/payments/payment-provider.port';
import { ManagedMarketingPaymentConfirmationService } from '../src/payments/managed-marketing-payment-confirmation.service';
import { ManagedMarketingPaymentService } from '../src/payments/managed-marketing-payment.service';
import { EntryPaymentStatus, PaymentPurpose, PaymentReconciliationFlag, VerifiedProviderOutcome } from '../src/payments/payment.types';


import { FakeMongo } from './support/fake-payments-mongo';

/**
 * MAZAD-028 completion — the MANAGED_MARKETING payment purpose, its isolation
 * from AUCTION_ENTRY, and the dedicated Admin fee capability. In-memory Mongo
 * MODEL (see support/fake-payments-mongo.ts); real-Mongo qualification remains.
 */
const oid = (hex: string) => new Types.ObjectId(hex);
const ADVERTISER = '64b000000000000000000a10';
const OWNER = '64b000000000000000000a11';
const OTHER = '64b000000000000000000a12';
const ADMIN = '64b000000000000000000a20';
const REQUEST = '64b000000000000000000c01';
const PRICE = 1_500_000; // test data only — a made-up fixture, not a product price

function fakeProvider(overrides: Partial<PaymentProviderPort> = {}) {
  const state: { outcome: (ref: string) => VerifiedProviderOutcome; initiateCalls: any[]; verifyCalls: string[]; expectAmount: number } = {
    outcome: (ref) => ({ status: 'PENDING', providerReference: ref, amountMinor: PRICE, currency: 'EGP' }),
    initiateCalls: [], verifyCalls: [], expectAmount: PRICE,
  };
  let n = 0;
  const provider: PaymentProviderPort = {
    providerKey: 'fake-test-provider', configured: true,
    initiate: async (r) => { state.initiateCalls.push(r); return { providerReference: `ref-${++n}` }; },
    verify: async (ref) => { state.verifyCalls.push(ref); return state.outcome(ref); },
    ...overrides,
  };
  return { provider, state };
}

function build(requestOverrides: Record<string, unknown> = {}, providerOverrides: Partial<PaymentProviderPort> = {}) {
  const mongo = new FakeMongo();
  for (const id of [ADVERTISER, OWNER, OTHER]) mongo.seedUser(id);
  mongo.seedUser(ADMIN, { systemRole: SystemRole.ADMIN });
  const request = {
    _id: oid(REQUEST), propertyId: oid('64b000000000000000000b01'), propertyRevisionId: oid('64b000000000000000000b02'),
    advertiserAccountId: oid(OWNER), status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: ManagedMarketingPaymentStatus.AWAITING_PAYMENT,
    packageSnapshot: { packageId: oid('64b000000000000000000d01'), code: 'any-tier', priceMinor: PRICE, currency: 'EGP' }, ...requestOverrides,
  };
  mongo.data.requests.set(REQUEST, { doc: request, version: 1 });
  const { provider, state } = fakeProvider(providerOverrides);
  const clock = { now: () => mongo.clockNow };
  const deps = {
    users: mongo.model('users'),
    requests: mongo.model('requests'), audit: mongo.auditSvc, clock, provider, connection: mongo.connection, outbox: mongo.outbox.service,
  };
  // The managed-marketing payments model is the 'mmPayments' collection.
  const mmDeps = { ...deps, payments: mongo.model('mmPayments') };
  const initiation = Object.assign(Object.create(ManagedMarketingPaymentService.prototype), mmDeps) as ManagedMarketingPaymentService;
  const confirmation = Object.assign(Object.create(ManagedMarketingPaymentConfirmationService.prototype), mmDeps) as ManagedMarketingPaymentConfirmationService;
  const marketing = Object.assign(Object.create(ManagedMarketingService.prototype), { requests: mongo.model('requests'), audit: { logResourceAction: jest.fn(async () => undefined) } }) as ManagedMarketingService;
  const succeed = (amountMinor = PRICE, currency = 'EGP') => { state.outcome = (ref) => ({ status: 'SUCCEEDED', providerReference: ref, amountMinor, currency, providerEventId: 'evt-mm' }); };
  return { mongo, initiation, confirmation, marketing, provider, state, succeed };
}
const request = (mongo: FakeMongo) => mongo.data.requests.get(REQUEST)!.doc;
async function codeOf(action: () => Promise<unknown>): Promise<string | undefined> {
  try { await action(); return undefined; } catch (error) { return (error as any).getResponse?.()?.code; }
}

describe('MANAGED_MARKETING payment initiation (MAZAD-028)', () => {
  it('uses the immutable package-snapshot price; the caller cannot supply an amount', async () => {
    const { mongo, initiation, state } = build();
    expect(ManagedMarketingPaymentService.prototype.initiate.length).toBeLessThanOrEqual(3); // (actorId, requestId, ip?)
    const r = await initiation.initiate(OWNER, REQUEST);
    expect(r).toMatchObject({ amountMinor: PRICE, currency: 'EGP', status: EntryPaymentStatus.INITIATED, providerReference: 'ref-1', reused: false });
    expect(state.initiateCalls[0]).toMatchObject({ purpose: PaymentPurpose.MANAGED_MARKETING, amountMinor: PRICE, currency: 'EGP' });
    expect(mongo.rows('mmPayments')[0]).toMatchObject({ amountMinor: PRICE, requestId: oid(REQUEST), isLive: true, provider: 'fake-test-provider' });
    expect(request(mongo).paymentStatus).toBe(ManagedMarketingPaymentStatus.PENDING);
    expect(mongo.audits.map((a) => a.action)).toContain(AuditAction.MANAGED_MARKETING_PAYMENT_INITIATED);
  });

  it.each([
    [ManagedMarketingRequestStatus.PENDING_REVIEW, ManagedMarketingPaymentStatus.NOT_ELIGIBLE],
    [ManagedMarketingRequestStatus.REJECTED, ManagedMarketingPaymentStatus.NOT_ELIGIBLE],
    [ManagedMarketingRequestStatus.CANCELLED, ManagedMarketingPaymentStatus.AWAITING_PAYMENT],
    [ManagedMarketingRequestStatus.APPROVED, ManagedMarketingPaymentStatus.NOT_ELIGIBLE],
  ])('refuses a %s request with payment status %s (Admin must approve first)', async (status, paymentStatus) => {
    const { mongo, initiation } = build({ status, paymentStatus });
    expect(await codeOf(() => initiation.initiate(OWNER, REQUEST))).toBe(PaymentErrorCode.REQUEST_NOT_PAYABLE);
    expect(mongo.rows('mmPayments')).toHaveLength(0);
  });

  it("someone else's request looks like a missing one (IDOR); admin and other users cannot pay", async () => {
    const { mongo, initiation } = build();
    expect(await codeOf(() => initiation.initiate(OTHER, REQUEST))).toBe(PaymentErrorCode.NOT_FOUND);
    expect(await codeOf(() => initiation.initiate(ADMIN, REQUEST))).toBe(PaymentErrorCode.NOT_FOUND);
    expect(mongo.rows('mmPayments')).toHaveLength(0);
  });

  it('re-initiating while pending returns the same attempt; concurrent initiations converge', async () => {
    const { mongo, initiation, state } = build();
    const results = await Promise.all([1, 2, 3, 4].map(() => initiation.initiate(OWNER, REQUEST)));
    expect(new Set(results.map((r) => r.paymentId)).size).toBe(1);
    expect(mongo.rows('mmPayments')).toHaveLength(1);
    expect(state.initiateCalls.length).toBeGreaterThanOrEqual(1);
    expect((await initiation.initiate(OWNER, REQUEST)).reused).toBe(true);
  });

  it('fails closed with no configured provider', async () => {
    const { mongo, initiation } = build({}, { configured: false });
    await expect(initiation.initiate(OWNER, REQUEST)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(mongo.rows('mmPayments')).toHaveLength(0);
    expect(request(mongo).paymentStatus).toBe(ManagedMarketingPaymentStatus.AWAITING_PAYMENT);
  });

  it('a provider failure while opening fails the attempt and returns the request to a payable, cancellable state', async () => {
    const { mongo, initiation, provider, marketing } = build();
    const original = provider.initiate;
    provider.initiate = async () => { throw new Error('gateway down'); };
    await expect(initiation.initiate(OWNER, REQUEST)).rejects.toThrow('gateway down');
    expect(mongo.rows('mmPayments')[0]).toMatchObject({ status: EntryPaymentStatus.FAILED });
    expect(request(mongo).paymentStatus).toBe(ManagedMarketingPaymentStatus.FAILED);
    provider.initiate = original;
    expect((await initiation.initiate(OWNER, REQUEST)).reused).toBe(false);
    void marketing;
  });
});

describe('MANAGED_MARKETING server-confirmed success (MAZAD-028)', () => {
  async function pending() { const ctx = build(); const a = await ctx.initiation.initiate(OWNER, REQUEST); return { ...ctx, paymentId: a.paymentId }; }

  it('a pending payment does not begin fulfillment', async () => {
    const ctx = await pending();
    expect(await ctx.confirmation.confirm(ctx.paymentId)).toMatchObject({ pending: true, requestPaid: false });
    expect(request(ctx.mongo)).toMatchObject({ status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: ManagedMarketingPaymentStatus.PENDING });
    expect(request(ctx.mongo).paidAt).toBeUndefined();
  });

  it('a failed payment does not begin fulfillment and leaves the request payable/cancellable', async () => {
    const ctx = await pending();
    ctx.state.outcome = (ref) => ({ status: 'FAILED', providerReference: ref, amountMinor: PRICE, currency: 'EGP', failureCode: 'DECLINED' });
    expect(await ctx.confirmation.confirm(ctx.paymentId)).toMatchObject({ status: EntryPaymentStatus.FAILED, requestPaid: false });
    expect(request(ctx.mongo)).toMatchObject({ status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: ManagedMarketingPaymentStatus.FAILED });
    expect(request(ctx.mongo).paidAt).toBeUndefined();
    expect((await ctx.initiation.initiate(OWNER, REQUEST)).reused).toBe(false); // retry allowed
  });

  it('confirmed success applies exactly the PAID effect — and invents no schedule/SLA fields', async () => {
    const ctx = await pending(); ctx.succeed();
    const before = { ...request(ctx.mongo) };
    const r = await ctx.confirmation.confirm(ctx.paymentId);
    expect(r).toMatchObject({ status: EntryPaymentStatus.SUCCEEDED, requestPaid: true, alreadyProcessed: false });
    const after = request(ctx.mongo);
    expect(after).toMatchObject({ status: ManagedMarketingRequestStatus.PAID, paymentStatus: ManagedMarketingPaymentStatus.SUCCEEDED, paidAt: ctx.mongo.clockNow });
    expect(String(after.paidPaymentId)).toBe(ctx.paymentId);
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify((before as any)[k])).sort();
    expect(changed).toEqual(['paidAt', 'paidPaymentId', 'paymentStatus', 'status']); // nothing else, in particular no dates/SLA
    expect(ctx.mongo.rows('mmPayments')[0]).toMatchObject({ status: EntryPaymentStatus.SUCCEEDED, providerEventId: 'evt-mm' });
    expect(ctx.mongo.audits.map((a) => a.action)).toContain(AuditAction.MANAGED_MARKETING_PAYMENT_CONFIRMED);
  });

  it('repeated confirmation is idempotent (no provider call, one audit, no state churn)', async () => {
    const ctx = await pending(); ctx.succeed();
    await ctx.confirmation.confirm(ctx.paymentId);
    const again = await ctx.confirmation.confirm(ctx.paymentId);
    expect(again).toMatchObject({ alreadyProcessed: true, requestPaid: true });
    expect(ctx.state.verifyCalls).toHaveLength(1);
    expect(ctx.mongo.audits.filter((a) => a.action === AuditAction.MANAGED_MARKETING_PAYMENT_CONFIRMED)).toHaveLength(1);
    expect(ctx.mongo.rows('mmPayments')).toHaveLength(1);
  });

  it('concurrent duplicate confirmations converge on one PAID transition', async () => {
    const ctx = await pending(); ctx.succeed();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => ctx.confirmation.confirm(ctx.paymentId)));
    expect(results.every((r) => r.requestPaid)).toBe(true);
    expect(results.filter((r) => !r.alreadyProcessed)).toHaveLength(1);
    expect(ctx.mongo.audits.filter((a) => a.action === AuditAction.MANAGED_MARKETING_PAYMENT_CONFIRMED)).toHaveLength(1);
    expect(request(ctx.mongo).status).toBe(ManagedMarketingRequestStatus.PAID);
  });

  it.each([['amount', PRICE - 1, 'EGP', PaymentReconciliationFlag.AMOUNT_MISMATCH], ['currency', PRICE, 'USD', PaymentReconciliationFlag.CURRENCY_MISMATCH]])(
    '%s mismatch fails closed: not PAID, parked for the operator, nothing granted', async (_n, amount, currency, flag) => {
      const ctx = await pending(); ctx.succeed(amount as number, currency as string);
      expect(await codeOf(() => ctx.confirmation.confirm(ctx.paymentId))).toBe(PaymentErrorCode.VERIFICATION_MISMATCH);
      expect(request(ctx.mongo)).toMatchObject({ status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: ManagedMarketingPaymentStatus.RECONCILIATION_REQUIRED });
      expect(request(ctx.mongo).paidAt).toBeUndefined();
      expect(ctx.mongo.rows('mmPayments')[0]).toMatchObject({ status: EntryPaymentStatus.INITIATED, reconciliationFlag: flag });
      expect(ctx.mongo.audits.find((a) => a.action === AuditAction.MANAGED_MARKETING_PAYMENT_REJECTED).metadata).toMatchObject({ expectedAmountMinor: PRICE });
      // Parked: no automatic new payment, no customer cancellation.
      expect(await codeOf(() => ctx.initiation.initiate(OWNER, REQUEST))).toBe(PaymentErrorCode.RECONCILIATION_REQUIRED);
      expect(await codeOf(() => ctx.marketing.cancel(OWNER, REQUEST, undefined))).toBe('MANAGED_MARKETING_CANCELLATION_NOT_ALLOWED');
    });

  it('a verified success for a payment already recorded FAILED needs operator reconciliation and pays nothing', async () => {
    const ctx = await pending();
    ctx.state.outcome = (ref) => ({ status: 'FAILED', providerReference: ref, amountMinor: PRICE, currency: 'EGP' });
    await ctx.confirmation.confirm(ctx.paymentId);
    ctx.succeed();
    expect(await codeOf(() => ctx.confirmation.confirm(ctx.paymentId))).toBe(PaymentErrorCode.CONFIRMED_AFTER_FAILURE);
    expect(request(ctx.mongo)).toMatchObject({ status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: ManagedMarketingPaymentStatus.RECONCILIATION_REQUIRED });
    expect(ctx.mongo.rows('mmPayments')[0]).toMatchObject({ status: EntryPaymentStatus.FAILED, reconciliationFlag: PaymentReconciliationFlag.CONFIRMED_AFTER_FAILURE });
  });

  it('an unexpected request state aborts the whole confirmation (no half-paid state)', async () => {
    const ctx = await pending(); ctx.succeed();
    request(ctx.mongo).status = ManagedMarketingRequestStatus.CANCELLED; // corrupt/impossible under the contract
    expect(await codeOf(() => ctx.confirmation.confirm(ctx.paymentId))).toBe(PaymentErrorCode.STATE_INCONSISTENT);
    expect(ctx.mongo.rows('mmPayments')[0].status).toBe(EntryPaymentStatus.INITIATED);
    expect(request(ctx.mongo).paidAt).toBeUndefined();
  });

  it('client-declared success is meaningless: confirm takes only a payment id and trusts only the provider', async () => {
    const ctx = await pending();
    expect(ctx.confirmation.confirm.length).toBe(1);
    await ctx.confirmation.confirm(ctx.paymentId);
    expect(ctx.state.verifyCalls).toEqual(['ref-1']);
    expect(request(ctx.mongo).status).toBe(ManagedMarketingRequestStatus.APPROVED);
  });
});

describe('customer cancellation contract (MAZAD-020B, unchanged in spirit)', () => {
  it('can cancel an approved request before payment starts', async () => {
    const { marketing, mongo } = build();
    await marketing.cancel(OWNER, REQUEST, 'changed my mind');
    expect(request(mongo).status).toBe(ManagedMarketingRequestStatus.CANCELLED);
  });
  it('cannot cancel once a payment is pending or succeeded', async () => {
    const ctx = build(); const a = await ctx.initiation.initiate(OWNER, REQUEST);
    expect(await codeOf(() => ctx.marketing.cancel(OWNER, REQUEST, undefined))).toBe('MANAGED_MARKETING_CANCELLATION_NOT_ALLOWED');
    ctx.succeed(); await ctx.confirmation.confirm(a.paymentId);
    expect(await codeOf(() => ctx.marketing.cancel(OWNER, REQUEST, undefined))).toBe('MANAGED_MARKETING_CANCELLATION_NOT_ALLOWED');
    expect(request(ctx.mongo).status).toBe(ManagedMarketingRequestStatus.PAID);
  });
  it('can cancel again after a FAILED attempt (cancellation is blocked only from payment start until failure/success)', async () => {
    const ctx = build(); const a = await ctx.initiation.initiate(OWNER, REQUEST);
    ctx.state.outcome = (ref) => ({ status: 'FAILED', providerReference: ref, amountMinor: PRICE, currency: 'EGP' });
    await ctx.confirmation.confirm(a.paymentId);
    await ctx.marketing.cancel(OWNER, REQUEST, undefined);
    expect(request(ctx.mongo).status).toBe(ManagedMarketingRequestStatus.CANCELLED);
    expect(await codeOf(() => ctx.initiation.initiate(OWNER, REQUEST))).toBe(PaymentErrorCode.REQUEST_NOT_PAYABLE);
  });
});
