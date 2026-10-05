'use strict';

const { Types } = require('mongoose');
const { AuditAction } = require('../src/models/audit-log.model');
const { SystemRole } = require('../src/domain/auth/roles.enum');
const { PaymentErrorCode } = require('../src/common/errors/payment-error-codes');
const { operationalMetrics } = require('../src/common/observability/operational-metrics');
const { validateEnvironment } = require('../src/config/environment.validation');
const {
  ManagedMarketingPaymentStatus,
  ManagedMarketingRequestStatus,
} = require('../src/domain/managed-marketing/managed-marketing.types');
const { UnconfiguredPaymentProvider } = require('../src/domain/payments/payment-provider.port');
const { FakePaymentProvider } = require('../src/domain/payments/fake-payment-provider');
const {
  ManagedMarketingPaymentConfirmationService,
} = require('../src/services/managed-marketing-payment-confirmation.service');
const {
  ManagedMarketingPaymentService,
} = require('../src/services/managed-marketing-payment.service');
const { INITIATION_CLAIM_LEASE_MS } = require('../src/domain/payments/payment-attempt-opening');
const {
  PaymentConfirmationRouter,
} = require('../src/services/payment-confirmation-router.service');
const {
  DEV_PAYMENT_ATTEMPT_TTL_SECONDS,
  paymentAttemptTtlMs,
  paymentReconciliationErrors,
  reconciliationBackoffMs,
  reconciliationLeaseMs,
} = require('../src/domain/payments/payment-reconciliation.config');
const { PaymentReconciliationService } = require('../src/services/payment-reconciliation.service');
const { PaymentReconciliationWorker } = require('../src/services/payment-reconciliation.worker');
const { EntryPaymentStatus, PaymentPurpose } = require('../src/domain/payments/payment.types');
const { FakeMongo } = require('./support/fake-payments-mongo');
/**
 * MAZAD-028 remainder — the payment LIFECYCLE: one provider order per attempt,
 * the EXPIRED state, confirmation routing by provider reference, the shared
 * reconciliation worker (claim/lease, backoff, crash recovery, expiry with a
 * final verification) and late success. In-memory Mongo MODEL (see
 * support/fake-payments-mongo.ts) driven by the real FakePaymentProvider; the
 * real-Mongo qualification is `mazad028-payment-e2e.spec.js`.
 */
const oid = (hex) => new Types.ObjectId(hex);
const ADVERTISER = '64b000000000000000000a10';
const ALICE = '64b000000000000000000a11';
const BOB = '64b000000000000000000a12';
const OWNER = '64b000000000000000000a13';
const ADMIN = '64b000000000000000000a20';
const REQUEST = '64b000000000000000000c01';
const PRICE = 1_500_000; // test data only — a made-up fixture, not a product price
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const codeOf = async (action) => {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error.getResponse?.()?.code ?? error.message;
  }
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const configOf = (values) => ({ get: (key) => values[key] });
function world(opts = {}) {
  const mongo = new FakeMongo();
  for (const id of [ADVERTISER, ALICE, BOB, OWNER]) mongo.seedUser(id);
  mongo.seedUser(ADMIN, { systemRole: SystemRole.ADMIN });
  mongo.data.requests.set(REQUEST, {
    version: 1,
    doc: {
      _id: oid(REQUEST),
      propertyId: oid('64b000000000000000000b01'),
      propertyRevisionId: oid('64b000000000000000000b02'),
      advertiserAccountId: oid(OWNER),
      status: ManagedMarketingRequestStatus.APPROVED,
      paymentStatus: ManagedMarketingPaymentStatus.AWAITING_PAYMENT,
      packageSnapshot: {
        packageId: oid('64b000000000000000000d01'),
        code: 'any-tier',
        priceMinor: PRICE,
        currency: 'EGP',
      },
    },
  });
  const fake = new FakePaymentProvider(opts.scenario ?? 'pending');
  const provider = opts.provider ?? fake;
  const clock = { now: () => mongo.clockNow };
  const deps = {
    users: mongo.model('users'),
    requests: mongo.model('requests'),
    audit: mongo.auditSvc,
    clock,
    provider,
    connection: mongo.connection,
    outbox: mongo.outbox.service,
  };
  const mmDeps = { ...deps, payments: mongo.model('mmPayments') };
  const mmInitiation = Object.assign(
    Object.create(ManagedMarketingPaymentService.prototype),
    mmDeps,
  );
  const mmConfirmation = Object.assign(
    Object.create(ManagedMarketingPaymentConfirmationService.prototype),
    mmDeps,
  );
  const router = Object.assign(Object.create(PaymentConfirmationRouter.prototype), {
    marketingPayments: mongo.model('mmPayments'),
    managedMarketing: mmConfirmation,
  });
  const env = {
    NODE_ENV: 'development',
    DEPLOYMENT_ENV: 'local',
    PAYMENT_ATTEMPT_TTL_SECONDS: '600',
    ...opts.env,
  };
  const config = configOf(env);
  const reconciliation = new PaymentReconciliationService(router, clock, config);
  const advance = (ms) => {
    mongo.clockNow = new Date(mongo.clockNow.getTime() + ms);
  };
  const payment = (id) =>
    id
      ? mongo.rows('mmPayments').find((row) => String(row._id) === id)
      : mongo.rows('mmPayments')[0];
  const mmPayment = (id) =>
    id
      ? mongo.rows('mmPayments').find((row) => String(row._id) === id)
      : mongo.rows('mmPayments')[0];
  const request = () => mongo.data.requests.get(REQUEST).doc;
  const audits = (action) => mongo.audits.filter((row) => row.action === action);
  const events = () => mongo.outbox.events('MANAGED_MARKETING_PAYMENT_CONFIRMED');
  return {
    mongo,
    fake,
    provider,
    initiation: mmInitiation,
    confirmation: mmConfirmation,
    mmInitiation,
    mmConfirmation,
    router,
    reconciliation,
    config,
    env,
    clock,
    advance,
    payment,
    mmPayment,
    request,
    audits,
    events,
  };
}
beforeEach(() => operationalMetrics.reset());
// ---------------------------------------------------------------------------------------------------------------------
describe('initiation race: one live payment, ONE provider order, only a persisted reference is returned', () => {
  it('MANAGED_MARKETING: simultaneous initiations open exactly one provider order', async () => {
    const calls = [];
    let n = 0;
    const provider = {
      providerKey: 'slow',
      configured: true,
      initiate: async (request) => {
        calls.push(request);
        const reference = `mm-order-${++n}`;
        await pause(40);
        return { providerReference: reference, clientHandoff: 'opaque' };
      },
      verify: async (reference) => ({
        status: 'PENDING',
        providerReference: reference,
        amountMinor: PRICE,
        currency: 'EGP',
      }),
    };
    const ctx = world({ provider });
    const settled = await Promise.allSettled(
      [1, 2, 3, 4].map(() => ctx.mmInitiation.initiate(OWNER, REQUEST)),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      purpose: PaymentPurpose.MANAGED_MARKETING,
      amountMinor: PRICE,
    });
    expect(ctx.mongo.rows('mmPayments')).toHaveLength(1);
    expect(ctx.mmPayment().providerReference).toBe('mm-order-1');
    for (const item of settled) {
      if (item.status === 'fulfilled') expect(item.value.providerReference).toBe('mm-order-1');
      else expect(item.reason.getResponse().code).toBe(PaymentErrorCode.INITIATION_IN_PROGRESS);
    }
  });
  it('a request whose compare-and-set lost never returns its own (unpersisted) reference: it returns the stored one', async () => {
    const ctx = world();
    // While this request is at the provider, another writer persists a different reference on the same attempt.
    const provider = {
      providerKey: 'fake',
      configured: true,
      initiate: async () => {
        const row = ctx.payment();
        row.providerReference = 'stored-by-the-winner';
        row.clientHandoff = 'winner-handoff';
        return { providerReference: 'mine-and-unpersisted', clientHandoff: 'mine' };
      },
      verify: async (reference) => ({
        status: 'PENDING',
        providerReference: reference,
        amountMinor: PRICE,
        currency: 'EGP',
      }),
    };
    ctx.initiation.provider = provider;
    const answer = await ctx.initiation.initiate(OWNER, REQUEST);
    expect(answer).toMatchObject({
      providerReference: 'stored-by-the-winner',
      clientHandoff: 'winner-handoff',
      reused: true,
    });
    expect(JSON.stringify(answer)).not.toContain('mine');
    expect(ctx.payment().providerReference).toBe('stored-by-the-winner');
  });
  it('a persisting compare-and-set that lost to a terminal attempt answers a retryable conflict, not a reference', async () => {
    const ctx = world();
    ctx.initiation.provider = {
      providerKey: 'fake',
      configured: true,
      initiate: async () => {
        const row = ctx.payment();
        row.status = EntryPaymentStatus.FAILED;
        delete row.isLive;
        return { providerReference: 'unpersisted' };
      },
      verify: async () => {
        throw new Error('unused');
      },
    };
    expect(await codeOf(() => ctx.initiation.initiate(OWNER, REQUEST))).toBe(
      PaymentErrorCode.INITIATION_IN_PROGRESS,
    );
    expect(ctx.payment().providerReference).toBeUndefined();
  });
  it('a reference-less live attempt whose claim is still FRESH is not opened a second time; a STALE claim is taken over', async () => {
    const ctx = world({ scenario: 'pending' });
    const seeded = {
      _id: new Types.ObjectId(),
      requestId: oid(REQUEST),
      advertiserAccountId: oid(OWNER),
      amountMinor: PRICE,
      currency: 'EGP',
      status: 'INITIATED',
      isLive: true,
      initiatedAt: ctx.mongo.clockNow,
      provider: 'fake',
      initiationClaimedAt: ctx.mongo.clockNow,
    };
    ctx.mongo.data.mmPayments.set(String(seeded._id), { doc: seeded, version: 1 });
    ctx.request().paymentStatus = ManagedMarketingPaymentStatus.PENDING;
    expect(await codeOf(() => ctx.initiation.initiate(OWNER, REQUEST))).toBe(
      PaymentErrorCode.INITIATION_IN_PROGRESS,
    );
    expect(ctx.fake.calls.initiate).toBe(0);
    // The opener died: once its lease lapsed, the next request takes the claim over and opens the attempt.
    ctx.advance(INITIATION_CLAIM_LEASE_MS);
    const answer = await ctx.initiation.initiate(OWNER, REQUEST);
    expect(ctx.fake.calls.initiate).toBe(1);
    expect(answer.providerReference).toBe(ctx.payment().providerReference);
    expect(ctx.payment().initiationClaimedAt).toBeUndefined();
  }, 15_000);
  it('the stored hand-off of the SAME live attempt is returned again (lost response / app restart), without a second provider call', async () => {
    const ctx = world();
    const first = await ctx.initiation.initiate(OWNER, REQUEST);
    const again = await ctx.initiation.initiate(OWNER, REQUEST);
    expect(first.clientHandoff).toMatch(/^fake:\/\/checkout\//);
    expect(again).toMatchObject({
      paymentId: first.paymentId,
      providerReference: first.providerReference,
      clientHandoff: first.clientHandoff,
      reused: true,
    });
    expect(ctx.fake.calls.initiate).toBe(1);
  });
  it('a provider refusal while opening fails only the reference-less attempt and frees the slot for a new one', async () => {
    const ctx = world({ scenario: 'pending' });
    ctx.fake.enqueue('error');
    expect(await codeOf(() => ctx.initiation.initiate(OWNER, REQUEST))).toBe(
      PaymentErrorCode.PROVIDER_UNAVAILABLE,
    );
    expect(ctx.payment()).toMatchObject({
      status: 'FAILED',
      failureCode: 'PROVIDER_INITIATION_FAILED',
    });
    const retry = await ctx.initiation.initiate(OWNER, REQUEST);
    expect(retry.reused).toBe(false);
    expect(ctx.mongo.rows('mmPayments')).toHaveLength(2);
  });
});
// ---------------------------------------------------------------------------------------------------------------------
describe('EXPIRED: a real terminal state', () => {
  it('MANAGED_MARKETING expiry returns the request to its payable AND cancellable state, and a new attempt can be opened', async () => {
    const ctx = world();
    const attempt = await ctx.mmInitiation.initiate(OWNER, REQUEST);
    expect(ctx.request().paymentStatus).toBe(ManagedMarketingPaymentStatus.PENDING);
    expect(await ctx.mmConfirmation.expire(attempt.paymentId)).toBe(true);
    expect(ctx.mmPayment(attempt.paymentId)).toMatchObject({ status: 'EXPIRED' });
    expect(ctx.mmPayment(attempt.paymentId).isLive).toBeUndefined();
    expect(ctx.request()).toMatchObject({
      status: ManagedMarketingRequestStatus.APPROVED,
      paymentStatus: ManagedMarketingPaymentStatus.FAILED,
    });
    expect(ctx.audits(AuditAction.MANAGED_MARKETING_PAYMENT_EXPIRED)).toHaveLength(1);
    const retry = await ctx.mmInitiation.initiate(OWNER, REQUEST);
    expect(retry.reused).toBe(false);
    ctx.fake.settle(retry.providerReference, 'success');
    expect(await ctx.mmConfirmation.confirm(retry.paymentId)).toMatchObject({ requestPaid: true });
    expect(ctx.request()).toMatchObject({
      status: ManagedMarketingRequestStatus.PAID,
      paymentStatus: ManagedMarketingPaymentStatus.SUCCEEDED,
    });
  });
});
// ---------------------------------------------------------------------------------------------------------------------
describe('late success after local expiry: recorded, flagged, never applied', () => {
  async function expiredThenPaid(ctx = world()) {
    const attempt = await ctx.initiation.initiate(OWNER, REQUEST);
    await ctx.confirmation.expire(attempt.paymentId);
    ctx.fake.settle(attempt.providerReference, 'success');
    return { ctx, attempt };
  }
  it('the flagged payer cannot open another attempt (an operator must reconcile first) — never a second charge by default', async () => {
    const { ctx, attempt } = await expiredThenPaid();
    await codeOf(() => ctx.confirmation.confirm(attempt.paymentId));
    expect(await codeOf(() => ctx.initiation.initiate(OWNER, REQUEST))).toBe(
      PaymentErrorCode.RECONCILIATION_REQUIRED,
    );
  });
  it('MANAGED_MARKETING: success after expiry parks the request for the operator and never marks it PAID', async () => {
    const ctx = world();
    const attempt = await ctx.mmInitiation.initiate(OWNER, REQUEST);
    await ctx.mmConfirmation.expire(attempt.paymentId);
    ctx.fake.settle(attempt.providerReference, 'success');
    expect(await codeOf(() => ctx.mmConfirmation.confirm(attempt.paymentId))).toBe(
      PaymentErrorCode.CONFIRMED_AFTER_EXPIRY,
    );
    expect(ctx.mmPayment()).toMatchObject({
      status: 'EXPIRED',
      reconciliationFlag: 'CONFIRMED_AFTER_EXPIRY',
    });
    expect(ctx.request()).toMatchObject({
      status: ManagedMarketingRequestStatus.APPROVED,
      paymentStatus: ManagedMarketingPaymentStatus.RECONCILIATION_REQUIRED,
    });
    expect(ctx.request().paidAt).toBeUndefined();
    expect(ctx.mongo.outbox.events()).toHaveLength(0);
  });
});
// ---------------------------------------------------------------------------------------------------------------------
describe('confirmation routing by provider reference (a trigger carries no outcome)', () => {
  it('an unknown reference, a wrong provider key or malformed input is not found and changes nothing', async () => {
    const ctx = world();
    const entry = await ctx.initiation.initiate(OWNER, REQUEST);
    ctx.fake.settle(entry.providerReference, 'success');
    expect(
      await codeOf(() =>
        ctx.router.confirmByProviderReference('fake', 'fake~pending~1~EGP~nobody~00000000'),
      ),
    ).toBe(PaymentErrorCode.NOT_FOUND);
    expect(
      await codeOf(() =>
        ctx.router.confirmByProviderReference('another-provider', entry.providerReference),
      ),
    ).toBe(PaymentErrorCode.NOT_FOUND);
    expect(await codeOf(() => ctx.router.confirmByProviderReference('', ''))).toBe(
      PaymentErrorCode.NOT_FOUND,
    );
    expect(
      await codeOf(() => ctx.router.confirmByProviderReference({ $ne: null }, { $ne: null })),
    ).toBe(PaymentErrorCode.NOT_FOUND);
    expect(ctx.payment().status).toBe('INITIATED');
    expect(ctx.fake.calls.verify).toBe(0);
  });
  it('has no parameter through which a caller could state an outcome, an amount or a status', () => {
    expect(PaymentConfirmationRouter.prototype.confirmByProviderReference.length).toBe(2);
    expect(ManagedMarketingPaymentConfirmationService.prototype.confirm.length).toBe(1);
    expect(ManagedMarketingPaymentConfirmationService.prototype.confirm.length).toBe(1);
    expect(ManagedMarketingPaymentConfirmationService.prototype.expire.length).toBe(1);
  });
});
// ---------------------------------------------------------------------------------------------------------------------
describe('reconciliation worker pass', () => {
  it('bounded batches, oldest due first', async () => {
    const ctx = world({ scenario: 'success' });
    const requestIds = [REQUEST, '64b000000000000000000c02', '64b000000000000000000c03'];
    for (const id of requestIds) {
      if (id !== REQUEST)
        ctx.mongo.data.requests.set(id, {
          doc: {
            ...ctx.request(),
            _id: oid(id),
            paymentStatus: ManagedMarketingPaymentStatus.AWAITING_PAYMENT,
          },
          version: 1,
        });
      await ctx.initiation.initiate(OWNER, id);
      ctx.advance(SECOND);
    }
    expect(await ctx.reconciliation.reconcileDue(2)).toMatchObject({ claimed: 2, succeeded: 2 });
    const byRequest = (id) =>
      ctx.mongo.rows('mmPayments').find((row) => String(row.requestId) === id).status;
    expect(requestIds.map(byRequest)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'INITIATED']);
    expect(await ctx.reconciliation.reconcileDue(2)).toMatchObject({ claimed: 1, succeeded: 1 });
  });
  it('an attempt written before MAZAD-028 (no nextVerifyAt) is due and is reconciled', async () => {
    const ctx = world();
    const attempt = await ctx.initiation.initiate(OWNER, REQUEST);
    const row = ctx.payment();
    delete row.nextVerifyAt;
    delete row.verifyAttempts;
    ctx.fake.settle(attempt.providerReference, 'success');
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 1, succeeded: 1 });
  });
  it('LEASE: a claimed attempt is invisible to every other pass until its lease lapses', async () => {
    const ctx = world();
    await ctx.initiation.initiate(OWNER, REQUEST);
    const claimed = await ctx.reconciliation.claim(ctx.mongo.model('mmPayments'));
    expect(claimed).toMatchObject({ verifyAttempts: 1 });
    expect(claimed.nextVerifyAt.getTime() - ctx.mongo.clockNow.getTime()).toBe(
      reconciliationLeaseMs(ctx.env),
    );
    expect(await ctx.reconciliation.claim(ctx.mongo.model('mmPayments'))).toBeNull();
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ claimed: 0 });
    expect(ctx.fake.calls.verify).toBe(0);
  });
  it('MANAGED_MARKETING provider failure leaves the request payable; a retry then succeeds', async () => {
    const ctx = world({ scenario: 'failed' });
    await ctx.mmInitiation.initiate(OWNER, REQUEST);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ failed: 1 });
    expect(ctx.request()).toMatchObject({
      status: ManagedMarketingRequestStatus.APPROVED,
      paymentStatus: ManagedMarketingPaymentStatus.FAILED,
    });
    ctx.fake.enqueue('success');
    await ctx.mmInitiation.initiate(OWNER, REQUEST);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ succeeded: 1 });
    expect(ctx.request().status).toBe(ManagedMarketingRequestStatus.PAID);
  });
});
// ---------------------------------------------------------------------------------------------------------------------
describe('expiration through the worker', () => {
  it('a payment the provider FAILED at the final verification takes the normal failure path', async () => {
    const ctx = world({ env: { PAYMENT_ATTEMPT_TTL_SECONDS: '600' } });
    const attempt = await ctx.initiation.initiate(OWNER, REQUEST);
    ctx.advance(20 * MINUTE);
    ctx.fake.settle(attempt.providerReference, 'failed');
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({ failed: 1, expired: 0 });
    expect(ctx.payment()).toMatchObject({ status: 'FAILED', failureCode: 'FAKE_DECLINED' });
  });
  it('with NO configured lifetime in a protected deployment nothing ever expires', async () => {
    const ctx = world({
      env: {
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'production',
        PAYMENT_ATTEMPT_TTL_SECONDS: undefined,
      },
    });
    await ctx.initiation.initiate(OWNER, REQUEST);
    ctx.advance(400 * 24 * 60 * MINUTE);
    expect(await ctx.reconciliation.reconcileDue(10)).toMatchObject({
      claimed: 1,
      pending: 1,
      expired: 0,
    });
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
  it('failAbandoned never fails an attempt that gained its reference meanwhile', async () => {
    const ctx = world();
    const attempt = await ctx.initiation.initiate(OWNER, REQUEST);
    expect(await ctx.confirmation.failAbandoned(attempt.paymentId)).toBe(false);
    expect(ctx.payment().status).toBe('INITIATED');
  });
});
// ---------------------------------------------------------------------------------------------------------------------
describe('PaymentReconciliationWorker', () => {
  const worker = (env, provider, reconcile = jest.fn(async () => ({ claimed: 0 }))) => ({
    worker: new PaymentReconciliationWorker({ reconcileDue: reconcile }, configOf(env), provider),
    reconcile,
  });
  const fake = new FakePaymentProvider('pending');
  it('is disabled under NODE_ENV=test unless explicitly enabled, and enabled otherwise', () => {
    expect(worker({ NODE_ENV: 'test' }, fake).worker.enabled).toBe(false);
    expect(
      worker({ NODE_ENV: 'test', PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true' }, fake).worker
        .enabled,
    ).toBe(true);
    expect(worker({ NODE_ENV: 'development' }, fake).worker.enabled).toBe(true);
    expect(
      worker({ NODE_ENV: 'development', PAYMENT_RECONCILIATION_WORKER_ENABLED: 'false' }, fake)
        .worker.enabled,
    ).toBe(false);
  });
  it('does not start a timer when disabled', () => {
    const { worker: disabled } = worker({ NODE_ENV: 'test' }, fake);
    disabled.onApplicationBootstrap();
    expect(disabled.timer).toBeUndefined();
  });
  it('with no payment provider bound (production today) a pass touches nothing', async () => {
    const { worker: idle, reconcile } = worker(
      { NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' },
      new UnconfiguredPaymentProvider(),
    );
    expect(await idle.runOnce()).toBeNull();
    expect(reconcile).not.toHaveBeenCalled();
  });
  it('refuses to run in a protected deployment that has a provider but no explicit attempt lifetime', async () => {
    const provider = { providerKey: 'real-someday', configured: true };
    const { worker: refused, reconcile } = worker(
      { NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' },
      provider,
    );
    expect(refused.expiryConfigured).toBe(false);
    expect(await refused.runOnce()).toBeNull();
    expect(reconcile).not.toHaveBeenCalled();
    const { worker: configured, reconcile: runs } = worker(
      { NODE_ENV: 'production', DEPLOYMENT_ENV: 'production', PAYMENT_ATTEMPT_TTL_SECONDS: '1800' },
      provider,
    );
    expect(configured.expiryConfigured).toBe(true);
    await configured.runOnce();
    expect(runs).toHaveBeenCalledTimes(1);
  });
  it('never runs two local passes at once, honours the batch bounds and survives a failing pass', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const reconcile = jest.fn(async () => {
      await gate;
      return { claimed: 1 };
    });
    const { worker: busy } = worker(
      { NODE_ENV: 'development', PAYMENT_RECONCILIATION_BATCH_SIZE: '100000' },
      fake,
      reconcile,
    );
    const first = busy.runOnce();
    expect(await busy.runOnce()).toBeNull();
    release();
    expect(await first).toEqual({ claimed: 1 });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(200); // clamped to the maximum batch
    const failing = worker(
      { NODE_ENV: 'development' },
      fake,
      jest.fn(async () => {
        throw new Error('database down');
      }),
    );
    expect(await failing.worker.runOnce()).toBeNull();
    expect(await failing.worker.runOnce()).toBeNull(); // still usable
  });
  it('interval: default 15s, configurable, never below one second', () => {
    expect(worker({ NODE_ENV: 'development' }, fake).worker.intervalMs).toBe(15_000);
    expect(
      worker({ NODE_ENV: 'development', PAYMENT_RECONCILIATION_INTERVAL_SECONDS: '1' }, fake).worker
        .intervalMs,
    ).toBe(1_000);
    expect(
      worker({ NODE_ENV: 'development', PAYMENT_RECONCILIATION_INTERVAL_SECONDS: 'x' }, fake).worker
        .intervalMs,
    ).toBe(15_000);
  });
});
// ---------------------------------------------------------------------------------------------------------------------
describe('expiry / reconciliation configuration: no guessed production duration', () => {
  it('local and development fall back to the documented development lifetime; protected deployments have NO default', () => {
    expect(paymentAttemptTtlMs({ NODE_ENV: 'development' })).toBe(
      DEV_PAYMENT_ATTEMPT_TTL_SECONDS * 1000,
    );
    expect(paymentAttemptTtlMs({ NODE_ENV: 'test' })).toBe(DEV_PAYMENT_ATTEMPT_TTL_SECONDS * 1000);
    expect(
      paymentAttemptTtlMs({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' }),
    ).toBeNull();
    expect(paymentAttemptTtlMs({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'staging' })).toBeNull();
    expect(paymentAttemptTtlMs({ NODE_ENV: 'production' })).toBeNull(); // unresolvable environment is treated as protected
    expect(
      paymentAttemptTtlMs({
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'production',
        PAYMENT_ATTEMPT_TTL_SECONDS: '1800',
      }),
    ).toBe(1_800_000);
    expect(paymentAttemptTtlMs({ NODE_ENV: 'development', PAYMENT_ATTEMPT_TTL_SECONDS: '3' })).toBe(
      3_000,
    );
  });
  it('a protected deployment that enables the worker must state the lifetime explicitly', () => {
    const production = { NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' };
    expect(paymentReconciliationErrors(production)).toEqual([]);
    expect(
      paymentReconciliationErrors({
        ...production,
        PAYMENT_RECONCILIATION_WORKER_ENABLED: 'false',
      }),
    ).toEqual([]);
    expect(
      paymentReconciliationErrors({
        ...production,
        PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true',
      }).join(' '),
    ).toContain('PAYMENT_ATTEMPT_TTL_SECONDS is required in staging and production');
    expect(
      paymentReconciliationErrors({
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: 'staging',
        PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true',
      }),
    ).toHaveLength(1);
    expect(
      paymentReconciliationErrors({
        ...production,
        PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true',
        PAYMENT_ATTEMPT_TTL_SECONDS: '1800',
      }),
    ).toEqual([]);
    expect(
      paymentReconciliationErrors({
        NODE_ENV: 'development',
        PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true',
      }),
    ).toEqual([]);
  });
  it('rejects malformed values', () => {
    const errors = paymentReconciliationErrors({
      NODE_ENV: 'development',
      PAYMENT_RECONCILIATION_WORKER_ENABLED: 'yes',
      PAYMENT_RECONCILIATION_INTERVAL_SECONDS: '0',
      PAYMENT_RECONCILIATION_BATCH_SIZE: '201',
      PAYMENT_RECONCILIATION_LEASE_SECONDS: '1',
      PAYMENT_ATTEMPT_TTL_SECONDS: '-5',
      PAYMENT_RECONCILIATION_BACKOFF_SECONDS: '15,abc',
    });
    for (const key of [
      'WORKER_ENABLED',
      'INTERVAL_SECONDS',
      'BATCH_SIZE',
      'LEASE_SECONDS',
      'PAYMENT_ATTEMPT_TTL_SECONDS',
      'BACKOFF_SECONDS',
    ])
      expect(errors.join('\n')).toContain(key);
    expect(reconciliationBackoffMs({ PAYMENT_RECONCILIATION_BACKOFF_SECONDS: '15,abc' })).toEqual([
      15_000, 30_000, 60_000, 120_000, 300_000,
    ]);
    expect(reconciliationBackoffMs({ PAYMENT_RECONCILIATION_BACKOFF_SECONDS: '1, 2' })).toEqual([
      1_000, 2_000,
    ]);
    expect(reconciliationLeaseMs({})).toBe(60_000);
  });
  it('is wired into startup validation: a full production configuration fails without the lifetime and passes with it', () => {
    const production = {
      NODE_ENV: 'production',
      DEPLOYMENT_ENV: 'production',
      DB_ENV_ALLOWLIST: 'cluster.example.net/mazad',
      MONGO_URI: 'mongodb+srv://u:p@cluster.example.net/mazad',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      JWT_ACCESS_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '7d',
      TRUST_PROXY: 'loopback',
      MAIL_HOST: 'smtp.example.net',
      MAIL_PORT: '587',
      MAIL_SECURE: 'false',
      MAIL_USER: 'u',
      MAIL_PASS: 'p',
      MAIL_FROM: 'no-reply@example.net',
      MAIL_TLS_REJECT_UNAUTHORIZED: 'true',
      CLOUDINARY_CLOUD_NAME: 'c',
      CLOUDINARY_API_KEY: 'k',
      CLOUDINARY_API_SECRET: 's',
      CORS_ORIGINS: 'https://admin.example.net',
      GEOCODING_PROVIDER: 'disabled',
    };
    expect(() => validateEnvironment(production)).not.toThrow();
    expect(() =>
      validateEnvironment({ ...production, PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true' }),
    ).toThrow(/PAYMENT_ATTEMPT_TTL_SECONDS is required/);
    expect(() =>
      validateEnvironment({
        ...production,
        PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true',
        PAYMENT_ATTEMPT_TTL_SECONDS: '1800',
      }),
    ).not.toThrow();
    expect(() => validateEnvironment({ ...production, PAYMENT_PROVIDER: 'fake' })).toThrow(
      /forbidden in staging and production/,
    );
  });
});
