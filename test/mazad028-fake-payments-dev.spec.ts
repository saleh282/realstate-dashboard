import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Types } from 'mongoose';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { configureApp } from '../src/app.setup';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { SystemRole } from '../src/auth/roles.enum';
import { ClockService } from '../src/common/time/clock.service';
import { ManagedMarketingController } from '../src/managed-marketing/managed-marketing.controller';
import { ManagedMarketingService } from '../src/managed-marketing/managed-marketing.service';
import { ManagedMarketingPaymentStatus, ManagedMarketingRequestStatus } from '../src/managed-marketing/managed-marketing.types';
import { PAYMENT_PROVIDER_PORT, PaymentProviderPort, UnconfiguredPaymentProvider } from '../src/payments/payment-provider.port';
import { FakePaymentsDevController } from '../src/payments/dev/fake-payments-dev.controller';
import { FakePaymentsDevGuard, fakePaymentsDevRoutesAllowed } from '../src/payments/dev/fake-payments-dev.guard';
import { FakePaymentsDevService } from '../src/payments/dev/fake-payments-dev.service';
import { FakePaymentProvider } from '../src/payments/fake-payment-provider';
import { ManagedMarketingPaymentConfirmationService } from '../src/payments/managed-marketing-payment-confirmation.service';
import { ManagedMarketingPaymentService } from '../src/payments/managed-marketing-payment.service';
import { PaymentConfirmationRouter } from '../src/payments/payment-confirmation-router.service';
import { buildPaymentProvider } from '../src/payments/payment-provider.factory';
import { FakeMongo } from './support/fake-payments-mongo';

/**
 * MAZAD-028 — the development-only fake settle route and the managed-marketing
 * payment initiation route, over real HTTP (guards, validation, envelopes).
 */
const oid = (hex: string) => new Types.ObjectId(hex);
const ADVERTISER = '64b000000000000000000a10';
const ALICE = '64b000000000000000000a11';
const BOB = '64b000000000000000000a12';
const OWNER = '64b000000000000000000a13';
const ADMIN = '64b000000000000000000a20';
const REQUEST = '64b000000000000000000c01';
const PRICE = 1_500_000; // test data only — a made-up fixture, not a product price

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp().getRequest();
    if (!http.headers.authorization) throw new UnauthorizedException();
    const userId = http.headers.authorization.replace('Bearer ', '');
    http.user = { userId, accountStatus: 'active', accountType: 'USER', brokerStatus: 'NOT_APPLIED', systemRole: userId === ADMIN ? SystemRole.ADMIN : SystemRole.USER };
    return true;
  }
}

async function harness(options: { provider?: PaymentProviderPort; env?: Record<string, unknown> } = {}) {
  const mongo = new FakeMongo();
  for (const id of [ADVERTISER, ALICE, BOB, OWNER]) mongo.seedUser(id);
  mongo.data.requests.set(REQUEST, {
    version: 1,
    doc: {
      _id: oid(REQUEST), propertyId: oid('64b000000000000000000b01'), propertyRevisionId: oid('64b000000000000000000b02'), advertiserAccountId: oid(OWNER),
      status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: ManagedMarketingPaymentStatus.AWAITING_PAYMENT,
      packageSnapshot: { packageId: oid('64b000000000000000000d01'), code: 'any-tier', priceMinor: PRICE, currency: 'EGP' },
    },
  });
  const provider = options.provider ?? new FakePaymentProvider('pending');
  const clock = { now: () => mongo.clockNow };
  const deps = {
    users: mongo.model('users'),
    requests: mongo.model('requests'), audit: mongo.auditSvc, clock, provider, connection: mongo.connection, outbox: mongo.outbox.service,
  };
  const mmDeps = { ...deps, payments: mongo.model('mmPayments') };
  const mmInitiation = Object.assign(Object.create(ManagedMarketingPaymentService.prototype), mmDeps) as ManagedMarketingPaymentService;
  const mmConfirmation = Object.assign(Object.create(ManagedMarketingPaymentConfirmationService.prototype), mmDeps) as ManagedMarketingPaymentConfirmationService;
  const router = Object.assign(Object.create(PaymentConfirmationRouter.prototype), {
    marketingPayments: mongo.model('mmPayments'), managedMarketing: mmConfirmation,
  }) as PaymentConfirmationRouter;
  const env = { NODE_ENV: 'development', DEPLOYMENT_ENV: 'local', ...options.env };
  const moduleRef = await Test.createTestingModule({
    controllers: [FakePaymentsDevController, ManagedMarketingController],
    providers: [
      FakePaymentsDevGuard, FakePaymentsDevService,
      { provide: PaymentConfirmationRouter, useValue: router },
      { provide: PAYMENT_PROVIDER_PORT, useValue: provider },
      { provide: ConfigService, useValue: { get: (key: string) => (env as Record<string, unknown>)[key] } },
      { provide: ManagedMarketingService, useValue: {} },
      { provide: ManagedMarketingPaymentService, useValue: mmInitiation },
      { provide: ClockService, useValue: clock },
    ],
  }).overrideGuard(JwtAuthGuard).useClass(TestJwtAuthGuard).compile();
  const app: INestApplication = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app as NestExpressApplication, { NODE_ENV: 'test' });
  await app.init();
  const server = () => request(app.getHttpServer());
  const settle = (paymentId: string, body: unknown, token: string | null = OWNER) => {
    const call = server().post(`/api/v1/dev/fake-payments/${paymentId}/settle`).send(body as any);
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };
  const pay = (requestId: string, body: unknown = {}, token: string | null = OWNER) => {
    const call = server().post(`/api/v1/managed-marketing/requests/${requestId}/payment`).send(body as any);
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };
  return { app, mongo, provider, initiation: mmInitiation, confirmation: mmConfirmation, mmInitiation, router, settle, pay };
}
const codeOf = (res: request.Response) => res.body?.code ?? res.body?.data?.code;
const dataOf = (res: request.Response) => res.body?.data ?? res.body;

describe('POST /dev/fake-payments/:paymentId/settle (development only)', () => {
  let ctx: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => { ctx = await harness(); });
  afterEach(() => ctx.app.close());

  it('changes the FAKE PROVIDER truth only: the payment stays INITIATED and nothing is granted', async () => {
    const attempt = await ctx.initiation.initiate(OWNER, REQUEST);
    const res = await ctx.settle(attempt.paymentId, { outcome: 'success' });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({ settled: true, paymentId: attempt.paymentId, purpose: 'MANAGED_MARKETING', outcome: 'success', triggered: false });
    expect(dataOf(res).confirmation).toBeUndefined();
    expect(ctx.mongo.rows('mmPayments')[0]).toMatchObject({ status: 'INITIATED', isLive: true });
    expect(ctx.mongo.audits.filter((row) => row.action !== 'managed_marketing_payment_initiated')).toHaveLength(0);
    // The provider now answers SUCCEEDED; only the normal confirmation path turns that into an entitlement.
    await expect((ctx.provider as FakePaymentProvider).verify(attempt.providerReference!)).resolves.toMatchObject({ status: 'SUCCEEDED' });
    await ctx.confirmation.confirm(attempt.paymentId);
  });

  it('trigger=true pokes the normal confirmation-by-reference path (as a provider callback would)', async () => {
    const attempt = await ctx.initiation.initiate(OWNER, REQUEST);
    const spy = jest.spyOn(ctx.router, 'confirmByProviderReference');
    const res = await ctx.settle(attempt.paymentId, { outcome: 'success', trigger: true });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({ triggered: true, confirmation: { status: 'SUCCEEDED', pending: false } });
    expect(spy).toHaveBeenCalledWith('fake', attempt.providerReference);
    expect(spy.mock.calls[0]).toHaveLength(2); // a reference, never an outcome
    expect(ctx.mongo.rows('mmPayments')[0].status).toBe('SUCCEEDED');
  });

  it('settling a failure makes the normal path record FAILED', async () => {
    const attempt = await ctx.initiation.initiate(OWNER, REQUEST);
    const res = await ctx.settle(attempt.paymentId, { outcome: 'failed', trigger: true });
    expect(dataOf(res)).toMatchObject({ confirmation: { status: 'FAILED', pending: false } });
  });

  it('a late success after expiry is reported as the domain rejection — still no entitlement', async () => {
    const attempt = await ctx.initiation.initiate(OWNER, REQUEST);
    await ctx.confirmation.expire(attempt.paymentId);
    const res = await ctx.settle(attempt.paymentId, { outcome: 'success', trigger: true });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({ confirmation: { rejectedCode: 'PAYMENT_CONFIRMED_AFTER_EXPIRY' } });
    expect(ctx.mongo.rows('mmPayments')[0]).toMatchObject({ status: 'EXPIRED', reconciliationFlag: 'CONFIRMED_AFTER_EXPIRY' });
  });

  it('is authenticated and owner-scoped: another account, or no token, cannot settle a payment', async () => {
    const attempt = await ctx.initiation.initiate(OWNER, REQUEST);
    expect((await ctx.settle(attempt.paymentId, { outcome: 'success' }, null)).status).toBe(401);
    const other = await ctx.settle(attempt.paymentId, { outcome: 'success' }, BOB);
    expect(other.status).toBe(404);
    expect(codeOf(other)).toBe('PAYMENT_NOT_FOUND');
    expect((await ctx.settle(attempt.paymentId, { outcome: 'success' }, ADMIN)).status).toBe(404);
    await expect((ctx.provider as FakePaymentProvider).verify(attempt.providerReference!)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('works for the managed-marketing purpose, scoped to the request owner', async () => {
    const attempt = await ctx.mmInitiation.initiate(OWNER, REQUEST);
    expect((await ctx.settle(attempt.paymentId, { outcome: 'success' }, ALICE)).status).toBe(404);
    const res = await ctx.settle(attempt.paymentId, { outcome: 'success', trigger: true }, OWNER);
    expect(dataOf(res)).toMatchObject({ purpose: 'MANAGED_MARKETING', confirmation: { status: 'SUCCEEDED' } });
    expect(ctx.mongo.data.requests.get(REQUEST)!.doc.status).toBe(ManagedMarketingRequestStatus.PAID);
  });

  it('validates its input: only success|failed, no extra fields, a real id', async () => {
    const attempt = await ctx.initiation.initiate(OWNER, REQUEST);
    for (const body of [{}, { outcome: 'paid' }, { outcome: 'success', amountMinor: 1 }, { outcome: 'success', status: 'SUCCEEDED' }, { outcome: 'success', trigger: 'yes' }]) {
      expect((await ctx.settle(attempt.paymentId, body)).status).toBe(400);
    }
    expect((await ctx.settle('not-an-id', { outcome: 'success' })).status).toBe(404);
    expect((await ctx.settle(String(new Types.ObjectId()), { outcome: 'success' })).status).toBe(404);
  });

  it('refuses a payment the fake provider already decided (only a pending checkout can be settled)', async () => {
    (ctx.provider as FakePaymentProvider).enqueue('success');
    const attempt = await ctx.initiation.initiate(OWNER, REQUEST);
    const res = await ctx.settle(attempt.paymentId, { outcome: 'failed' });
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe('FAKE_PAYMENT_NOT_PENDING');
  });

  it('the controller and service never write a payment, entitlement or request themselves', () => {
    const read = (file: string) => fs.readFileSync(path.join(__dirname, '../src/payments/dev', file), 'utf8');
    for (const file of ['fake-payments-dev.controller.ts', 'fake-payments-dev.service.ts']) {
      const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(source).not.toMatch(/updateOne|updateMany|findOneAndUpdate|\.create\(|\.save\(|insert|entitlement|\$set|\$unset/i);
    }
  });
});

describe('the fake settle route does not exist outside local/development with the fake provider', () => {
  it.each([
    ['the fail-closed provider (production default)', { provider: new UnconfiguredPaymentProvider(), env: { NODE_ENV: 'development', DEPLOYMENT_ENV: 'local' } }],
    ['production', { env: { NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' } }],
    ['staging', { env: { NODE_ENV: 'production', DEPLOYMENT_ENV: 'staging' } }],
    ['an unresolvable environment', { env: { NODE_ENV: 'production', DEPLOYMENT_ENV: undefined } }],
    ['a real provider adapter in development', { provider: { providerKey: 'real', configured: true, initiate: async () => ({ providerReference: 'r' }), verify: async () => { throw new Error('unused'); } } as PaymentProviderPort }],
  ])('404 with %s — before authentication, for everyone', async (_label, options) => {
    const ctx = await harness(options as any);
    try {
      const id = String(new Types.ObjectId());
      const anonymous = await ctx.settle(id, { outcome: 'success' }, null);
      expect(anonymous.status).toBe(404);
      expect((await ctx.settle(id, { outcome: 'success' }, ALICE)).status).toBe(404);
      expect((await ctx.settle(id, { outcome: 'success' }, ADMIN)).status).toBe(404);
    } finally { await ctx.app.close(); }
  });

  it('the guard rule: a FakePaymentProvider instance AND a non-protected process AND the fake-payments action', () => {
    const fake = new FakePaymentProvider('pending');
    expect(fakePaymentsDevRoutesAllowed(fake, { NODE_ENV: 'development' })).toBe(true);
    expect(fakePaymentsDevRoutesAllowed(fake, { NODE_ENV: 'development', DEPLOYMENT_ENV: 'local' })).toBe(true);
    expect(fakePaymentsDevRoutesAllowed(fake, { NODE_ENV: 'test' })).toBe(true);
    expect(fakePaymentsDevRoutesAllowed(fake, { NODE_ENV: 'production', DEPLOYMENT_ENV: 'staging' })).toBe(false);
    expect(fakePaymentsDevRoutesAllowed(fake, { NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' })).toBe(false);
    expect(fakePaymentsDevRoutesAllowed(fake, { NODE_ENV: 'development', DEPLOYMENT_ENV: 'production' })).toBe(false);
    expect(fakePaymentsDevRoutesAllowed(new UnconfiguredPaymentProvider(), { NODE_ENV: 'development' })).toBe(false);
  });

  it('the fake provider itself still cannot be built in a protected deployment (first two layers unchanged)', () => {
    expect(() => buildPaymentProvider({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production', PAYMENT_PROVIDER: 'fake' })).toThrow(/forbidden in staging and production/);
    expect(() => buildPaymentProvider({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'staging', PAYMENT_PROVIDER: 'fake' })).toThrow(/forbidden/);
    expect(buildPaymentProvider({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' })).toBeInstanceOf(UnconfiguredPaymentProvider);
  });

  it('the guard runs before authentication and the payment domain module registers no controller', () => {
    const guards = Reflect.getMetadata('__guards__', FakePaymentsDevController);
    expect(guards[0]).toBe(FakePaymentsDevGuard);
    expect(guards[1]).toBe(JwtAuthGuard);
    const { PaymentsModule } = require('../src/payments/payments.module');
    expect(Reflect.getMetadata('controllers', PaymentsModule)).toBeUndefined();
  });
});

describe('POST /managed-marketing/requests/:requestId/payment (MAZAD-028)', () => {
  let ctx: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => { ctx = await harness(); });
  afterEach(() => ctx.app.close());

  it('opens the attempt for the snapshot price; the caller supplies nothing', async () => {
    const res = await ctx.pay(REQUEST);
    expect(res.status).toBe(201);
    expect(dataOf(res).payment).toMatchObject({ requestId: REQUEST, amountMinor: PRICE, currency: 'EGP', status: 'INITIATED', reused: false });
    expect(dataOf(res).payment.clientHandoff).toMatch(/^fake:\/\/checkout\//);
    expect(dataOf(res).payment.providerReference).toBeUndefined(); // not part of this contract
    expect(ctx.mongo.data.requests.get(REQUEST)!.doc.paymentStatus).toBe(ManagedMarketingPaymentStatus.PENDING);
    // Initiating never marks the request paid.
    expect(ctx.mongo.data.requests.get(REQUEST)!.doc.status).toBe(ManagedMarketingRequestStatus.APPROVED);
  });

  it('a repeat returns the same live attempt with its stored hand-off', async () => {
    const first = dataOf(await ctx.pay(REQUEST)).payment;
    const again = dataOf(await ctx.pay(REQUEST)).payment;
    expect(again).toMatchObject({ paymentId: first.paymentId, clientHandoff: first.clientHandoff, reused: true });
    expect(ctx.mongo.rows('mmPayments')).toHaveLength(1);
  });

  it.each([{ amountMinor: 1 }, { priceMinor: 1 }, { paid: true }, { status: 'SUCCEEDED' }, { advertiserAccountId: ALICE }])('rejects a body carrying %p', async (body) => {
    expect((await ctx.pay(REQUEST, body)).status).toBe(400);
    expect(ctx.mongo.rows('mmPayments')).toHaveLength(0);
  });

  it('requires authentication, and someone else\'s request looks missing', async () => {
    expect((await ctx.pay(REQUEST, {}, null)).status).toBe(401);
    const res = await ctx.pay(REQUEST, {}, ALICE);
    expect(res.status).toBe(404);
    expect(codeOf(res)).toBe('PAYMENT_NOT_FOUND');
  });

  it('a request that is not approved is not payable', async () => {
    ctx.mongo.data.requests.get(REQUEST)!.doc.status = ManagedMarketingRequestStatus.PENDING_REVIEW;
    const res = await ctx.pay(REQUEST);
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe('PAYMENT_REQUEST_NOT_PAYABLE');
  });

  it('there is still no managed-marketing route that confirms or completes a payment', () => {
    const routes = Object.getOwnPropertyNames(ManagedMarketingController.prototype).filter((name) => name !== 'constructor').sort();
    expect(routes).toEqual(['cancel', 'create', 'listPackages', 'mine', 'pay']);
  });
});
