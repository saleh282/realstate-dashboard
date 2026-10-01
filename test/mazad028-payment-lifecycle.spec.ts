import { Types } from 'mongoose';
import { AuctionStatus } from '../src/auctions/auction.types';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';
import { SystemRole } from '../src/auth/roles.enum';
import { PaymentErrorCode } from '../src/common/errors/payment-error-codes';
import { operationalMetrics } from '../src/common/observability/operational-metrics';
import { validateEnvironment } from '../src/config/environment.validation';
import { ManagedMarketingPaymentStatus, ManagedMarketingRequestStatus } from '../src/managed-marketing/managed-marketing.types';
import { AuctionEntryPaymentService } from '../src/payments/auction-entry-payment.service';
import { AuctionPaymentConfirmationService } from '../src/payments/auction-payment-confirmation.service';
import { AuctionPaymentProviderPort, UnconfiguredPaymentProvider } from '../src/payments/auction-payment-provider.port';
import { FakePaymentProvider } from '../src/payments/fake-payment-provider';
import { ManagedMarketingPaymentConfirmationService } from '../src/payments/managed-marketing-payment-confirmation.service';
import { ManagedMarketingPaymentService } from '../src/payments/managed-marketing-payment.service';
import { INITIATION_CLAIM_LEASE_MS, UNREFERENCED_ATTEMPT_GRACE_MS } from '../src/payments/payment-attempt-opening';
import { PaymentConfirmationRouter } from '../src/payments/payment-confirmation-router.service';
import {
  DEV_PAYMENT_ATTEMPT_TTL_SECONDS, paymentAttemptTtlMs, paymentReconciliationErrors, reconciliationBackoffMs, reconciliationLeaseMs,
} from '../src/payments/payment-reconciliation.config';
import { PaymentReconciliationService } from '../src/payments/payment-reconciliation.service';
import { PaymentReconciliationWorker } from '../src/payments/payment-reconciliation.worker';
import { EntryPaymentStatus, PaymentPurpose, PaymentReconciliationFlag } from '../src/payments/payment.types';
import { PersistentBidEntitlementPort } from '../src/payments/persistent-bid-entitlement.port';
import { AuctionEntryEntitlementService, EntryEntitlementState } from '../src/payments/auction-entry-entitlement.service';
import { FakeMongo } from './support/fake-payments-mongo';

/**
 * MAZAD-028 remainder — the payment LIFECYCLE: one provider order per attempt,
 * the EXPIRED state, confirmation routing by provider reference, the shared
 * reconciliation worker (claim/lease, backoff, crash recovery, expiry with a
 * final verification) and late success. In-memory Mongo MODEL (see
 * support/fake-payments-mongo.ts) driven by the real FakePaymentProvider; the
 * real-Mongo qualification is `mazad028-payment-e2e.spec.ts`.
 */
const oid = (hex: string) => new Types.ObjectId(hex);
const AUCTION = '64b000000000000000000f01';
const ADVERTISER = '64b000000000000000000a10';
const ALICE = '64b000000000000000000a11';
const BOB = '64b000000000000000000a12';
const OWNER = '64b000000000000000000a13';
const ADMIN = '64b000000000000000000a20';
const REQUEST = '64b000000000000000000c01';
const FEE = 25_000;
const PRICE = 1_500_000; // test data only — a made-up fixture, not a product price
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const codeOf = async (action: () => Promise<unknown>) => { try { await action(); return undefined; } catch (error) { return (error as any).getResponse?.()?.code ?? (error as Error).message; } };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const configOf = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] }) as any;

function world(opts: { scenario?: 'success' | 'failed' | 'pending' | 'error'; env?: Record<string, unknown>; provider?: AuctionPaymentProviderPort; auction?: Record<string, unknown> } = {}) {
  const mongo = new FakeMongo();
  mongo.seedAuction({ entryFee: { amountMinor: FEE, currency: 'EGP', configuredByActorId: oid(ADMIN), configuredAt: new Date() }, ...opts.auction });
  for (const id of [ADVERTISER, ALICE, BOB, OWNER]) mongo.seedUser(id);
  mongo.seedUser(ADMIN, { systemRole: SystemRole.ADMIN });
  mongo.data.requests.set(REQUEST, {
    version: 1,
    doc: {
      _id: oid(REQUEST), propertyId: oid('64b000000000000000000b01'), propertyRevisionId: oid('64b000000000000000000b02'), advertiserAccountId: oid(OWNER),
      status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: ManagedMarketingPaymentStatus.AWAITING_PAYMENT,
      packageSnapshot: { packageId: oid('64b000000000000000000d01'), code: 'any-tier', priceMinor: PRICE, currency: 'EGP' },
    },
  });
  const fake = new FakePaymentProvider(opts.scenario ?? 'pending');
  const provider = opts.provider ?? fake;
  const clock = { now: () => mongo.clockNow };
  const deps = {
    auctions: mongo.model('auctions'), users: mongo.model('users'), payments: mongo.model('payments'), entitlements: mongo.model('entitlements'),
    requests: mongo.model('requests'), audit: mongo.auditSvc, clock, provider, connection: mongo.connection, outbox: mongo.outbox.service,
  };
  const mmDeps = { ...deps, payments: mongo.model('mmPayments') };
  const initiation = Object.assign(Object.create(AuctionEntryPaymentService.prototype), deps) as AuctionEntryPaymentService;
  const confirmation = Object.assign(Object.create(AuctionPaymentConfirmationService.prototype), deps) as AuctionPaymentConfirmationService;
  const mmInitiation = Object.assign(Object.create(ManagedMarketingPaymentService.prototype), mmDeps) as ManagedMarketingPaymentService;
  const mmConfirmation = Object.assign(Object.create(ManagedMarketingPaymentConfirmationService.prototype), mmDeps) as ManagedMarketingPaymentConfirmationService;
  const router = Object.assign(Object.create(PaymentConfirmationRouter.prototype), {
    entryPayments: mongo.model('payments'), marketingPayments: mongo.model('mmPayments'), auctionEntry: confirmation, managedMarketing: mmConfirmation,
  }) as PaymentConfirmationRouter;
  const env = { NODE_ENV: 'development', DEPLOYMENT_ENV: 'local', PAYMENT_ATTEMPT_TTL_SECONDS: '600', ...opts.env };
  const config = configOf(env);
  const reconciliation = new PaymentReconciliationService(router, clock as any, config);
  const port = new PersistentBidEntitlementPort(mongo.model('entitlements') as any);
  const advance = (ms: number) => { mongo.clockNow = new Date(mongo.clockNow.getTime() + ms); };
  const payment = (id?: string) => (id ? mongo.rows('payments').find((row) => String(row._id) === id) : mongo.rows('payments')[0]);
  const mmPayment = (id?: string) => (id ? mongo.rows('mmPayments').find((row) => String(row._id) === id) : mongo.rows('mmPayments')[0]);
  const request = () => mongo.data.requests.get(REQUEST)!.doc;
  const audits = (action: AuditAction) => mongo.audits.filter((row) => row.action === action);
  const events = () => mongo.outbox.events('AUCTION_ENTRY_PAYMENT_CONFIRMED');
  return { mongo, fake, provider, initiation, confirmation, mmInitiation, mmConfirmation, router, reconciliation, config, env, port, clock, advance, payment, mmPayment, request, audits, events };
}
const entitled = async (ctx: ReturnType<typeof world>, bidder = ALICE) => {
  const session = await ctx.mongo.connection.startSession(); session.startTransaction();
  return (await codeOf(() => ctx.port.assertEntitled({ auctionId: AUCTION, bidderAccountId: bidder, session, entryFee: ctx.mongo.auction().entryFee }))) === undefined;
};

beforeEach(() => operationalMetrics.reset());

// ---------------------------------------------------------------------------------------------------------------------
describe('initiation race: one live payment, ONE provider order, only a persisted reference is returned', () => {
  /** A provider whose `initiate` is slow enough for every concurrent request to be inside the window. */
  const slowProvider = (delayMs = 40) => {
    const calls: any[] = [];
    let n = 0;
    const provider: AuctionPaymentProviderPort = {
      providerKey: 'slow', configured: true,
      initiate: async (request) => { calls.push(request); const reference = `order-${++n}`; await pause(delayMs); return { providerReference: reference, clientHandoff: `https://pay.invalid/${reference}` }; },
      verify: async (reference) => ({ status: 'PENDING', providerReference: reference, amountMinor: FEE, currency: 'EGP' }),
    };
    return { provider, calls };
  };

  it('AUCTION_ENTRY: simultaneous initiations open exactly one provider order and all answer the SAME persisted reference', async () => {
    const { provider, calls } = slowProvider();
    const ctx = world({ provider });
    const settled = await Promise.allSettled([1, 2, 3, 4, 5].map(() => ctx.initiation.initiate(ALICE, AUCTION)));
    expect(calls).toHaveLength(1);
    expect(ctx.mongo.rows('payments')).toHaveLength(1);
    expect(ctx.payment()).toMatchObject({ status: 'INITIATED', providerReference: 'order-1', clientHandoff: 'https://pay.invalid/order-1' });
    const answers = settled.filter((item): item is PromiseFulfilledResult<any> => item.status === 'fulfilled').map((item) => item.value);
    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) expect(answer).toMatchObject({ providerReference: 'order-1', clientHandoff: 'https://pay.invalid/order-1', status: 'INITIATED' });
    // Whoever could not be answered was told to retry — never handed an untracked reference.
    for (const item of settled) if (item.status === 'rejected') expect((item.reason as any).getResponse().code).toBe(PaymentErrorCode.INITIATION_IN_PROGRESS);
    expect(answers.filter((answer) => !answer.reused)).toHaveLength(1);
  });

  it('MANAGED_MARKETING: simultaneous initiations open exactly one provider order', async () => {
    const calls: any[] = [];
    let n = 0;
    const provider: AuctionPaymentProviderPort = {
      providerKey: 'slow', configured: true,
      initiate: async (request) => { calls.push(request); const reference = `mm-order-${++n}`; await pause(40); return { providerReference: reference, clientHandoff: 'opaque' }; },
      verify: async (reference) => ({ status: 'PENDING', providerReference: reference, amountMinor: PRICE, currency: 'EGP' }),
    };
    const ctx = world({ provider });
    const settled = await Promise.allSettled([1, 2, 3, 4].map(() => ctx.mmInitiation.initiate(OWNER, REQUEST)));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: PaymentPurpose.MANAGED_MARKETING, amountMinor: PRICE });
    expect(ctx.mongo.rows('mmPayments')).toHaveLength(1);
    expect(ctx.mmPayment().providerReference).toBe('mm-order-1');
    for (const item of settled) {
      if (item.status === 'fulfilled') expect(item.value.providerReference).toBe('mm-order-1');
      else expect((item.reason as any).getResponse().code).toBe(PaymentErrorCode.INITIATION_IN_PROGRESS);
    }
  });

  it('a request whose compare-and-set lost never returns its own (unpersisted) reference: it returns the stored one', async () => {
    const ctx = world();
    // While this request is at the provider, another writer persists a different reference on the same attempt.
    const provider: AuctionPaymentProviderPort = {
      providerKey: 'fake', configured: true,
      initiate: async () => {
        const row = ctx.payment();
        row.providerReference = 'stored-by-the-winner'; row.clientHandoff = 'winner-handoff';
        return { providerReference: 'mine-and-unpersisted', clientHandoff: 'mine' };
      },
      verify: async (reference) => ({ status: 'PENDING', providerReference: reference, amountMinor: FEE, currency: 'EGP' }),
    };
    (ctx.initiation as any).provider = provider;
    const answer = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(answer).toMatchObject({ providerReference: 'stored-by-the-winner', clientHandoff: 'winner-handoff', reused: true });
    expect(JSON.stringify(answer)).not.toContain('mine');
    expect(ctx.payment().providerReference).toBe('stored-by-the-winner');
  });

  it('a persisting compare-and-set that lost to a terminal attempt answers a retryable conflict, not a reference', async () => {
    const ctx = world();
    (ctx.initiation as any).provider = {
      providerKey: 'fake', configured: true,
      initiate: async () => { const row = ctx.payment(); row.status = EntryPaymentStatus.FAILED; delete row.isLive; return { providerReference: 'unpersisted' }; },
      verify: async () => { throw new Error('unused'); },
    };
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.INITIATION_IN_PROGRESS);
    expect(ctx.payment().providerReference).toBeUndefined();
  });

  it('a reference-less live attempt whose claim is still FRESH is not opened a second time; a STALE claim is taken over', async () => {
    const ctx = world({ scenario: 'pending' });
    const seeded = { _id: new Types.ObjectId(), auctionId: oid(AUCTION), bidderAccountId: oid(ALICE), amountMinor: FEE, currency: 'EGP', status: 'INITIATED', isLive: true, initiatedAt: ctx.mongo.clockNow, provider: 'fake', initiationClaimedAt: ctx.mongo.clockNow };
    ctx.mongo.data.payments.set(String(seeded._id), { doc: seeded, version: 1 });
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.INITIATION_IN_PROGRESS);
    expect(ctx.fake.calls.initiate).toBe(0);
    // The opener died: once its lease lapsed, the next request takes the claim over and opens the attempt.
    ctx.advance(INITIATION_CLAIM_LEASE_MS);
    const answer = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(ctx.fake.calls.initiate).toBe(1);
    expect(answer.providerReference).toBe(ctx.payment().providerReference);
    expect(ctx.payment().initiationClaimedAt).toBeUndefined();
  }, 15_000);

  it('the stored hand-off of the SAME live attempt is returned again (lost response / app restart), without a second provider call', async () => {
    const ctx = world();
    const first = await ctx.initiation.initiate(ALICE, AUCTION);
    const again = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(first.clientHandoff).toMatch(/^fake:\/\/checkout\//);
    expect(again).toMatchObject({ paymentId: first.paymentId, providerReference: first.providerReference, clientHandoff: first.clientHandoff, reused: true });
    expect(ctx.fake.calls.initiate).toBe(1);
  });

  it('a provider refusal while opening fails only the reference-less attempt and frees the slot for a new one', async () => {
    const ctx = world({ scenario: 'pending' });
    ctx.fake.enqueue('error');
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.PROVIDER_UNAVAILABLE);
    expect(ctx.payment()).toMatchObject({ status: 'FAILED', failureCode: 'PROVIDER_INITIATION_FAILED' });
    const retry = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(retry.reused).toBe(false);
    expect(ctx.mongo.rows('payments')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('EXPIRED: a real terminal state', () => {
  it('INITIATED -> EXPIRED releases the live slot, keeps the row, audits, grants nothing, and allows a new attempt', async () => {
    const ctx = world();
    const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(await ctx.confirmation.expire(attempt.paymentId)).toBe(true);
    const row = ctx.payment(attempt.paymentId);
    expect(row).toMatchObject({ status: 'EXPIRED', expiredAt: ctx.mongo.clockNow });
    expect(row.isLive).toBeUndefined();
    expect(ctx.audits(AuditAction.AUCTION_ENTRY_PAYMENT_EXPIRED)).toHaveLength(1);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
    expect(await entitled(ctx)).toBe(false);
    const retry = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(retry).toMatchObject({ reused: false });
    expect(retry.paymentId).not.toBe(attempt.paymentId);
    expect(ctx.mongo.rows('payments').map((item) => item.status).sort()).toEqual(['EXPIRED', 'INITIATED']);
  });

  it('expire is a compare-and-set on INITIATED: it never touches a SUCCEEDED, FAILED, EXPIRED or flagged attempt', async () => {
    const ctx = world();
    const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.fake.settle(attempt.providerReference!, 'success');
    await ctx.confirmation.confirm(attempt.paymentId);
    expect(await ctx.confirmation.expire(attempt.paymentId)).toBe(false);
    expect(ctx.payment().status).toBe('SUCCEEDED');
    expect(ctx.audits(AuditAction.AUCTION_ENTRY_PAYMENT_EXPIRED)).toHaveLength(0);

    const flagged = world();
    const other = await flagged.initiation.initiate(ALICE, AUCTION);
    flagged.payment().reconciliationFlag = PaymentReconciliationFlag.AMOUNT_MISMATCH;
    expect(await flagged.confirmation.expire(other.paymentId)).toBe(false);
    expect(flagged.payment().status).toBe('INITIATED');
  });

  it('an expiry racing a success confirmation ends in exactly one terminal state, and never both EXPIRED and entitled', async () => {
    for (let round = 0; round < 6; round++) {
      const ctx = world();
      const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
      ctx.fake.settle(attempt.providerReference!, 'success');
      await Promise.allSettled([ctx.confirmation.confirm(attempt.paymentId), ctx.confirmation.expire(attempt.paymentId)]);
      const row = ctx.payment();
      expect(['SUCCEEDED', 'EXPIRED']).toContain(row.status);
      expect(ctx.mongo.rows('entitlements')).toHaveLength(row.status === 'SUCCEEDED' ? 1 : 0);
      expect(ctx.events()).toHaveLength(row.status === 'SUCCEEDED' ? 1 : 0);
    }
  });

  it('the entitlement read keeps the wire state PAYMENT_FAILED for an expired attempt and exposes payment.status = EXPIRED', async () => {
    const ctx = world();
    const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
    await ctx.confirmation.expire(attempt.paymentId);
    const read = Object.assign(Object.create(AuctionEntryEntitlementService.prototype), {
      queries: { getPubliclyVisible: async () => ({ doc: ctx.mongo.auction() }) }, users: ctx.mongo.model('users'), payments: ctx.mongo.model('payments'),
      entitlements: ctx.mongo.model('entitlements'), clock: ctx.clock, provider: ctx.provider,
    }) as AuctionEntryEntitlementService;
    const status = await read.getStatus(ALICE, AUCTION);
    expect(status).toMatchObject({ state: EntryEntitlementState.PAYMENT_FAILED, entitled: false, canInitiate: true, blockedReason: null });
    expect(status.payment).toMatchObject({ paymentId: attempt.paymentId, status: 'EXPIRED', expiredAt: ctx.mongo.clockNow, failedAt: null });
    expect(Object.values(EntryEntitlementState)).not.toContain('PAYMENT_EXPIRED'); // older app builds reject unknown states
  });

  it('MANAGED_MARKETING expiry returns the request to its payable AND cancellable state, and a new attempt can be opened', async () => {
    const ctx = world();
    const attempt = await ctx.mmInitiation.initiate(OWNER, REQUEST);
    expect(ctx.request().paymentStatus).toBe(ManagedMarketingPaymentStatus.PENDING);
    expect(await ctx.mmConfirmation.expire(attempt.paymentId)).toBe(true);
    expect(ctx.mmPayment(attempt.paymentId)).toMatchObject({ status: 'EXPIRED' });
    expect(ctx.mmPayment(attempt.paymentId).isLive).toBeUndefined();
    expect(ctx.request()).toMatchObject({ status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: ManagedMarketingPaymentStatus.FAILED });
    expect(ctx.audits(AuditAction.MANAGED_MARKETING_PAYMENT_EXPIRED)).toHaveLength(1);
    const retry = await ctx.mmInitiation.initiate(OWNER, REQUEST);
    expect(retry.reused).toBe(false);
    ctx.fake.settle(retry.providerReference!, 'success');
    expect(await ctx.mmConfirmation.confirm(retry.paymentId)).toMatchObject({ requestPaid: true });
    expect(ctx.request()).toMatchObject({ status: ManagedMarketingRequestStatus.PAID, paymentStatus: ManagedMarketingPaymentStatus.SUCCEEDED });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('late success after local expiry: recorded, flagged, never applied', () => {
  async function expiredThenPaid(ctx = world()) {
    const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
    await ctx.confirmation.expire(attempt.paymentId);
    ctx.fake.settle(attempt.providerReference!, 'success');
    return { ctx, attempt };
  }

  it('flags CONFIRMED_AFTER_EXPIRY, keeps the provider truth, grants no entitlement and emits no event', async () => {
    const { ctx, attempt } = await expiredThenPaid();
    expect(await codeOf(() => ctx.confirmation.confirm(attempt.paymentId))).toBe(PaymentErrorCode.CONFIRMED_AFTER_EXPIRY);
    const row = ctx.payment(attempt.paymentId);
    expect(row).toMatchObject({ status: 'EXPIRED', reconciliationFlag: PaymentReconciliationFlag.CONFIRMED_AFTER_EXPIRY });
    expect(row.providerEventId).toMatch(/^fake-event-/);
    expect(row.isLive).toBeUndefined();
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
    expect(await entitled(ctx)).toBe(false);
    expect(ctx.mongo.outbox.events()).toHaveLength(0);
    const rejected = ctx.audits(AuditAction.AUCTION_ENTRY_PAYMENT_REJECTED);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].metadata).toMatchObject({ flag: 'CONFIRMED_AFTER_EXPIRY', paymentStatus: 'EXPIRED', reportedStatus: 'SUCCEEDED', reportedAmountMinor: FEE });
  });

  it('a repeated trigger keeps rejecting without a second flag write or audit row', async () => {
    const { ctx, attempt } = await expiredThenPaid();
    for (let i = 0; i < 3; i++) expect(await codeOf(() => ctx.confirmation.confirm(attempt.paymentId))).toBe(PaymentErrorCode.CONFIRMED_AFTER_EXPIRY);
    expect(ctx.audits(AuditAction.AUCTION_ENTRY_PAYMENT_REJECTED)).toHaveLength(1);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
  });

  it('an expired attempt the provider still calls pending or failed is simply already processed (no flag)', async () => {
    const ctx = world();
    const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
    await ctx.confirmation.expire(attempt.paymentId);
    expect(await ctx.confirmation.confirm(attempt.paymentId)).toMatchObject({ status: 'EXPIRED', alreadyProcessed: true, entitlementGranted: false });
    ctx.fake.settle(attempt.providerReference!, 'failed');
    expect(await ctx.confirmation.confirm(attempt.paymentId)).toMatchObject({ status: 'EXPIRED', alreadyProcessed: true });
    expect(ctx.payment().reconciliationFlag).toBeUndefined();
  });

  it('the flagged bidder cannot open another attempt (an operator must reconcile first) — never a second charge by default', async () => {
    const { ctx, attempt } = await expiredThenPaid();
    await codeOf(() => ctx.confirmation.confirm(attempt.paymentId));
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.RECONCILIATION_REQUIRED);
  });

  it('MANAGED_MARKETING: success after expiry parks the request for the operator and never marks it PAID', async () => {
    const ctx = world();
    const attempt = await ctx.mmInitiation.initiate(OWNER, REQUEST);
    await ctx.mmConfirmation.expire(attempt.paymentId);
    ctx.fake.settle(attempt.providerReference!, 'success');
    expect(await codeOf(() => ctx.mmConfirmation.confirm(attempt.paymentId))).toBe(PaymentErrorCode.CONFIRMED_AFTER_EXPIRY);
    expect(ctx.mmPayment()).toMatchObject({ status: 'EXPIRED', reconciliationFlag: 'CONFIRMED_AFTER_EXPIRY' });
    expect(ctx.request()).toMatchObject({ status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: ManagedMarketingPaymentStatus.RECONCILIATION_REQUIRED });
    expect(ctx.request().paidAt).toBeUndefined();
    expect(ctx.mongo.outbox.events()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('confirmation routing by provider reference (a trigger carries no outcome)', () => {
  it('routes each reference to the purpose that owns it', async () => {
    const ctx = world();
    const entry = await ctx.initiation.initiate(ALICE, AUCTION);
    const marketing = await ctx.mmInitiation.initiate(OWNER, REQUEST);
    ctx.fake.settle(entry.providerReference!, 'success');
    ctx.fake.settle(marketing.providerReference!, 'success');
    expect(await ctx.router.confirmByProviderReference('fake', entry.providerReference!)).toEqual({ purpose: PaymentPurpose.AUCTION_ENTRY, paymentId: entry.paymentId, status: 'SUCCEEDED', pending: false });
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
    expect(ctx.request().status).toBe(ManagedMarketingRequestStatus.APPROVED); // the auction payment paid nothing else
    expect(await ctx.router.confirmByProviderReference('fake', marketing.providerReference!)).toMatchObject({ purpose: PaymentPurpose.MANAGED_MARKETING, status: 'SUCCEEDED' });
    expect(ctx.request().status).toBe(ManagedMarketingRequestStatus.PAID);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
  });

  it('an unknown reference, a wrong provider key or malformed input is not found and changes nothing', async () => {
    const ctx = world();
    const entry = await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.fake.settle(entry.providerReference!, 'success');
    expect(await codeOf(() => ctx.router.confirmByProviderReference('fake', 'fake~pending~1~EGP~nobody~00000000'))).toBe(PaymentErrorCode.NOT_FOUND);
    expect(await codeOf(() => ctx.router.confirmByProviderReference('another-provider', entry.providerReference!))).toBe(PaymentErrorCode.NOT_FOUND);
    expect(await codeOf(() => ctx.router.confirmByProviderReference('', ''))).toBe(PaymentErrorCode.NOT_FOUND);
    expect(await codeOf(() => ctx.router.confirmByProviderReference({ $ne: null } as any, { $ne: null } as any))).toBe(PaymentErrorCode.NOT_FOUND);
    expect(ctx.payment().status).toBe('INITIATED');
    expect(ctx.fake.calls.verify).toBe(0);
  });

  it('has no parameter through which a caller could state an outcome, an amount or a status', () => {
    expect(PaymentConfirmationRouter.prototype.confirmByProviderReference.length).toBe(2);
    expect(AuctionPaymentConfirmationService.prototype.confirm.length).toBe(1);
    expect(ManagedMarketingPaymentConfirmationService.prototype.confirm.length).toBe(1);
    expect(AuctionPaymentConfirmationService.prototype.expire.length).toBe(1);
  });

  it('a trigger for a still-pending payment changes nothing; a duplicate trigger after success is an idempotent replay', async () => {
    const ctx = world();
    const entry = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(await ctx.router.confirmByProviderReference('fake', entry.providerReference!)).toMatchObject({ status: 'INITIATED', pending: true });
    ctx.fake.settle(entry.providerReference!, 'success');
    await Promise.all([1, 2, 3, 4].map(() => ctx.router.confirmByProviderReference('fake', entry.providerReference!)));
    await ctx.router.confirmByProviderReference('fake', entry.providerReference!);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
    expect(ctx.events()).toHaveLength(1);
    expect(ctx.audits(AuditAction.AUCTION_ENTRY_PAYMENT_CONFIRMED)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('reconciliation worker pass', () => {
  it('provider success -> SUCCEEDED + exactly one entitlement, through the normal confirmation path', async () => {
    const ctx = world({ scenario: 'success' });
    const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(ctx.payment().status).toBe('INITIATED'); // initiating grants nothing
    expect(await entitled(ctx)).toBe(false);
    const summary = await ctx.reconciliation.reconcileDue(10);
    expect(summary).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(ctx.payment(attempt.paymentId)).toMatchObject({ status: 'SUCCEEDED', confirmedAt: ctx.mongo.clockNow });
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
    expect(await entitled(ctx)).toBe(true);
    expect(ctx.events()).toHaveLength(1);
    expect(ctx.audits(AuditAction.AUCTION_BID_ENTITLEMENT_GRANTED)).toHaveLength(1);
    // Terminal: later passes never touch it again.
    ctx.advance(10 * MINUTE);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 0 });
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
  });

  it('provider failure -> FAILED, slot freed, no entitlement, a retry opens a fresh attempt', async () => {
    const ctx = world({ scenario: 'failed' });
    await ctx.initiation.initiate(ALICE, AUCTION);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, failed: 1 });
    expect(ctx.payment()).toMatchObject({ status: 'FAILED', failureCode: 'FAKE_DECLINED' });
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
    ctx.fake.enqueue('success');
    const retry = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(retry.reused).toBe(false);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
  });

  it('provider pending -> nothing changes and the attempt backs off 15s, 30s, 1m, 2m, then 5m', async () => {
    const ctx = world({ env: { PAYMENT_ATTEMPT_TTL_SECONDS: '86400' } });
    await ctx.initiation.initiate(ALICE, AUCTION);
    const gaps: number[] = [];
    for (let pass = 0; pass < 7; pass++) {
      const before = ctx.mongo.clockNow.getTime();
      expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, pending: 1 });
      expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 0 }); // not due again yet
      const gap = ctx.payment().nextVerifyAt.getTime() - before;
      gaps.push(gap / SECOND);
      ctx.advance(gap - 1);
      expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 0 }); // one millisecond early: still not due
      ctx.advance(1);
    }
    expect(gaps).toEqual([15, 30, 60, 120, 300, 300, 300]);
    expect(ctx.payment()).toMatchObject({ status: 'INITIATED', verifyAttempts: 7, isLive: true });
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
  });

  it('provider error -> retried with backoff, counted, and NEVER expired (no final verification was possible)', async () => {
    const ctx = world({ env: { PAYMENT_ATTEMPT_TTL_SECONDS: '60' } });
    await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.advance(10 * MINUTE); // far past its lifetime
    ctx.fake.failNextVerifications(2);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, error: 1, expired: 0 });
    expect(ctx.payment()).toMatchObject({ status: 'INITIATED', isLive: true });
    expect(ctx.payment().nextVerifyAt.getTime() - ctx.mongo.clockNow.getTime()).toBe(15 * SECOND);
    expect(operationalMetrics.snapshot()['payment_reconciliation_error{AUCTION_ENTRY}']).toBe(1);
    ctx.advance(15 * SECOND);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ error: 1 });
    expect(ctx.payment().status).toBe('INITIATED');
    // The provider is back and still says PENDING: only now may the attempt expire.
    ctx.advance(30 * SECOND);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, expired: 1 });
    expect(ctx.payment().status).toBe('EXPIRED');
  });

  it('bounded batches, oldest due first', async () => {
    const ctx = world({ scenario: 'success' });
    for (const bidder of [ALICE, BOB]) { await ctx.initiation.initiate(bidder, AUCTION); ctx.advance(SECOND); }
    const third = '64b000000000000000000a14'; ctx.mongo.seedUser(third);
    await ctx.initiation.initiate(third, AUCTION);
    expect(await ctx.reconciliation.reconcileDue(2)).toMatchObject({ claimed: 2, succeeded: 2 });
    const byBidder = (id: string) => ctx.mongo.rows('payments').find((row) => String(row.bidderAccountId) === id).status;
    expect([byBidder(ALICE), byBidder(BOB), byBidder(third)]).toEqual(['SUCCEEDED', 'SUCCEEDED', 'INITIATED']);
    expect(await ctx.reconciliation.reconcileDue(2)).toMatchObject({ claimed: 1, succeeded: 1 });
  });

  it('an attempt written before MAZAD-028 (no nextVerifyAt) is due and is reconciled', async () => {
    const ctx = world();
    const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
    const row = ctx.payment();
    delete row.nextVerifyAt; delete row.verifyAttempts;
    ctx.fake.settle(attempt.providerReference!, 'success');
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, succeeded: 1 });
  });

  it('LEASE: a claimed attempt is invisible to every other pass until its lease lapses', async () => {
    const ctx = world();
    await ctx.initiation.initiate(ALICE, AUCTION);
    const claimed = await (ctx.reconciliation as any).claim(ctx.mongo.model('payments'));
    expect(claimed).toMatchObject({ verifyAttempts: 1 });
    expect(claimed.nextVerifyAt.getTime() - ctx.mongo.clockNow.getTime()).toBe(reconciliationLeaseMs(ctx.env));
    expect(await (ctx.reconciliation as any).claim(ctx.mongo.model('payments'))).toBeNull();
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 0 });
    expect(ctx.fake.calls.verify).toBe(0);
  });

  it('CRASH RECOVERY: a worker that died holding a claim loses nothing — the lease lapses and the next pass finishes the job once', async () => {
    const ctx = world();
    const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.fake.settle(attempt.providerReference!, 'success');
    await (ctx.reconciliation as any).claim(ctx.mongo.model('payments')); // claimed, then the process died
    expect(ctx.payment().status).toBe('INITIATED');
    ctx.advance(reconciliationLeaseMs(ctx.env) - 1);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 0 });
    ctx.advance(1);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
    expect(ctx.events()).toHaveLength(1);
  });

  it('CRASH AFTER PROVIDER SUCCESS: the confirmation transaction aborts whole, and the retry applies it exactly once', async () => {
    const ctx = world({ scenario: 'success' });
    await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.mongo.auditSvc.logSystemRequired.mockRejectedValueOnce(new Error('process died mid-transaction'));
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, error: 1 });
    expect(ctx.payment().status).toBe('INITIATED'); // provider said success, but nothing half-committed
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
    expect(ctx.events()).toHaveLength(0);
    ctx.advance(15 * SECOND);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(ctx.payment().status).toBe('SUCCEEDED');
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
    expect(ctx.events()).toHaveLength(1);
  });

  it('TWO WORKER INSTANCES on the same tick verify each attempt once and grant one entitlement', async () => {
    const ctx = world({ scenario: 'success' });
    await ctx.initiation.initiate(ALICE, AUCTION);
    await ctx.initiation.initiate(BOB, AUCTION);
    const second = new PaymentReconciliationService(ctx.router, ctx.clock as any, ctx.config);
    const [a, b] = await Promise.all([ctx.reconciliation.reconcileDue(10), second.reconcileDue(10)]);
    expect(a.claimed + b.claimed).toBe(2);
    expect(a.succeeded + b.succeeded).toBe(2);
    expect(ctx.fake.calls.verify).toBe(2);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(2);
    expect(ctx.events()).toHaveLength(2);
  });

  it('WORKER vs TRIGGER: a callback-style confirmation racing the worker still yields one entitlement and one event', async () => {
    for (let round = 0; round < 5; round++) {
      const ctx = world({ scenario: 'success' });
      const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
      await Promise.allSettled([
        ctx.reconciliation.reconcileDue(10),
        ctx.router.confirmByProviderReference('fake', attempt.providerReference!),
        ctx.confirmation.confirm(attempt.paymentId),
      ]);
      expect(ctx.payment().status).toBe('SUCCEEDED');
      expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
      expect(ctx.events()).toHaveLength(1);
      expect(ctx.audits(AuditAction.AUCTION_ENTRY_PAYMENT_CONFIRMED)).toHaveLength(1);
    }
  });

  it('amount / currency mismatch -> flagged, nothing granted, and the flagged attempt leaves the scan', async () => {
    for (const [tamper, flag] of [[{ amountMinor: FEE - 1 }, 'AMOUNT_MISMATCH'], [{ currency: 'USD' }, 'CURRENCY_MISMATCH']] as const) {
      const ctx = world({ scenario: 'success' });
      await ctx.initiation.initiate(ALICE, AUCTION);
      const verify = ctx.fake.verify.bind(ctx.fake);
      ctx.fake.verify = async (reference: string) => ({ ...(await verify(reference)), ...tamper });
      expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, flagged: 1, succeeded: 0 });
      expect(ctx.payment()).toMatchObject({ status: 'INITIATED', reconciliationFlag: flag });
      expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
      ctx.advance(10 * MINUTE);
      expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 0 }); // parked for the operator, never expired or retried
      expect(ctx.payment().status).toBe('INITIATED');
    }
  });

  it('MANAGED_MARKETING is reconciled by the same pass with its own fulfilment (request PAID), isolated from auction entry', async () => {
    const ctx = world({ scenario: 'success' });
    await ctx.mmInitiation.initiate(OWNER, REQUEST);
    await ctx.initiation.initiate(ALICE, AUCTION);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 2, succeeded: 2 });
    expect(ctx.request()).toMatchObject({ status: ManagedMarketingRequestStatus.PAID, paymentStatus: ManagedMarketingPaymentStatus.SUCCEEDED });
    expect(String(ctx.request().paidPaymentId)).toBe(String(ctx.mmPayment()._id));
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
    expect(String(ctx.mongo.rows('entitlements')[0].bidderAccountId)).toBe(ALICE);
    expect(ctx.mongo.outbox.events('MANAGED_MARKETING_PAYMENT_CONFIRMED')).toHaveLength(1);
  });

  it('MANAGED_MARKETING provider failure leaves the request payable; a retry then succeeds', async () => {
    const ctx = world({ scenario: 'failed' });
    await ctx.mmInitiation.initiate(OWNER, REQUEST);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ failed: 1 });
    expect(ctx.request()).toMatchObject({ status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: ManagedMarketingPaymentStatus.FAILED });
    ctx.fake.enqueue('success');
    await ctx.mmInitiation.initiate(OWNER, REQUEST);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ succeeded: 1 });
    expect(ctx.request().status).toBe(ManagedMarketingRequestStatus.PAID);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('expiration through the worker', () => {
  it('performs ONE FINAL provider verification, and only a still-PENDING answer expires the attempt', async () => {
    const ctx = world({ env: { PAYMENT_ATTEMPT_TTL_SECONDS: '600' } });
    await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.advance(600 * SECOND - 1);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, pending: 1, expired: 0 }); // one millisecond young
    // The next verification is pulled forward to the expiry instant instead of waiting a whole backoff step.
    expect(ctx.payment().nextVerifyAt.getTime()).toBe(ctx.payment().initiatedAt.getTime() + 600 * SECOND);
    ctx.advance(1);
    const verifiesBefore = ctx.fake.calls.verify;
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, expired: 1 });
    expect(ctx.fake.calls.verify).toBe(verifiesBefore + 1);
    expect(ctx.payment()).toMatchObject({ status: 'EXPIRED', expiredAt: ctx.mongo.clockNow });
    expect(ctx.payment().isLive).toBeUndefined();
    expect(operationalMetrics.snapshot()['payment_expired{AUCTION_ENTRY}']).toBe(1);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
  });

  it('a payment that turns out PAID at the final verification is confirmed normally, not expired', async () => {
    const ctx = world({ env: { PAYMENT_ATTEMPT_TTL_SECONDS: '600' } });
    const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.advance(20 * MINUTE);
    ctx.fake.settle(attempt.providerReference!, 'success');
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, succeeded: 1, expired: 0 });
    expect(ctx.payment().status).toBe('SUCCEEDED');
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
  });

  it('a payment the provider FAILED at the final verification takes the normal failure path', async () => {
    const ctx = world({ env: { PAYMENT_ATTEMPT_TTL_SECONDS: '600' } });
    const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.advance(20 * MINUTE);
    ctx.fake.settle(attempt.providerReference!, 'failed');
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ failed: 1, expired: 0 });
    expect(ctx.payment()).toMatchObject({ status: 'FAILED', failureCode: 'FAKE_DECLINED' });
  });

  it('retry after expiry: the bidder opens a new attempt, pays, and is entitled exactly once', async () => {
    const ctx = world({ env: { PAYMENT_ATTEMPT_TTL_SECONDS: '600' } });
    const first = await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.advance(600 * SECOND);
    await ctx.reconciliation.reconcileDue(10);
    expect(ctx.payment(first.paymentId).status).toBe('EXPIRED');
    const second = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(second).toMatchObject({ reused: false });
    ctx.fake.settle(second.providerReference!, 'success');
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(ctx.mongo.rows('payments').map((row) => row.status).sort()).toEqual(['EXPIRED', 'SUCCEEDED']);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(1);
    expect(String(ctx.mongo.rows('entitlements')[0].paymentId)).toBe(second.paymentId);
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.ALREADY_PAID);
  });

  it('with NO configured lifetime in a protected deployment nothing ever expires', async () => {
    const ctx = world({ env: { NODE_ENV: 'production', DEPLOYMENT_ENV: 'production', PAYMENT_ATTEMPT_TTL_SECONDS: undefined } });
    await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.advance(400 * 24 * 60 * MINUTE);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, pending: 1, expired: 0 });
    expect(ctx.payment().status).toBe('INITIATED');
  });

  it('MANAGED_MARKETING expires through the same pass and the request becomes payable again', async () => {
    const ctx = world({ env: { PAYMENT_ATTEMPT_TTL_SECONDS: '600' } });
    await ctx.mmInitiation.initiate(OWNER, REQUEST);
    ctx.advance(600 * SECOND);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, expired: 1 });
    expect(ctx.mmPayment().status).toBe('EXPIRED');
    expect(ctx.request().paymentStatus).toBe(ManagedMarketingPaymentStatus.FAILED);
    expect((await ctx.mmInitiation.initiate(OWNER, REQUEST)).reused).toBe(false);
  });

  it('a reference-less attempt is left alone while young and FAILED (never expired) once abandoned', async () => {
    const ctx = world();
    const row = { _id: new Types.ObjectId(), auctionId: oid(AUCTION), bidderAccountId: oid(ALICE), amountMinor: FEE, currency: 'EGP', status: 'INITIATED', isLive: true, initiatedAt: ctx.mongo.clockNow, provider: 'fake', initiationClaimedAt: ctx.mongo.clockNow, nextVerifyAt: new Date(ctx.mongo.clockNow.getTime() + INITIATION_CLAIM_LEASE_MS) };
    ctx.mongo.data.payments.set(String(row._id), { doc: row, version: 1 });
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 0 }); // the opening request still holds it
    ctx.advance(INITIATION_CLAIM_LEASE_MS);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, waiting: 1 });
    expect(ctx.payment().status).toBe('INITIATED');
    expect(ctx.payment().nextVerifyAt.getTime()).toBe(row.initiatedAt.getTime() + UNREFERENCED_ATTEMPT_GRACE_MS);
    ctx.advance(UNREFERENCED_ATTEMPT_GRACE_MS);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, abandoned: 1 });
    expect(ctx.payment()).toMatchObject({ status: 'FAILED', failureCode: 'PROVIDER_INITIATION_ABANDONED' });
    expect(ctx.payment().isLive).toBeUndefined();
    expect(ctx.fake.calls.verify).toBe(0);
    expect(ctx.audits(AuditAction.AUCTION_ENTRY_PAYMENT_FAILED)).toHaveLength(1);
    expect((await ctx.initiation.initiate(ALICE, AUCTION)).reused).toBe(false);
  });

  it('failAbandoned never fails an attempt that gained its reference meanwhile', async () => {
    const ctx = world();
    const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(await ctx.confirmation.failAbandoned(attempt.paymentId)).toBe(false);
    expect(ctx.payment().status).toBe('INITIATED');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('auction lifecycle safety', () => {
  it('SCHEDULED + confirmed payment: the entitlement exists (bidding itself still waits for ACTIVE — MAZAD-027)', async () => {
    const ctx = world({ scenario: 'success', auction: { status: AuctionStatus.SCHEDULED } });
    await ctx.initiation.initiate(ALICE, AUCTION);
    await ctx.reconciliation.reconcileDue(10);
    expect(await entitled(ctx)).toBe(true);
    expect(ctx.payment().lateConfirmation).toBeUndefined();
    expect(ctx.events()[0].payload).toMatchObject({ lateConfirmation: false });
  });

  it.each([AuctionStatus.CANCELLED, AuctionStatus.ENDED_PENDING_CLOSE, AuctionStatus.ENDED_NO_BIDS, AuctionStatus.COMPLETED])(
    'auction %s while the payment is pending: the worker still records the provider truth, marked late, and never touches the auction',
    async (status) => {
      const ctx = world();
      const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
      ctx.mongo.auction().status = status;
      const before = JSON.stringify(ctx.mongo.auction());
      const writes = ctx.mongo.auctionWrites;
      ctx.fake.settle(attempt.providerReference!, 'success');
      expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, succeeded: 1 });
      expect(ctx.payment()).toMatchObject({ status: 'SUCCEEDED', lateConfirmation: true });
      expect(ctx.audits(AuditAction.AUCTION_ENTRY_PAYMENT_CONFIRMED)[0].metadata).toMatchObject({ lateConfirmation: true, auctionStatus: status });
      expect(ctx.events()[0].payload).toMatchObject({ lateConfirmation: true });
      expect(JSON.stringify(ctx.mongo.auction())).toBe(before);
      expect(ctx.mongo.auctionWrites).toBe(writes);
      // No new payable flow on an auction that is over.
      expect(await codeOf(() => ctx.initiation.initiate(BOB, AUCTION))).toBe(PaymentErrorCode.AUCTION_NOT_PAYABLE);
    },
  );

  it('an ACTIVE auction already past its end time counts as late too', async () => {
    const ctx = world();
    const attempt = await ctx.initiation.initiate(ALICE, AUCTION);
    Object.assign(ctx.mongo.auction(), { status: AuctionStatus.ACTIVE, currentEndAt: new Date(ctx.mongo.clockNow.getTime() - 1) });
    ctx.fake.settle(attempt.providerReference!, 'success');
    await ctx.reconciliation.reconcileDue(10);
    expect(ctx.payment().lateConfirmation).toBe(true);
  });

  it('a pending payment on a cancelled auction that the provider never completes simply expires', async () => {
    const ctx = world({ env: { PAYMENT_ATTEMPT_TTL_SECONDS: '600' } });
    await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.mongo.auction().status = AuctionStatus.CANCELLED;
    ctx.advance(600 * SECOND);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ expired: 1 });
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
  });

  it('an existing entitlement has no second payable flow, whatever the worker does afterwards', async () => {
    const ctx = world({ scenario: 'success' });
    await ctx.initiation.initiate(ALICE, AUCTION);
    await ctx.reconciliation.reconcileDue(10);
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.ALREADY_PAID);
    expect(ctx.mongo.rows('payments')).toHaveLength(1);
    expect(ctx.fake.calls.initiate).toBe(1);
  });

  it('a FREE auction (explicit 0 fee) never creates a payment and its bidders stay entitled by the fee rule', async () => {
    const ctx = world({ auction: { entryFee: { amountMinor: 0, currency: 'EGP' } } });
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.NOT_REQUIRED);
    expect(ctx.mongo.rows('payments')).toHaveLength(0);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 0 });
    expect(await entitled(ctx)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('PaymentReconciliationWorker', () => {
  const worker = (env: Record<string, unknown>, provider: any, reconcile = jest.fn(async () => ({ claimed: 0 }) as any)) =>
    ({ worker: new PaymentReconciliationWorker({ reconcileDue: reconcile } as any, configOf(env), provider), reconcile });
  const fake = new FakePaymentProvider('pending');

  it('is disabled under NODE_ENV=test unless explicitly enabled, and enabled otherwise', () => {
    expect(worker({ NODE_ENV: 'test' }, fake).worker.enabled).toBe(false);
    expect(worker({ NODE_ENV: 'test', PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true' }, fake).worker.enabled).toBe(true);
    expect(worker({ NODE_ENV: 'development' }, fake).worker.enabled).toBe(true);
    expect(worker({ NODE_ENV: 'development', PAYMENT_RECONCILIATION_WORKER_ENABLED: 'false' }, fake).worker.enabled).toBe(false);
  });

  it('does not start a timer when disabled', () => {
    const { worker: disabled } = worker({ NODE_ENV: 'test' }, fake);
    disabled.onApplicationBootstrap();
    expect((disabled as any).timer).toBeUndefined();
  });

  it('with no payment provider bound (production today) a pass touches nothing', async () => {
    const { worker: idle, reconcile } = worker({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' }, new UnconfiguredPaymentProvider());
    expect(await idle.runOnce()).toBeNull();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('refuses to run in a protected deployment that has a provider but no explicit attempt lifetime', async () => {
    const provider = { providerKey: 'real-someday', configured: true };
    const { worker: refused, reconcile } = worker({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' }, provider);
    expect(refused.expiryConfigured).toBe(false);
    expect(await refused.runOnce()).toBeNull();
    expect(reconcile).not.toHaveBeenCalled();
    const { worker: configured, reconcile: runs } = worker({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production', PAYMENT_ATTEMPT_TTL_SECONDS: '1800' }, provider);
    expect(configured.expiryConfigured).toBe(true);
    await configured.runOnce();
    expect(runs).toHaveBeenCalledTimes(1);
  });

  it('never runs two local passes at once, honours the batch bounds and survives a failing pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reconcile = jest.fn(async () => { await gate; return { claimed: 1 } as any; });
    const { worker: busy } = worker({ NODE_ENV: 'development', PAYMENT_RECONCILIATION_BATCH_SIZE: '100000' }, fake, reconcile);
    const first = busy.runOnce();
    expect(await busy.runOnce()).toBeNull();
    release();
    expect(await first).toEqual({ claimed: 1 });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(200); // clamped to the maximum batch
    const failing = worker({ NODE_ENV: 'development' }, fake, jest.fn(async () => { throw new Error('database down'); }));
    expect(await failing.worker.runOnce()).toBeNull();
    expect(await failing.worker.runOnce()).toBeNull(); // still usable
  });

  it('interval: default 15s, configurable, never below one second', () => {
    expect(worker({ NODE_ENV: 'development' }, fake).worker.intervalMs).toBe(15_000);
    expect(worker({ NODE_ENV: 'development', PAYMENT_RECONCILIATION_INTERVAL_SECONDS: '1' }, fake).worker.intervalMs).toBe(1_000);
    expect(worker({ NODE_ENV: 'development', PAYMENT_RECONCILIATION_INTERVAL_SECONDS: 'x' }, fake).worker.intervalMs).toBe(15_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('expiry / reconciliation configuration: no guessed production duration', () => {
  it('local and development fall back to the documented development lifetime; protected deployments have NO default', () => {
    expect(paymentAttemptTtlMs({ NODE_ENV: 'development' })).toBe(DEV_PAYMENT_ATTEMPT_TTL_SECONDS * 1000);
    expect(paymentAttemptTtlMs({ NODE_ENV: 'test' })).toBe(DEV_PAYMENT_ATTEMPT_TTL_SECONDS * 1000);
    expect(paymentAttemptTtlMs({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' })).toBeNull();
    expect(paymentAttemptTtlMs({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'staging' })).toBeNull();
    expect(paymentAttemptTtlMs({ NODE_ENV: 'production' })).toBeNull(); // unresolvable environment is treated as protected
    expect(paymentAttemptTtlMs({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production', PAYMENT_ATTEMPT_TTL_SECONDS: '1800' })).toBe(1_800_000);
    expect(paymentAttemptTtlMs({ NODE_ENV: 'development', PAYMENT_ATTEMPT_TTL_SECONDS: '3' })).toBe(3_000);
  });

  it('a protected deployment that enables the worker must state the lifetime explicitly', () => {
    const production = { NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' };
    expect(paymentReconciliationErrors(production)).toEqual([]);
    expect(paymentReconciliationErrors({ ...production, PAYMENT_RECONCILIATION_WORKER_ENABLED: 'false' })).toEqual([]);
    expect(paymentReconciliationErrors({ ...production, PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true' }).join(' ')).toContain('PAYMENT_ATTEMPT_TTL_SECONDS is required in staging and production');
    expect(paymentReconciliationErrors({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'staging', PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true' })).toHaveLength(1);
    expect(paymentReconciliationErrors({ ...production, PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true', PAYMENT_ATTEMPT_TTL_SECONDS: '1800' })).toEqual([]);
    expect(paymentReconciliationErrors({ NODE_ENV: 'development', PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true' })).toEqual([]);
  });

  it('rejects malformed values', () => {
    const errors = paymentReconciliationErrors({
      NODE_ENV: 'development', PAYMENT_RECONCILIATION_WORKER_ENABLED: 'yes', PAYMENT_RECONCILIATION_INTERVAL_SECONDS: '0', PAYMENT_RECONCILIATION_BATCH_SIZE: '201',
      PAYMENT_RECONCILIATION_LEASE_SECONDS: '1', PAYMENT_ATTEMPT_TTL_SECONDS: '-5', PAYMENT_RECONCILIATION_BACKOFF_SECONDS: '15,abc',
    });
    for (const key of ['WORKER_ENABLED', 'INTERVAL_SECONDS', 'BATCH_SIZE', 'LEASE_SECONDS', 'PAYMENT_ATTEMPT_TTL_SECONDS', 'BACKOFF_SECONDS']) expect(errors.join('\n')).toContain(key);
    expect(reconciliationBackoffMs({ PAYMENT_RECONCILIATION_BACKOFF_SECONDS: '15,abc' })).toEqual([15_000, 30_000, 60_000, 120_000, 300_000]);
    expect(reconciliationBackoffMs({ PAYMENT_RECONCILIATION_BACKOFF_SECONDS: '1, 2' })).toEqual([1_000, 2_000]);
    expect(reconciliationLeaseMs({})).toBe(60_000);
  });

  it('is wired into startup validation: a full production configuration fails without the lifetime and passes with it', () => {
    const production = {
      NODE_ENV: 'production', DEPLOYMENT_ENV: 'production', DB_ENV_ALLOWLIST: 'cluster.example.net/mazad', MONGO_URI: 'mongodb+srv://u:p@cluster.example.net/mazad',
      JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), JWT_ACCESS_EXPIRES_IN: '15m', JWT_REFRESH_EXPIRES_IN: '7d', TRUST_PROXY: 'loopback',
      REALTIME_ENABLED: 'false', MAIL_HOST: 'smtp.example.net', MAIL_PORT: '587', MAIL_SECURE: 'false', MAIL_USER: 'u', MAIL_PASS: 'p', MAIL_FROM: 'no-reply@example.net',
      MAIL_TLS_REJECT_UNAUTHORIZED: 'true', CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', CORS_ORIGINS: 'https://admin.example.net',
      GEOCODING_PROVIDER: 'disabled',
    };
    expect(() => validateEnvironment(production)).not.toThrow();
    expect(() => validateEnvironment({ ...production, PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true' })).toThrow(/PAYMENT_ATTEMPT_TTL_SECONDS is required/);
    expect(() => validateEnvironment({ ...production, PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true', PAYMENT_ATTEMPT_TTL_SECONDS: '1800' })).not.toThrow();
    expect(() => validateEnvironment({ ...production, PAYMENT_PROVIDER: 'fake' })).toThrow(/forbidden in staging and production/);
  });
});
