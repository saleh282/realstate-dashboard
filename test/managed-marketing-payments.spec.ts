import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AuctionStatus } from '../src/auctions/auction.types';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';
import { SystemRole } from '../src/auth/roles.enum';
import { AuthorizationPolicyService } from '../src/authorization/authorization-policy.service';
import { Capability } from '../src/authorization/capability';
import { BidErrorCode } from '../src/common/errors/bid-error-codes';
import { PaymentErrorCode } from '../src/common/errors/payment-error-codes';
import { ManagedMarketingPaymentStatus, ManagedMarketingRequestStatus } from '../src/managed-marketing/managed-marketing.types';
import { ManagedMarketingService } from '../src/managed-marketing/managed-marketing.service';
import { AuctionEntryFeeService } from '../src/payments/auction-entry-fee.service';
import { AuctionEntryPaymentService } from '../src/payments/auction-entry-payment.service';
import { AuctionPaymentConfirmationService } from '../src/payments/auction-payment-confirmation.service';
import { AuctionPaymentProviderPort, UnconfiguredPaymentProvider } from '../src/payments/auction-payment-provider.port';
import { ManagedMarketingPaymentConfirmationService } from '../src/payments/managed-marketing-payment-confirmation.service';
import { ManagedMarketingPaymentService } from '../src/payments/managed-marketing-payment.service';
import { EntryPaymentStatus, PaymentPurpose, PaymentReconciliationFlag, VerifiedProviderOutcome } from '../src/payments/payment.types';
import { PersistentBidEntitlementPort } from '../src/payments/persistent-bid-entitlement.port';
import { AuctionEntryPaymentSchema } from '../src/payments/schemas/auction-entry-payment.schema';
import { ManagedMarketingPaymentSchema } from '../src/payments/schemas/managed-marketing-payment.schema';
import { AccountStatus, AccountType, BrokerStatus } from '../src/users/identity.types';
import { FakeMongo } from './support/fake-payments-mongo';

/**
 * MAZAD-028 completion — the MANAGED_MARKETING payment purpose, its isolation
 * from AUCTION_ENTRY, and the dedicated Admin fee capability. In-memory Mongo
 * MODEL (see support/fake-payments-mongo.ts); real-Mongo qualification remains.
 */
const oid = (hex: string) => new Types.ObjectId(hex);
const AUCTION = '64b000000000000000000f01';
const ADVERTISER = '64b000000000000000000a10';
const OWNER = '64b000000000000000000a11';
const OTHER = '64b000000000000000000a12';
const ADMIN = '64b000000000000000000a20';
const REQUEST = '64b000000000000000000c01';
const PRICE = 1_500_000; // test data only — a made-up fixture, not a product price
const AUCTION_FEE = 25_000;

function fakeProvider(overrides: Partial<AuctionPaymentProviderPort> = {}) {
  const state: { outcome: (ref: string) => VerifiedProviderOutcome; initiateCalls: any[]; verifyCalls: string[]; expectAmount: number } = {
    outcome: (ref) => ({ status: 'PENDING', providerReference: ref, amountMinor: PRICE, currency: 'EGP' }),
    initiateCalls: [], verifyCalls: [], expectAmount: PRICE,
  };
  let n = 0;
  const provider: AuctionPaymentProviderPort = {
    providerKey: 'fake-test-provider', configured: true,
    initiate: async (r) => { state.initiateCalls.push(r); return { providerReference: `ref-${++n}` }; },
    verify: async (ref) => { state.verifyCalls.push(ref); return state.outcome(ref); },
    ...overrides,
  };
  return { provider, state };
}

function build(requestOverrides: Record<string, unknown> = {}, providerOverrides: Partial<AuctionPaymentProviderPort> = {}) {
  const mongo = new FakeMongo();
  mongo.seedAuction({ entryFee: { amountMinor: AUCTION_FEE, currency: 'EGP', configuredByActorId: oid(ADMIN), configuredAt: new Date() } });
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
    auctions: mongo.model('auctions'), users: mongo.model('users'), payments: mongo.model('payments'), entitlements: mongo.model('entitlements'),
    requests: mongo.model('requests'), audit: mongo.auditSvc, clock, provider, connection: mongo.connection, outbox: mongo.outbox.service,
  };
  // The managed-marketing payments model is the 'mmPayments' collection.
  const mmDeps = { ...deps, payments: mongo.model('mmPayments') };
  const initiation = Object.assign(Object.create(ManagedMarketingPaymentService.prototype), mmDeps) as ManagedMarketingPaymentService;
  const confirmation = Object.assign(Object.create(ManagedMarketingPaymentConfirmationService.prototype), mmDeps) as ManagedMarketingPaymentConfirmationService;
  const auctionInitiation = Object.assign(Object.create(AuctionEntryPaymentService.prototype), deps) as AuctionEntryPaymentService;
  const auctionConfirmation = Object.assign(Object.create(AuctionPaymentConfirmationService.prototype), deps) as AuctionPaymentConfirmationService;
  const feeService = Object.assign(Object.create(AuctionEntryFeeService.prototype), deps) as AuctionEntryFeeService;
  const port = new PersistentBidEntitlementPort(mongo.model('entitlements') as any);
  const marketing = Object.assign(Object.create(ManagedMarketingService.prototype), { requests: mongo.model('requests'), audit: { logResourceAction: jest.fn(async () => undefined) } }) as ManagedMarketingService;
  const succeed = (amountMinor = PRICE, currency = 'EGP') => { state.outcome = (ref) => ({ status: 'SUCCEEDED', providerReference: ref, amountMinor, currency, providerEventId: 'evt-mm' }); };
  return { mongo, initiation, confirmation, auctionInitiation, auctionConfirmation, feeService, port, marketing, provider, state, succeed };
}
const request = (mongo: FakeMongo) => mongo.data.requests.get(REQUEST)!.doc;
async function codeOf(action: () => Promise<unknown>): Promise<string | undefined> {
  try { await action(); return undefined; } catch (error) { return (error as any).getResponse?.()?.code; }
}
const entitledCode = async (port: PersistentBidEntitlementPort, mongo: FakeMongo, bidder: string) => {
  const s = await mongo.connection.startSession(); s.startTransaction();
  return codeOf(() => port.assertEntitled({ auctionId: AUCTION, bidderAccountId: bidder, session: s }));
};

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

describe('payment purpose isolation (MAZAD-028)', () => {
  it('separate collections, immutable purpose markers, separate unique indexes', () => {
    expect(AuctionEntryPaymentSchema.get('collection')).toBe('auction_entry_payments');
    expect(ManagedMarketingPaymentSchema.get('collection')).toBe('managed_marketing_payments');
    expect(AuctionEntryPaymentSchema.path('purpose').options).toMatchObject({ default: PaymentPurpose.AUCTION_ENTRY, immutable: true, enum: [PaymentPurpose.AUCTION_ENTRY] });
    expect(ManagedMarketingPaymentSchema.path('purpose').options).toMatchObject({ default: PaymentPurpose.MANAGED_MARKETING, immutable: true, enum: [PaymentPurpose.MANAGED_MARKETING] });
    expect(ManagedMarketingPaymentSchema.path('requestId')).toBeDefined();
    expect(ManagedMarketingPaymentSchema.path('auctionId')).toBeUndefined();
    expect(AuctionEntryPaymentSchema.path('requestId')).toBeUndefined();
  });

  it('an AUCTION_ENTRY payment cannot satisfy MANAGED_MARKETING confirmation (and vice versa)', async () => {
    const ctx = build();
    const auctionPayment = await ctx.auctionInitiation.initiate(OTHER, AUCTION);
    const mmPayment = await ctx.initiation.initiate(OWNER, REQUEST);
    ctx.succeed(AUCTION_FEE);
    expect(await codeOf(() => ctx.confirmation.confirm(auctionPayment.paymentId))).toBe(PaymentErrorCode.NOT_FOUND);
    expect(request(ctx.mongo).status).toBe(ManagedMarketingRequestStatus.APPROVED);
    ctx.succeed(PRICE);
    expect(await codeOf(() => ctx.auctionConfirmation.confirm(mmPayment.paymentId))).toBe(PaymentErrorCode.NOT_FOUND);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
  });

  it('a MANAGED_MARKETING payment can never satisfy AUCTION_BID_ENTITLEMENT_PORT, touch the auction, or create a bid', async () => {
    const ctx = build();
    const a = await ctx.initiation.initiate(OWNER, REQUEST); ctx.succeed(); await ctx.confirmation.confirm(a.paymentId);
    expect(request(ctx.mongo).status).toBe(ManagedMarketingRequestStatus.PAID);
    expect(await entitledCode(ctx.port, ctx.mongo, OWNER)).toBe(BidErrorCode.ENTITLEMENT_REQUIRED);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
    expect(ctx.mongo.rows('payments')).toHaveLength(0); // auction-entry collection untouched
    expect(ctx.mongo.auctionWrites).toBe(0);
    expect(ctx.mongo.auction().status).toBe(AuctionStatus.SCHEDULED);
  });

  it('an AUCTION_ENTRY success never marks a managed-marketing request paid', async () => {
    const ctx = build();
    const a = await ctx.auctionInitiation.initiate(OWNER, AUCTION);
    ctx.succeed(AUCTION_FEE); await ctx.auctionConfirmation.confirm(a.paymentId);
    expect(await entitledCode(ctx.port, ctx.mongo, OWNER)).toBeUndefined();
    expect(request(ctx.mongo)).toMatchObject({ status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: ManagedMarketingPaymentStatus.AWAITING_PAYMENT });
    expect(ctx.mongo.rows('mmPayments')).toHaveLength(0);
  });

  it('the managed-marketing services do not depend on auction or entitlement models', () => {
    const fs = require('node:fs'); const path = require('node:path');
    for (const f of ['managed-marketing-payment.service.ts', 'managed-marketing-payment-confirmation.service.ts', 'schemas/managed-marketing-payment.schema.ts']) {
      const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', f), 'utf8');
      expect(text).not.toMatch(/AuctionBidEntitlement|schemas\/auction\.schema|auctions\/|BidLedger|Bid\b.*schema/);
      expect(text).not.toMatch(/INSPECTION_|PHOTOGRAPHY_|MARKETING_ACTIVE|scheduledAt|deadline/);
    }
  });
});

describe('Admin auction-fee capability and existing auctions (MAZAD-028)', () => {
  const identity = (o: Record<string, unknown> = {}) => ({ userId: OWNER, systemRole: SystemRole.USER, accountType: AccountType.USER, accountStatus: AccountStatus.ACTIVE, brokerStatus: BrokerStatus.NOT_APPLIED, ...o }) as any;

  it('is granted to active ADMIN and SUPER_ADMIN only', () => {
    const can = (o: Record<string, unknown>) => AuthorizationPolicyService.can(identity(o), Capability.ADMIN_AUCTION_FEE_MANAGE);
    expect(can({ systemRole: SystemRole.ADMIN })).toBe(true);
    expect(can({ systemRole: SystemRole.SUPER_ADMIN })).toBe(true);
    expect(can({})).toBe(false);
    expect(can({ accountType: AccountType.BROKER, brokerStatus: BrokerStatus.APPROVED })).toBe(false);
    expect(can({ systemRole: SystemRole.ADMIN, accountStatus: AccountStatus.SUSPENDED })).toBe(false);
  });

  it('does not broaden Admin marketplace participation', () => {
    const admin = identity({ systemRole: SystemRole.ADMIN });
    for (const c of [Capability.BID_PLACE, Capability.PAYMENT_ENTRY_INITIATE, Capability.MANAGED_MARKETING_REQUEST, Capability.AUCTION_CREATE_OWN]) {
      expect(AuthorizationPolicyService.can(admin, c)).toBe(false);
    }
  });

  it('the fee service enforces the capability: marketplace users and suspended admins are refused, an admin succeeds', async () => {
    const ctx = build(); ctx.mongo.data.auctions.get(AUCTION)!.doc = { ...ctx.mongo.auction(), entryFee: undefined }; delete ctx.mongo.auction().entryFee;
    ctx.mongo.seedUser('64b000000000000000000a30', { systemRole: SystemRole.ADMIN, accountStatus: AccountStatus.SUSPENDED });
    await expect(ctx.feeService.configure(OWNER, AUCTION, 30_000)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctx.feeService.configure('64b000000000000000000a30', AUCTION, 30_000)).rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.mongo.auction().entryFee).toBeUndefined();
    await ctx.feeService.configure(ADMIN, AUCTION, 30_000);
    expect(ctx.mongo.auction().entryFee.amountMinor).toBe(30_000);
  });

  it('an existing ACTIVE auction without a fee stays fail-closed for paid bidding and is never mutated', async () => {
    const ctx = build();
    const doc = ctx.mongo.auction(); delete doc.entryFee; doc.status = AuctionStatus.ACTIVE;
    const snapshot = JSON.stringify(doc);
    expect(await codeOf(() => ctx.auctionInitiation.initiate(OWNER, AUCTION))).toBe(PaymentErrorCode.ENTRY_FEE_NOT_CONFIGURED);
    await expect(ctx.feeService.configure(ADMIN, AUCTION, 30_000)).rejects.toBeInstanceOf(ConflictException); // fee is set at SCHEDULED only
    expect(await entitledCode(ctx.port, ctx.mongo, OWNER)).toBe(BidErrorCode.ENTITLEMENT_REQUIRED);
    expect(JSON.stringify(ctx.mongo.auction())).toBe(snapshot);
  });

  it('auction-entry initiation also requires the frozen PAYMENT_ENTRY_INITIATE capability', async () => {
    const ctx = build();
    await expect(ctx.auctionInitiation.initiate(ADMIN, AUCTION)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the unconfigured provider stays fail-closed for both purposes', async () => {
    const closed = new UnconfiguredPaymentProvider();
    expect(closed.configured).toBe(false);
    await expect(closed.verify()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('MANAGED_MARKETING payment domain event — transactional outbox (MAZAD-031)', () => {
  async function pending() { const ctx = build(); const a = await ctx.initiation.initiate(OWNER, REQUEST); return { ...ctx, paymentId: a.paymentId }; }
  const mmEvents = (mongo: FakeMongo) => mongo.outbox.events('MANAGED_MARKETING_PAYMENT_CONFIRMED');

  it('a verified success writes exactly ONE private event on the REQUEST aggregate, in the same commit as PAID', async () => {
    const ctx = await pending(); ctx.succeed();
    await ctx.confirmation.confirm(ctx.paymentId);
    expect(mmEvents(ctx.mongo)).toHaveLength(1);
    expect(ctx.mongo.outbox.events()).toHaveLength(1);
    expect(ctx.mongo.outbox.events()[0]).toMatchObject({
      type: 'MANAGED_MARKETING_PAYMENT_CONFIRMED', schemaVersion: 1, aggregateType: 'MANAGED_MARKETING_REQUEST', aggregateId: REQUEST, aggregateVersion: 1,
      audience: 'PRIVATE', occurredAt: ctx.mongo.clockNow, privateRouting: { advertiserAccountId: OWNER },
      payload: { requestId: REQUEST, paymentId: ctx.paymentId, amountMinor: PRICE, currency: 'EGP', paidAt: ctx.mongo.clockNow.toISOString(), requestStatus: ManagedMarketingRequestStatus.PAID },
    });
    expect(request(ctx.mongo).status).toBe(ManagedMarketingRequestStatus.PAID);
  });

  it('carries no auction, entitlement, bid, provider or schedule/SLA meaning', async () => {
    const ctx = await pending(); ctx.succeed();
    await ctx.confirmation.confirm(ctx.paymentId);
    const text = JSON.stringify(mmEvents(ctx.mongo)[0].payload);
    expect(text).not.toMatch(/auction|entitlement|bid|inspection|photography|deadline|schedule|sla|fake-test-provider|ref-1|evt-mm/i);
  });

  it('repeated and concurrent confirmations never duplicate the event', async () => {
    const ctx = await pending(); ctx.succeed();
    await Promise.all([1, 2, 3, 4, 5].map(() => ctx.confirmation.confirm(ctx.paymentId)));
    await ctx.confirmation.confirm(ctx.paymentId);
    expect(mmEvents(ctx.mongo)).toHaveLength(1);
  });

  it('pending, failed, mismatched and reconciliation-required payments create NO event', async () => {
    const pendingCtx = await pending();
    await pendingCtx.confirmation.confirm(pendingCtx.paymentId);
    expect(pendingCtx.mongo.outbox.events()).toHaveLength(0);

    const failed = await pending();
    failed.state.outcome = (ref) => ({ status: 'FAILED', providerReference: ref, amountMinor: PRICE, currency: 'EGP', failureCode: 'DECLINED' });
    await failed.confirmation.confirm(failed.paymentId);
    expect(failed.mongo.outbox.events()).toHaveLength(0);

    for (const [amount, currency] of [[PRICE - 1, 'EGP'], [PRICE, 'USD']] as const) {
      const mismatch = await pending(); mismatch.succeed(amount, currency);
      await codeOf(() => mismatch.confirmation.confirm(mismatch.paymentId));
      expect(request(mismatch.mongo).paymentStatus).toBe(ManagedMarketingPaymentStatus.RECONCILIATION_REQUIRED);
      expect(mismatch.mongo.outbox.events()).toHaveLength(0);
    }

    const afterFailure = await pending();
    afterFailure.state.outcome = (ref) => ({ status: 'FAILED', providerReference: ref, amountMinor: PRICE, currency: 'EGP' });
    await afterFailure.confirmation.confirm(afterFailure.paymentId);
    afterFailure.succeed();
    await codeOf(() => afterFailure.confirmation.confirm(afterFailure.paymentId));
    expect(afterFailure.mongo.outbox.events()).toHaveLength(0);
  });

  it('an unexpected request state aborts the whole confirmation: no PAID, no event', async () => {
    const ctx = await pending(); ctx.succeed();
    request(ctx.mongo).status = ManagedMarketingRequestStatus.CANCELLED;
    await codeOf(() => ctx.confirmation.confirm(ctx.paymentId));
    expect(ctx.mongo.outbox.events()).toHaveLength(0);
  });

  it('an outbox failure aborts the confirmation: not PAID, payment still INITIATED, no audit row', async () => {
    const ctx = await pending(); ctx.succeed();
    ctx.mongo.outbox.insertError = () => new Error('outbox unavailable');
    const auditsBefore = ctx.mongo.audits.length;
    await expect(ctx.confirmation.confirm(ctx.paymentId)).rejects.toThrow('outbox unavailable');
    expect(request(ctx.mongo)).toMatchObject({ status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: ManagedMarketingPaymentStatus.PENDING });
    expect(request(ctx.mongo).paidAt).toBeUndefined();
    expect(ctx.mongo.rows('mmPayments')[0].status).toBe(EntryPaymentStatus.INITIATED);
    expect(ctx.mongo.audits).toHaveLength(auditsBefore);
  });

  it('an audit failure aborts the confirmation and leaves no event', async () => {
    const ctx = await pending(); ctx.succeed();
    ctx.mongo.auditSvc.logSystemRequired.mockRejectedValueOnce(new Error('audit down'));
    await expect(ctx.confirmation.confirm(ctx.paymentId)).rejects.toThrow('audit down');
    expect(ctx.mongo.outbox.events()).toHaveLength(0);
    expect(request(ctx.mongo).status).toBe(ManagedMarketingRequestStatus.APPROVED);
  });

  it('PURPOSE ISOLATION: each purpose emits only its own event type on its own aggregate, and neither touches the other\'s state', async () => {
    const ctx = build();
    const entry = await ctx.auctionInitiation.initiate(OTHER, AUCTION);
    const marketing = await ctx.initiation.initiate(OWNER, REQUEST);
    ctx.succeed(AUCTION_FEE);
    await ctx.auctionConfirmation.confirm(entry.paymentId);
    expect(ctx.mongo.outbox.events().map((e) => e.type)).toEqual(['AUCTION_ENTRY_PAYMENT_CONFIRMED']);
    expect(request(ctx.mongo).status).toBe(ManagedMarketingRequestStatus.APPROVED); // an auction-entry success never pays a request
    ctx.succeed(PRICE);
    await ctx.confirmation.confirm(marketing.paymentId);
    expect(ctx.mongo.outbox.events().map((e) => [e.type, e.aggregateType]).sort()).toEqual([
      ['AUCTION_ENTRY_PAYMENT_CONFIRMED', 'AUCTION_ENTRY_PAYMENT'], ['MANAGED_MARKETING_PAYMENT_CONFIRMED', 'MANAGED_MARKETING_REQUEST'],
    ]);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1); // only the auction-entry purpose granted an entitlement
    expect(ctx.mongo.outbox.events('MANAGED_MARKETING_PAYMENT_CONFIRMED')[0].payload).not.toHaveProperty('auctionId');
    expect(ctx.mongo.outbox.events('AUCTION_ENTRY_PAYMENT_CONFIRMED')[0].payload).not.toHaveProperty('requestId');
  });
});
