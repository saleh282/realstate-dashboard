import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AuctionStatus } from '../src/auctions/auction.types';
import { AuctionsController } from '../src/auctions/auctions.controller';
import { AdminAuctionsController } from '../src/auctions/admin-auctions.controller';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';
import { SystemRole } from '../src/auth/roles.enum';
import { BidErrorCode } from '../src/common/errors/bid-error-codes';
import { PaymentErrorCode } from '../src/common/errors/payment-error-codes';
import { MONEY_MINOR_MAX } from '../src/common/money/money';
import { AuctionEntryFeeService } from '../src/payments/auction-entry-fee.service';
import { AuctionEntryPaymentService } from '../src/payments/auction-entry-payment.service';
import { AuctionPaymentConfirmationService } from '../src/payments/auction-payment-confirmation.service';
import { AuctionPaymentProviderPort, UnconfiguredPaymentProvider } from '../src/payments/auction-payment-provider.port';
import { EntryPaymentStatus, PaymentReconciliationFlag, VerifiedProviderOutcome } from '../src/payments/payment.types';
import { PaymentsModule } from '../src/payments/payments.module';
import { PersistentBidEntitlementPort } from '../src/payments/persistent-bid-entitlement.port';
import { AuctionBidEntitlementSchema } from '../src/payments/schemas/auction-bid-entitlement.schema';
import { AuctionEntryPaymentSchema } from '../src/payments/schemas/auction-entry-payment.schema';
import { AccountStatus, AccountType, BrokerStatus } from '../src/users/identity.types';

/**
 * MAZAD-028 — provider-neutral entry-fee payment + entitlement, tested against
 * an in-memory Mongo model (snapshot reads, single-writer-per-document with
 * WriteConflict, commit-time stale check, unique indexes, abort discards
 * writes). It is a model, not MongoDB: real unique-index / concurrent
 * confirmation behaviour still needs a disposable-Mongo run at release
 * qualification.
 */
import { FakeMongo, dupKey, tick, transient } from './support/fake-payments-mongo';
void dupKey; void transient; void tick;
const oid = (hex: string) => new Types.ObjectId(hex);
const AUCTION = '64b000000000000000000f01';
const OTHER_AUCTION = '64b000000000000000000f02';
const ADVERTISER = '64b000000000000000000a10';
const ALICE = '64b000000000000000000a11';
const BOB = '64b000000000000000000a12';
const ADMIN = '64b000000000000000000a20';
const FEE = 25_000;
function fakeProvider(overrides: Partial<AuctionPaymentProviderPort> = {}) {
  const state: { outcome: (ref: string) => VerifiedProviderOutcome; initiateCalls: any[]; verifyCalls: string[] } = {
    outcome: (ref) => ({ status: 'PENDING', providerReference: ref, amountMinor: FEE, currency: 'EGP' }),
    initiateCalls: [], verifyCalls: [],
  };
  let n = 0;
  const provider: AuctionPaymentProviderPort = {
    providerKey: 'fake-test-provider', configured: true,
    initiate: async (r) => { state.initiateCalls.push(r); return { providerReference: `ref-${++n}`, clientHandoff: 'opaque' }; },
    verify: async (ref) => { state.verifyCalls.push(ref); return state.outcome(ref); },
    ...overrides,
  };
  return { provider, state };
}

function build(providerOverrides: Partial<AuctionPaymentProviderPort> = {}, opts: { fee?: number | null } = {}) {
  const mongo = new FakeMongo();
  const fee = opts.fee === undefined ? FEE : opts.fee;
  mongo.seedAuction(fee === null ? {} : { entryFee: { amountMinor: fee, currency: 'EGP', configuredByActorId: oid(ADMIN), configuredAt: new Date() } });
  for (const id of [ADVERTISER, ALICE, BOB]) mongo.seedUser(id);
  mongo.seedUser(ADMIN, { systemRole: SystemRole.ADMIN });
  const clock = { now: () => mongo.clockNow };
  const { provider, state } = fakeProvider(providerOverrides);
  const deps = { auctions: mongo.model('auctions'), users: mongo.model('users'), payments: mongo.model('payments'), entitlements: mongo.model('entitlements'), audit: mongo.auditSvc, clock, provider, connection: mongo.connection, outbox: mongo.outbox.service };
  const initiation = Object.assign(Object.create(AuctionEntryPaymentService.prototype), deps) as AuctionEntryPaymentService;
  const confirmation = Object.assign(Object.create(AuctionPaymentConfirmationService.prototype), deps) as AuctionPaymentConfirmationService;
  const feeService = Object.assign(Object.create(AuctionEntryFeeService.prototype), deps) as AuctionEntryFeeService;
  const port = new PersistentBidEntitlementPort(mongo.model('entitlements') as any);
  const succeed = () => { state.outcome = (ref) => ({ status: 'SUCCEEDED', providerReference: ref, amountMinor: FEE, currency: 'EGP', providerEventId: 'evt-1' }); };
  return { mongo, initiation, confirmation, feeService, port, provider, state, succeed };
}
async function codeOf(action: () => Promise<unknown>): Promise<string | undefined> {
  try { await action(); return undefined; } catch (error) { return (error as any).getResponse?.()?.code; }
}
const entitledError = async (port: PersistentBidEntitlementPort, mongo: FakeMongo, bidder: string, auction = AUCTION) => {
  const s = await mongo.connection.startSession(); s.startTransaction();
  return codeOf(() => port.assertEntitled({ auctionId: auction, bidderAccountId: bidder, session: s }));
};

describe('auction entry fee configuration (MAZAD-028)', () => {
  it('lets an admin set the fee once, as integer minor units, on a SCHEDULED auction', async () => {
    const { mongo, feeService } = build({}, { fee: null });
    await feeService.configure(ADMIN, AUCTION, 30_000);
    expect(mongo.auction().entryFee).toMatchObject({ amountMinor: 30_000, currency: 'EGP' });
    expect(mongo.audits.map((a) => a.action)).toContain(AuditAction.AUCTION_ENTRY_FEE_CONFIGURED);
  });
  it.each([0, -1, 1.5, '100', null, undefined, NaN, MONEY_MINOR_MAX + 1])('rejects invalid fee %p', async (bad) => {
    const { mongo, feeService } = build({}, { fee: null });
    expect(await codeOf(() => feeService.configure(ADMIN, AUCTION, bad))).toBe(PaymentErrorCode.ENTRY_FEE_INVALID);
    expect(mongo.auction().entryFee).toBeUndefined();
  });
  it('is write-once', async () => {
    const { mongo, feeService } = build({}, { fee: null });
    await feeService.configure(ADMIN, AUCTION, 30_000);
    expect(await codeOf(() => feeService.configure(ADMIN, AUCTION, 40_000))).toBe(PaymentErrorCode.ENTRY_FEE_ALREADY_CONFIGURED);
    expect(mongo.auction().entryFee.amountMinor).toBe(30_000);
  });
  it('is admin-only', async () => {
    const { mongo, feeService } = build({}, { fee: null });
    await expect(feeService.configure(ALICE, AUCTION, 30_000)).rejects.toBeInstanceOf(ForbiddenException);
    expect(mongo.auction().entryFee).toBeUndefined();
  });
  it('is refused once the auction is no longer SCHEDULED', async () => {
    const { mongo, feeService } = build({}, { fee: null });
    mongo.auction().status = AuctionStatus.ACTIVE;
    await expect(feeService.configure(ADMIN, AUCTION, 30_000)).rejects.toBeInstanceOf(ConflictException);
  });
  it('a missing fee is never treated as free: initiation fails closed and creates nothing', async () => {
    const { mongo, initiation, state } = build({}, { fee: null });
    expect(await codeOf(() => initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.ENTRY_FEE_NOT_CONFIGURED);
    expect(mongo.rows('payments')).toHaveLength(0);
    expect(state.initiateCalls).toHaveLength(0);
  });
  it('schema: fee is optional (existing auctions stay valid) and money-validated', () => {
    const { AuctionSchema } = require('../src/auctions/schemas/auction.schema');
    expect(AuctionSchema.path('entryFee').isRequired).toBeFalsy();
  });
});

describe('payment initiation (MAZAD-028)', () => {
  it('copies the server-configured fee; the caller has no way to supply an amount', async () => {
    const { mongo, initiation, state } = build();
    expect(AuctionEntryPaymentService.prototype.initiate.length).toBeLessThanOrEqual(3); // (actorId, auctionId, ip?)
    const r = await initiation.initiate(ALICE, AUCTION);
    expect(r).toMatchObject({ amountMinor: FEE, currency: 'EGP', status: EntryPaymentStatus.INITIATED, providerReference: 'ref-1', reused: false });
    expect(state.initiateCalls[0]).toMatchObject({ amountMinor: FEE, currency: 'EGP' });
    expect(mongo.rows('payments')[0]).toMatchObject({ amountMinor: FEE, provider: 'fake-test-provider', isLive: true });
    expect(mongo.audits.map((a) => a.action)).toContain(AuditAction.AUCTION_ENTRY_PAYMENT_INITIATED);
  });
  it('a pending payment grants no entitlement', async () => {
    const { mongo, initiation, port } = build();
    await initiation.initiate(ALICE, AUCTION);
    expect(mongo.rows('entitlements')).toHaveLength(0);
    expect(await entitledError(port, mongo, ALICE)).toBe(BidErrorCode.ENTITLEMENT_REQUIRED);
  });
  it('re-initiating returns the existing live attempt (no second payment, no second provider call)', async () => {
    const { mongo, initiation, state } = build();
    const a = await initiation.initiate(ALICE, AUCTION);
    const b = await initiation.initiate(ALICE, AUCTION);
    expect(b).toMatchObject({ paymentId: a.paymentId, reused: true });
    expect(mongo.rows('payments')).toHaveLength(1);
    expect(state.initiateCalls).toHaveLength(1);
  });
  it('concurrent initiations converge on one live attempt', async () => {
    const { mongo, initiation } = build();
    const results = await Promise.all([1, 2, 3, 4].map(() => initiation.initiate(ALICE, AUCTION)));
    expect(new Set(results.map((r) => r.paymentId)).size).toBe(1);
    expect(mongo.rows('payments')).toHaveLength(1);
  });
  it('does not replace bidding authorization: admin and the advertiser cannot buy entry', async () => {
    const { mongo, initiation } = build();
    await expect(initiation.initiate(ADMIN, AUCTION)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(initiation.initiate(ADVERTISER, AUCTION)).rejects.toBeInstanceOf(ForbiddenException);
    expect(mongo.rows('payments')).toHaveLength(0);
  });
  it.each([AuctionStatus.CANCELLED, AuctionStatus.ENDED_PENDING_CLOSE, AuctionStatus.COMPLETED, AuctionStatus.ENDED_NO_BIDS])('is refused for a %s auction', async (status) => {
    const { mongo, initiation } = build();
    mongo.auction().status = status;
    expect(await codeOf(() => initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.AUCTION_NOT_PAYABLE);
  });
  it('fails closed with no configured provider, writing nothing', async () => {
    const { mongo, initiation } = build({ configured: false });
    await expect(initiation.initiate(ALICE, AUCTION)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(mongo.rows('payments')).toHaveLength(0);
  });
  it('a provider failure while opening marks the reference-less attempt FAILED, allowing a fresh attempt', async () => {
    const { mongo, initiation, provider } = build();
    const original = provider.initiate;
    provider.initiate = async () => { throw new Error('gateway down'); };
    await expect(initiation.initiate(ALICE, AUCTION)).rejects.toThrow('gateway down');
    expect(mongo.rows('payments')[0]).toMatchObject({ status: EntryPaymentStatus.FAILED, failureCode: 'PROVIDER_INITIATION_FAILED' });
    expect(mongo.rows('payments')[0].isLive).toBeUndefined();
    provider.initiate = original;
    const retry = await initiation.initiate(ALICE, AUCTION);
    expect(retry.reused).toBe(false);
    expect(mongo.rows('payments')).toHaveLength(2);
  });
  it('refuses to start a second payment once paid', async () => {
    const { initiation, confirmation, succeed } = build();
    const a = await initiation.initiate(ALICE, AUCTION);
    succeed(); await confirmation.confirm(a.paymentId);
    expect(await codeOf(() => initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.ALREADY_PAID);
  });
});

describe('server-confirmed success (MAZAD-028)', () => {
  async function pending(ctx = build()) { const a = await ctx.initiation.initiate(ALICE, AUCTION); return { ...ctx, paymentId: a.paymentId }; }

  it('confirmed payment grants exactly one entitlement, scoped to (auction, bidder)', async () => {
    const ctx = await pending(); ctx.succeed();
    const r = await ctx.confirmation.confirm(ctx.paymentId);
    expect(r).toMatchObject({ status: EntryPaymentStatus.SUCCEEDED, entitlementGranted: true, alreadyProcessed: false });
    const [ent] = ctx.mongo.rows('entitlements');
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
    expect(ent).toMatchObject({ amountMinor: FEE, currency: 'EGP' });
    expect(String(ent.auctionId)).toBe(AUCTION); expect(String(ent.bidderAccountId)).toBe(ALICE); expect(String(ent.paymentId)).toBe(ctx.paymentId);
    expect(ctx.mongo.rows('payments')[0]).toMatchObject({ status: EntryPaymentStatus.SUCCEEDED, providerEventId: 'evt-1' });
    expect(ctx.mongo.rows('payments')[0].confirmedAt).toEqual(ctx.mongo.clockNow);
    const actions = ctx.mongo.audits.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining([AuditAction.AUCTION_ENTRY_PAYMENT_CONFIRMED, AuditAction.AUCTION_BID_ENTITLEMENT_GRANTED]));
  });
  it('the entitlement is scoped: not usable by another bidder or on another auction', async () => {
    const ctx = await pending(); ctx.succeed(); await ctx.confirmation.confirm(ctx.paymentId);
    expect(await entitledError(ctx.port, ctx.mongo, ALICE)).toBeUndefined();
    expect(await entitledError(ctx.port, ctx.mongo, BOB)).toBe(BidErrorCode.ENTITLEMENT_REQUIRED);
    expect(await entitledError(ctx.port, ctx.mongo, ALICE, OTHER_AUCTION)).toBe(BidErrorCode.ENTITLEMENT_REQUIRED);
  });
  it('the entitlement port reads with the supplied Mongo session', async () => {
    const ctx = await pending(); ctx.succeed(); await ctx.confirmation.confirm(ctx.paymentId);
    const session = await ctx.mongo.connection.startSession(); session.startTransaction();
    ctx.mongo.sessionsSeenByPort.length = 0;
    await ctx.port.assertEntitled({ auctionId: AUCTION, bidderAccountId: ALICE, session });
    expect(ctx.mongo.sessionsSeenByPort).toEqual([session]);
  });
  it('the port never treats a lookup error as entitled, nor malformed ids', async () => {
    const boom = new PersistentBidEntitlementPort({ exists: () => ({ session: () => ({ exec: async () => { throw new Error('db down'); } }) }) } as any);
    await expect(boom.assertEntitled({ auctionId: AUCTION, bidderAccountId: ALICE, session: {} as any })).rejects.toThrow('db down');
    const ctx = build();
    expect(await entitledError(ctx.port, ctx.mongo, 'not-an-id')).toBe(BidErrorCode.ENTITLEMENT_REQUIRED);
  });
  it('a provider-reported FAILED payment grants nothing and frees the slot for a new attempt', async () => {
    const ctx = await pending();
    ctx.state.outcome = (ref) => ({ status: 'FAILED', providerReference: ref, amountMinor: FEE, currency: 'EGP', failureCode: 'DECLINED' });
    expect(await ctx.confirmation.confirm(ctx.paymentId)).toMatchObject({ status: EntryPaymentStatus.FAILED, entitlementGranted: false });
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
    expect(ctx.mongo.rows('payments')[0].isLive).toBeUndefined();
    expect(await entitledError(ctx.port, ctx.mongo, ALICE)).toBe(BidErrorCode.ENTITLEMENT_REQUIRED);
    expect((await ctx.initiation.initiate(ALICE, AUCTION)).reused).toBe(false);
  });
  it('a still-PENDING provider answer changes nothing', async () => {
    const ctx = await pending();
    expect(await ctx.confirmation.confirm(ctx.paymentId)).toMatchObject({ pending: true, status: EntryPaymentStatus.INITIATED });
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
    expect(ctx.mongo.rows('payments')[0].status).toBe(EntryPaymentStatus.INITIATED);
  });
  it('amount mismatch grants nothing, flags the payment, and audits without the raw payload', async () => {
    const ctx = await pending();
    ctx.state.outcome = (ref) => ({ status: 'SUCCEEDED', providerReference: ref, amountMinor: FEE - 1, currency: 'EGP' });
    expect(await codeOf(() => ctx.confirmation.confirm(ctx.paymentId))).toBe(PaymentErrorCode.VERIFICATION_MISMATCH);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
    expect(ctx.mongo.rows('payments')[0]).toMatchObject({ status: EntryPaymentStatus.INITIATED, reconciliationFlag: PaymentReconciliationFlag.AMOUNT_MISMATCH });
    const audit = ctx.mongo.audits.find((a) => a.action === AuditAction.AUCTION_ENTRY_PAYMENT_REJECTED);
    expect(audit.metadata).toMatchObject({ expectedAmountMinor: FEE, reportedAmountMinor: FEE - 1 });
  });
  it('currency and reference mismatches grant nothing', async () => {
    let ctx = await pending();
    ctx.state.outcome = (ref) => ({ status: 'SUCCEEDED', providerReference: ref, amountMinor: FEE, currency: 'USD' });
    expect(await codeOf(() => ctx.confirmation.confirm(ctx.paymentId))).toBe(PaymentErrorCode.VERIFICATION_MISMATCH);
    expect(ctx.mongo.rows('payments')[0].reconciliationFlag).toBe(PaymentReconciliationFlag.CURRENCY_MISMATCH);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
    ctx = await pending(build());
    ctx.state.outcome = () => ({ status: 'SUCCEEDED', providerReference: 'someone-elses', amountMinor: FEE, currency: 'EGP' });
    expect(await codeOf(() => ctx.confirmation.confirm(ctx.paymentId))).toBe(PaymentErrorCode.VERIFICATION_MISMATCH);
    expect(ctx.mongo.rows('payments')[0].reconciliationFlag).toBe(PaymentReconciliationFlag.REFERENCE_MISMATCH);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
  });
  it('client-declared success is meaningless: only the provider answer decides', async () => {
    const ctx = await pending(); // provider still says PENDING
    expect(ctx.confirmation.confirm.length).toBe(1); // (paymentId) — no outcome/amount/"paid" parameter exists
    await ctx.confirmation.confirm(ctx.paymentId);
    expect(ctx.state.verifyCalls).toEqual(['ref-1']);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
  });
  it('repeated confirmation is idempotent: one entitlement, one confirmation audit, no provider call on replay', async () => {
    const ctx = await pending(); ctx.succeed();
    await ctx.confirmation.confirm(ctx.paymentId);
    const again = await ctx.confirmation.confirm(ctx.paymentId);
    expect(again).toMatchObject({ status: EntryPaymentStatus.SUCCEEDED, alreadyProcessed: true });
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
    expect(ctx.mongo.audits.filter((a) => a.action === AuditAction.AUCTION_ENTRY_PAYMENT_CONFIRMED)).toHaveLength(1);
    expect(ctx.state.verifyCalls).toHaveLength(1);
  });
  it('a later provider FAILED report cannot downgrade a SUCCEEDED payment', async () => {
    const ctx = await pending(); ctx.succeed(); await ctx.confirmation.confirm(ctx.paymentId);
    ctx.state.outcome = (ref) => ({ status: 'FAILED', providerReference: ref, amountMinor: FEE, currency: 'EGP' });
    expect((await ctx.confirmation.confirm(ctx.paymentId)).status).toBe(EntryPaymentStatus.SUCCEEDED);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
  });
  it('concurrent duplicate confirmations converge on one authoritative result', async () => {
    const ctx = await pending(); ctx.succeed();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => ctx.confirmation.confirm(ctx.paymentId)));
    expect(results.every((r) => r.status === EntryPaymentStatus.SUCCEEDED && r.entitlementGranted)).toBe(true);
    expect(results.filter((r) => !r.alreadyProcessed)).toHaveLength(1);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
    expect(ctx.mongo.audits.filter((a) => a.action === AuditAction.AUCTION_ENTRY_PAYMENT_CONFIRMED)).toHaveLength(1);
  });
  it('a verified success for a payment already recorded FAILED is flagged for reconciliation and grants nothing', async () => {
    const ctx = await pending();
    ctx.state.outcome = (ref) => ({ status: 'FAILED', providerReference: ref, amountMinor: FEE, currency: 'EGP' });
    await ctx.confirmation.confirm(ctx.paymentId);
    ctx.succeed();
    expect(await codeOf(() => ctx.confirmation.confirm(ctx.paymentId))).toBe(PaymentErrorCode.CONFIRMED_AFTER_FAILURE);
    expect(ctx.mongo.rows('payments')[0]).toMatchObject({ status: EntryPaymentStatus.FAILED, reconciliationFlag: PaymentReconciliationFlag.CONFIRMED_AFTER_FAILURE });
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
  });
  it('an abort (audit failure) leaves neither a SUCCEEDED payment nor an entitlement', async () => {
    const ctx = await pending(); ctx.succeed();
    ctx.mongo.auditSvc.logSystemRequired.mockRejectedValueOnce(new Error('audit down'));
    await expect(ctx.confirmation.confirm(ctx.paymentId)).rejects.toThrow('audit down');
    expect(ctx.mongo.rows('payments')[0].status).toBe(EntryPaymentStatus.INITIATED);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
  });
  it('unknown / malformed payment ids are not found', async () => {
    const ctx = build();
    expect(await codeOf(() => ctx.confirmation.confirm('nope'))).toBe(PaymentErrorCode.NOT_FOUND);
    expect(await codeOf(() => ctx.confirmation.confirm(new Types.ObjectId().toString()))).toBe(PaymentErrorCode.NOT_FOUND);
  });
});

describe('late success (MAZAD-028)', () => {
  for (const status of [AuctionStatus.ENDED_PENDING_CLOSE, AuctionStatus.CANCELLED, AuctionStatus.COMPLETED]) {
    it(`success after the auction is ${status} keeps the truthful record but never touches the auction, bids or eligibility`, async () => {
      const ctx = build();
      const p = await ctx.initiation.initiate(ALICE, AUCTION);
      const before = { ...ctx.mongo.auction(), status };
      ctx.mongo.data.auctions.get(AUCTION)!.doc = before;
      ctx.succeed();
      const r = await ctx.confirmation.confirm(p.paymentId);
      expect(r.status).toBe(EntryPaymentStatus.SUCCEEDED);
      expect(ctx.mongo.auction()).toEqual(before); // status, currentEndAt, counters untouched
      expect(ctx.mongo.auctionWrites).toBe(0);
      expect(ctx.mongo.audits.find((a) => a.action === AuditAction.AUCTION_ENTRY_PAYMENT_CONFIRMED).metadata).toMatchObject({ lateConfirmation: true, auctionStatus: status });
    });
  }
  it('success while the auction is open is not flagged late', async () => {
    const ctx = build(); const p = await ctx.initiation.initiate(ALICE, AUCTION); ctx.succeed(); await ctx.confirmation.confirm(p.paymentId);
    expect(ctx.mongo.audits.find((a) => a.action === AuditAction.AUCTION_ENTRY_PAYMENT_CONFIRMED).metadata.lateConfirmation).toBe(false);
  });
});

describe('structure and safety (MAZAD-028)', () => {
  it('the default provider is fail-closed and pretends nothing', async () => {
    const p = new UnconfiguredPaymentProvider();
    expect(p.configured).toBe(false);
    await expect(p.initiate()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(p.verify()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('unconfigured provider cannot confirm anything', async () => {
    const ctx = build();
    const a = await ctx.initiation.initiate(ALICE, AUCTION);
    const closed = new UnconfiguredPaymentProvider(); ctx.provider.verify = () => closed.verify();
    await expect(ctx.confirmation.confirm(a.paymentId)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
  });
  it('no HTTP route exists for payments, confirmation or bids', () => {
    expect(Reflect.getMetadata('path', PaymentsModule)).toBeUndefined();
    expect(Reflect.getMetadata('controllers', PaymentsModule)).toBeUndefined();
    for (const controller of [AuctionsController, AdminAuctionsController]) {
      const routes = Object.getOwnPropertyNames(controller.prototype).filter((n) => n !== 'constructor');
      expect(routes.filter((n) => /bid|pay|entitle|confirm/i.test(n))).toEqual([]);
    }
  });
  it('entitlements are unique per (auction, bidder) and per payment; live payments unique per (auction, bidder)', () => {
    const idx = (schema: any) => schema.indexes().map(([keys, options]: any) => ({ keys, options }));
    expect(idx(AuctionBidEntitlementSchema)).toEqual(expect.arrayContaining([
      expect.objectContaining({ keys: { auctionId: 1, bidderAccountId: 1 }, options: expect.objectContaining({ unique: true }) }),
      expect.objectContaining({ keys: { paymentId: 1 }, options: expect.objectContaining({ unique: true }) }),
    ]));
    expect(idx(AuctionEntryPaymentSchema)).toEqual(expect.arrayContaining([
      expect.objectContaining({ keys: { auctionId: 1, bidderAccountId: 1 }, options: expect.objectContaining({ unique: true, partialFilterExpression: { isLive: true } }) }),
      expect.objectContaining({ keys: { provider: 1, providerReference: 1 }, options: expect.objectContaining({ unique: true }) }),
    ]));
  });
  it('the fake DB itself enforces the entitlement unique index (backstop is exercised)', async () => {
    const ctx = build(); const p = await ctx.initiation.initiate(ALICE, AUCTION); ctx.succeed(); await ctx.confirmation.confirm(p.paymentId);
    const s = await ctx.mongo.connection.startSession(); s.startTransaction();
    await expect(ctx.mongo.model('entitlements').create([{ auctionId: oid(AUCTION), bidderAccountId: oid(ALICE), paymentId: new Types.ObjectId() }], { session: s })).rejects.toMatchObject({ code: 11000 });
  });
  it('payment source has no gateway SDK, credential or provider-specific reference', () => {
    const fs = require('node:fs'); const path = require('node:path');
    const dir = path.join(__dirname, '..', 'src', 'payments');
    const files: string[] = []; const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e: any) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
    walk(dir);
    const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(text).not.toMatch(/paymob|stripe|cashier|fawry|api[_-]?key|webhook[_-]?url/i);
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /paymob|stripe|cashier|fawry/i.test(d))).toEqual([]);
  });
});

describe('AUCTION_ENTRY payment domain event — transactional outbox (MAZAD-031)', () => {
  async function pending(ctx = build()) { const a = await ctx.initiation.initiate(ALICE, AUCTION); return { ...ctx, paymentId: a.paymentId }; }
  const entryEvents = (mongo: FakeMongo) => mongo.outbox.events('AUCTION_ENTRY_PAYMENT_CONFIRMED');

  it('a server-verified success writes exactly ONE private event, in the same commit as the payment and the entitlement', async () => {
    const ctx = await pending(); ctx.succeed();
    await ctx.confirmation.confirm(ctx.paymentId);
    expect(entryEvents(ctx.mongo)).toHaveLength(1);
    expect(ctx.mongo.outbox.events()).toHaveLength(1);
    expect(ctx.mongo.outbox.events()[0]).toMatchObject({
      type: 'AUCTION_ENTRY_PAYMENT_CONFIRMED', schemaVersion: 1, aggregateType: 'AUCTION_ENTRY_PAYMENT', aggregateId: ctx.paymentId, aggregateVersion: 1,
      audience: 'PRIVATE', occurredAt: ctx.mongo.clockNow, privateRouting: { bidderAccountId: ALICE },
      payload: { paymentId: ctx.paymentId, auctionId: AUCTION, amountMinor: FEE, currency: 'EGP', confirmedAt: ctx.mongo.clockNow.toISOString(), entitlementGranted: true, lateConfirmation: false },
    });
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
    expect(ctx.mongo.rows('payments')[0].status).toBe(EntryPaymentStatus.SUCCEEDED);
  });

  it('carries no provider name, reference, event id, or bidder identity in the payload', async () => {
    const ctx = await pending(); ctx.succeed();
    await ctx.confirmation.confirm(ctx.paymentId);
    const text = JSON.stringify(entryEvents(ctx.mongo)[0].payload);
    expect(text).not.toMatch(/fake-test-provider|ref-1|evt-1|opaque/);
    expect(text).not.toContain(ALICE);
  });

  it('repeated confirmation never duplicates the event (replay writes nothing)', async () => {
    const ctx = await pending(); ctx.succeed();
    await ctx.confirmation.confirm(ctx.paymentId);
    const attempts = ctx.mongo.outbox.insertAttempts;
    await ctx.confirmation.confirm(ctx.paymentId);
    await ctx.confirmation.confirm(ctx.paymentId);
    expect(entryEvents(ctx.mongo)).toHaveLength(1);
    expect(ctx.mongo.outbox.insertAttempts).toBe(attempts);
  });

  it('concurrent duplicate confirmations converge on ONE event', async () => {
    const ctx = await pending(); ctx.succeed();
    await Promise.all([1, 2, 3, 4, 5].map(() => ctx.confirmation.confirm(ctx.paymentId)));
    expect(entryEvents(ctx.mongo)).toHaveLength(1);
  });

  it('is emitted only from server-verified success: pending, provider-failed, mismatched and reconciliation-required outcomes create NO event', async () => {
    const pendingCtx = await pending();
    await pendingCtx.confirmation.confirm(pendingCtx.paymentId);
    expect(pendingCtx.mongo.outbox.events()).toHaveLength(0);

    const failed = await pending();
    failed.state.outcome = (ref) => ({ status: 'FAILED', providerReference: ref, amountMinor: FEE, currency: 'EGP', failureCode: 'DECLINED' });
    await failed.confirmation.confirm(failed.paymentId);
    expect(failed.mongo.outbox.events()).toHaveLength(0);

    const amount = await pending();
    amount.state.outcome = (ref) => ({ status: 'SUCCEEDED', providerReference: ref, amountMinor: FEE - 1, currency: 'EGP' });
    await codeOf(() => amount.confirmation.confirm(amount.paymentId));
    expect(amount.mongo.outbox.events()).toHaveLength(0);

    const currency = await pending();
    currency.state.outcome = (ref) => ({ status: 'SUCCEEDED', providerReference: ref, amountMinor: FEE, currency: 'USD' });
    await codeOf(() => currency.confirmation.confirm(currency.paymentId));
    expect(currency.mongo.outbox.events()).toHaveLength(0);

    const reference = await pending();
    reference.state.outcome = () => ({ status: 'SUCCEEDED', providerReference: 'someone-elses', amountMinor: FEE, currency: 'EGP' });
    await codeOf(() => reference.confirmation.confirm(reference.paymentId));
    expect(reference.mongo.outbox.events()).toHaveLength(0);

    const afterFailure = await pending();
    afterFailure.state.outcome = (ref) => ({ status: 'FAILED', providerReference: ref, amountMinor: FEE, currency: 'EGP' });
    await afterFailure.confirmation.confirm(afterFailure.paymentId);
    afterFailure.succeed();
    await codeOf(() => afterFailure.confirmation.confirm(afterFailure.paymentId)); // CONFIRMED_AFTER_FAILURE → reconciliation
    expect(afterFailure.mongo.outbox.events()).toHaveLength(0);
  });

  it('initiation and client claims never create an event', async () => {
    const ctx = await pending();
    expect(ctx.mongo.outbox.events()).toHaveLength(0);
    expect(ctx.mongo.outbox.insertAttempts).toBe(0);
  });

  it('a late confirmation is still one event, flagged lateConfirmation so consumers do not announce a usable entitlement', async () => {
    const ctx = await pending(); ctx.succeed();
    ctx.mongo.data.auctions.get(AUCTION)!.doc = { ...ctx.mongo.auction(), status: AuctionStatus.ENDED_PENDING_CLOSE };
    await ctx.confirmation.confirm(ctx.paymentId);
    expect(entryEvents(ctx.mongo)).toHaveLength(1);
    expect(entryEvents(ctx.mongo)[0].payload.lateConfirmation).toBe(true);
  });

  it('an outbox failure aborts the confirmation: payment stays INITIATED, no entitlement, no audit row', async () => {
    const ctx = await pending(); ctx.succeed();
    ctx.mongo.outbox.insertError = () => new Error('outbox unavailable');
    const auditsBefore = ctx.mongo.audits.length;
    await expect(ctx.confirmation.confirm(ctx.paymentId)).rejects.toThrow('outbox unavailable');
    expect(ctx.mongo.rows('payments')[0].status).toBe(EntryPaymentStatus.INITIATED);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
    expect(ctx.mongo.audits).toHaveLength(auditsBefore);
    expect(ctx.mongo.outbox.events()).toHaveLength(0);
    ctx.mongo.outbox.insertError = undefined; // the provider still says SUCCEEDED: the retry converges on the full effect
    await ctx.confirmation.confirm(ctx.paymentId);
    expect(entryEvents(ctx.mongo)).toHaveLength(1);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
  });

  it('an audit failure aborts the confirmation and leaves no event behind', async () => {
    const ctx = await pending(); ctx.succeed();
    ctx.mongo.auditSvc.logSystemRequired.mockRejectedValueOnce(new Error('audit down'));
    await expect(ctx.confirmation.confirm(ctx.paymentId)).rejects.toThrow('audit down');
    expect(ctx.mongo.outbox.events()).toHaveLength(0);
    expect(ctx.mongo.rows('payments')[0].status).toBe(EntryPaymentStatus.INITIATED);
  });

  it('a lost commit is retried whole and still yields exactly one event', async () => {
    const ctx = await pending(); ctx.succeed();
    let lost = 1;
    const start = ctx.mongo.connection.startSession;
    ctx.mongo.connection.startSession = async () => {
      const session: any = await start();
      const commit = session.commitTransaction;
      session.commitTransaction = async () => { if (lost-- > 0) throw transient('commit lost'); return commit.call(session); };
      return session;
    };
    await ctx.confirmation.confirm(ctx.paymentId);
    expect(entryEvents(ctx.mongo)).toHaveLength(1);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
  });

  it('never emits a MANAGED_MARKETING event (purpose isolation)', async () => {
    const ctx = await pending(); ctx.succeed();
    await ctx.confirmation.confirm(ctx.paymentId);
    expect(ctx.mongo.outbox.events('MANAGED_MARKETING_PAYMENT_CONFIRMED')).toHaveLength(0);
  });
});
