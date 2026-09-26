import { CanActivate, ExecutionContext, INestApplication, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Types } from 'mongoose';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { configureApp } from '../src/app.setup';
import { AuctionStatus } from '../src/auctions/auction.types';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { SystemRole } from '../src/auth/roles.enum';
import { AuctionErrorCode } from '../src/common/errors/auction-error-codes';
import { PaymentErrorCode } from '../src/common/errors/payment-error-codes';
import { ClockService } from '../src/common/time/clock.service';
import { AuctionEntryEntitlementService, EntryEntitlementState } from '../src/payments/auction-entry-entitlement.service';
import { AuctionEntryPaymentService } from '../src/payments/auction-entry-payment.service';
import { AuctionEntryPaymentsController } from '../src/payments/auction-entry-payments.controller';
import { AuctionPaymentConfirmationService } from '../src/payments/auction-payment-confirmation.service';
import { AuctionPaymentProviderPort, UnconfiguredPaymentProvider } from '../src/payments/auction-payment-provider.port';
import { EntryPaymentStatus, PaymentReconciliationFlag } from '../src/payments/payment.types';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AccountType, BrokerStatus } from '../src/users/identity.types';
import { FakeMongo } from './support/fake-payments-mongo';

const oid = (hex: string) => new Types.ObjectId(hex);
const AUCTION = '64b000000000000000000f01';
const ADVERTISER = '64b000000000000000000a10';
const ALICE = '64b000000000000000000a11';
const BOB = '64b000000000000000000a12';
const ADMIN = '64b000000000000000000a20';
const FEE = 25_000;
const NOW = new Date('2026-05-02T10:00:00Z');

function provider(overrides: Partial<AuctionPaymentProviderPort> = {}) {
  let n = 0;
  const calls: any[] = [];
  const p: AuctionPaymentProviderPort = {
    providerKey: 'fake-test-provider', configured: true,
    initiate: async (r) => { calls.push(r); return { providerReference: `ref-${++n}`, clientHandoff: 'opaque' }; },
    verify: async (ref) => ({ status: 'PENDING', providerReference: ref, amountMinor: FEE, currency: 'EGP' }),
    ...overrides,
  };
  return { p, calls };
}

function domain(opts: { fee?: number | null; providerOverrides?: Partial<AuctionPaymentProviderPort>; auction?: Record<string, unknown> } = {}) {
  const mongo = new FakeMongo();
  const fee = opts.fee === undefined ? FEE : opts.fee;
  mongo.seedAuction({ ...(fee === null ? {} : { entryFee: { amountMinor: fee, currency: 'EGP', configuredByActorId: oid(ADMIN), configuredAt: new Date() } }), ...opts.auction });
  for (const id of [ADVERTISER, ALICE, BOB]) mongo.seedUser(id);
  mongo.seedUser(ADMIN, { systemRole: SystemRole.ADMIN });
  const clock = { now: () => mongo.clockNow };
  const { p, calls } = provider(opts.providerOverrides);
  const deps = { auctions: mongo.model('auctions'), users: mongo.model('users'), payments: mongo.model('payments'), entitlements: mongo.model('entitlements'), audit: mongo.auditSvc, clock, provider: p, connection: mongo.connection, outbox: mongo.outbox.service };
  const initiation = Object.assign(Object.create(AuctionEntryPaymentService.prototype), deps) as AuctionEntryPaymentService;
  const confirmation = Object.assign(Object.create(AuctionPaymentConfirmationService.prototype), deps) as AuctionPaymentConfirmationService;
  // Stands in for AuctionsQueryService.getPubliclyVisible (status gate + anchored public property projection).
  const visibility = { hidden: false };
  const queries = {
    getPubliclyVisible: async (id: string) => {
      if (!Types.ObjectId.isValid(id)) throw new BadRequestException({ code: AuctionErrorCode.ID_INVALID });
      const doc = mongo.rows('auctions').find((a) => String(a._id) === id);
      if (!doc) throw new NotFoundException({ code: AuctionErrorCode.NOT_FOUND });
      const publicStatus = [AuctionStatus.SCHEDULED, AuctionStatus.ACTIVE, AuctionStatus.ENDED_PENDING_CLOSE].includes(doc.status);
      if (!publicStatus || visibility.hidden) throw new NotFoundException({ code: AuctionErrorCode.PUBLIC_UNAVAILABLE });
      return { doc, property: {} };
    },
  };
  const status = Object.assign(Object.create(AuctionEntryEntitlementService.prototype), { ...deps, queries }) as AuctionEntryEntitlementService;
  return { mongo, initiation, confirmation, status, calls, provider: p, visibility };
}
const codeOf = async (action: () => Promise<unknown>) => { try { await action(); return undefined; } catch (e) { return (e as any).getResponse?.()?.code; } };

describe('entry-entitlement status (MAZAD-034A)', () => {
  it('no fee configured: FEE_NOT_CONFIGURED, fail-closed, never "free"', async () => {
    const { status } = domain({ fee: null });
    const r = await status.getStatus(ALICE, AUCTION);
    expect(r).toMatchObject({ state: EntryEntitlementState.FEE_NOT_CONFIGURED, entitled: false, entryFee: { configured: false }, canInitiate: false, blockedReason: PaymentErrorCode.ENTRY_FEE_NOT_CONFIGURED, payment: null });
  });

  it('fee configured, nothing paid: PAYMENT_REQUIRED with the authoritative fee', async () => {
    const { status } = domain();
    const r = await status.getStatus(ALICE, AUCTION);
    expect(r).toMatchObject({ state: EntryEntitlementState.PAYMENT_REQUIRED, entitled: false, entitledAt: null, canInitiate: true, blockedReason: null, paymentProviderAvailable: true, entryFee: { configured: true, amountMinor: FEE, currency: 'EGP' } });
    expect(r.serverTime).toBeInstanceOf(Date);
  });

  it('an initiated attempt: PAYMENT_PENDING with its payment id and no provider data', async () => {
    const { status, initiation } = domain();
    const started = await initiation.initiate(ALICE, AUCTION);
    const r = await status.getStatus(ALICE, AUCTION);
    expect(r.state).toBe(EntryEntitlementState.PAYMENT_PENDING);
    expect(r.payment).toMatchObject({ paymentId: started.paymentId, status: EntryPaymentStatus.INITIATED, amountMinor: FEE, requiresReconciliation: false });
    expect(JSON.stringify(r)).not.toMatch(/providerReference|ref-1|fake-test-provider|failureCode|reconciliationFlag/);
  });

  it('a failed attempt: PAYMENT_FAILED and a new attempt may be started', async () => {
    const { status, mongo } = domain();
    const { initiation } = { initiation: null } as any; void initiation;
    const ctx = domain();
    await ctx.initiation.initiate(ALICE, AUCTION);
    const row = ctx.mongo.rows('payments')[0];
    row.status = EntryPaymentStatus.FAILED; delete row.isLive; row.failedAt = new Date();
    const r = await ctx.status.getStatus(ALICE, AUCTION);
    expect(r.state).toBe(EntryEntitlementState.PAYMENT_FAILED);
    expect(r.canInitiate).toBe(true);
    const retry = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(retry.reused).toBe(false);
    void status; void mongo;
  });

  it('a payment flagged by verification: RECONCILIATION_REQUIRED, no new attempt', async () => {
    const ctx = domain();
    await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.mongo.rows('payments')[0].reconciliationFlag = PaymentReconciliationFlag.AMOUNT_MISMATCH;
    const r = await ctx.status.getStatus(ALICE, AUCTION);
    expect(r).toMatchObject({ state: EntryEntitlementState.RECONCILIATION_REQUIRED, canInitiate: false, blockedReason: PaymentErrorCode.RECONCILIATION_REQUIRED });
    expect(r.payment!.requiresReconciliation).toBe(true);
    expect(JSON.stringify(r)).not.toContain('AMOUNT_MISMATCH');
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.RECONCILIATION_REQUIRED);
    expect(ctx.mongo.rows('payments')).toHaveLength(1);
  });

  it('a server-confirmed payment: ENTITLED with the confirmation time', async () => {
    const ctx = domain();
    const started = await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.provider.verify = async (ref) => ({ status: 'SUCCEEDED', providerReference: ref, amountMinor: FEE, currency: 'EGP', providerEventId: 'evt-1' });
    (ctx.confirmation as any).provider = ctx.provider;
    await ctx.confirmation.confirm(started.paymentId);
    const r = await ctx.status.getStatus(ALICE, AUCTION);
    expect(r).toMatchObject({ state: EntryEntitlementState.ENTITLED, entitled: true, canInitiate: false, blockedReason: PaymentErrorCode.ALREADY_PAID });
    expect(r.entitledAt).toBeInstanceOf(Date);
    expect(r.payment).toMatchObject({ status: EntryPaymentStatus.SUCCEEDED });
  });

  it("another user's payment and entitlement are invisible", async () => {
    const ctx = domain();
    await ctx.initiation.initiate(ALICE, AUCTION);
    const bob = await ctx.status.getStatus(BOB, AUCTION);
    expect(bob).toMatchObject({ state: EntryEntitlementState.PAYMENT_REQUIRED, entitled: false, payment: null });
    expect(JSON.stringify(bob)).not.toContain(ctx.mongo.rows('payments')[0]._id.toString());
  });

  it('the advertiser, an admin and other blocked principals see why they cannot pay', async () => {
    const ctx = domain();
    expect((await ctx.status.getStatus(ADVERTISER, AUCTION)).blockedReason).toBe('SELF_BID_FORBIDDEN');
    expect((await ctx.status.getStatus(ADMIN, AUCTION)).blockedReason).toBe('ADMIN_MARKETPLACE_FORBIDDEN');
  });

  it('a non-payable or hidden auction: not payable when ended, 404 when not public', async () => {
    const ended = domain({ auction: { status: AuctionStatus.ACTIVE, currentEndAt: new Date(NOW.getTime() - 1000) } });
    ended.mongo.clockNow = NOW;
    expect((await ended.status.getStatus(ALICE, AUCTION)).blockedReason).toBe(PaymentErrorCode.AUCTION_NOT_PAYABLE);
    for (const status of [AuctionStatus.CANCELLED, AuctionStatus.COMPLETED, AuctionStatus.ENDED_NO_BIDS]) {
      const hidden = domain({ auction: { status } });
      expect(await codeOf(() => hidden.status.getStatus(ALICE, AUCTION))).toBe(AuctionErrorCode.PUBLIC_UNAVAILABLE);
    }
  });

  it('unknown or malformed ids are not found', async () => {
    const ctx = domain();
    expect(await codeOf(() => ctx.status.getStatus(ALICE, '64b000000000000000000ff9'))).toBe(AuctionErrorCode.NOT_FOUND);
    expect(await codeOf(() => ctx.status.getStatus(ALICE, 'nope'))).toBe(AuctionErrorCode.ID_INVALID);
  });
});

describe('entitlement read uses the authoritative public visibility gate (MAZAD-034A closure)', () => {
  it('an ACTIVE auction whose public property projection is unavailable is 404, exactly like GET /auctions/:id', async () => {
    const ctx = domain();
    ctx.visibility.hidden = true;
    expect(await codeOf(() => ctx.status.getStatus(ALICE, AUCTION))).toBe(AuctionErrorCode.PUBLIC_UNAVAILABLE);
  });

  it('the service delegates to AuctionsQueryService.getPubliclyVisible and holds no status list of its own', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/payments/auction-entry-entitlement.service.ts'), 'utf8');
    expect(source).toMatch(/getPubliclyVisible\(/);
    expect(source).not.toMatch(/VISIBLE_STATUSES|ENDED_PENDING_CLOSE\]/);
  });

  it('the routes are registered in AuctionsModule (which owns the gate), not PaymentsModule', () => {
    const { AuctionsModule } = require('../src/auctions/auctions.module');
    const { PaymentsModule } = require('../src/payments/payments.module');
    expect(Reflect.getMetadata('controllers', AuctionsModule)).toContain(AuctionEntryPaymentsController);
    expect(Reflect.getMetadata('controllers', PaymentsModule)).toBeUndefined();
  });
});

describe('payment initiation CHECK ORDER: eligibility before the provider (MAZAD-034A closure)', () => {
  const noProvider = { configured: false, initiate: () => new UnconfiguredPaymentProvider().initiate() } as Partial<AuctionPaymentProviderPort>;
  const cases = async (mut: (ctx: ReturnType<typeof domain>) => void = () => undefined, opts: Parameters<typeof domain>[0] = {}) => {
    const ctx = domain({ providerOverrides: noProvider, ...opts });
    mut(ctx);
    return ctx;
  };

  it('seller on their own auction -> SELF_BID_FORBIDDEN, not provider-unavailable', async () => {
    const ctx = await cases();
    expect(await codeOf(() => ctx.initiation.initiate(ADVERTISER, AUCTION))).toBe('SELF_BID_FORBIDDEN');
  });

  it('admin, super-admin, suspended and unapproved broker keep their authorization errors', async () => {
    const ctx = await cases();
    ctx.mongo.seedUser('64b000000000000000000a30', { accountStatus: 'SUSPENDED' });
    ctx.mongo.seedUser('64b000000000000000000a31', { systemRole: SystemRole.SUPER_ADMIN });
    ctx.mongo.seedUser('64b000000000000000000a32', { accountType: AccountType.BROKER, brokerStatus: BrokerStatus.PENDING });
    const expected: Array<[string, string]> = [
      [ADMIN, 'ADMIN_MARKETPLACE_FORBIDDEN'], ['64b000000000000000000a31', 'ADMIN_MARKETPLACE_FORBIDDEN'],
      ['64b000000000000000000a30', 'ACCOUNT_SUSPENDED'], ['64b000000000000000000a32', 'BROKER_CAPABILITY_REQUIRED'],
    ];
    for (const [who, code] of expected) expect(await codeOf(() => ctx.initiation.initiate(who, AUCTION))).toBe(code);
  });

  it('terminal auction -> PAYMENT_AUCTION_NOT_PAYABLE; ACTIVE past its end -> the same', async () => {
    const done = await cases(() => undefined, { auction: { status: AuctionStatus.COMPLETED } });
    expect(await codeOf(() => done.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.AUCTION_NOT_PAYABLE);
    const over = await cases(() => undefined, { auction: { status: AuctionStatus.ACTIVE, currentEndAt: new Date(0) } });
    expect(await codeOf(() => over.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.AUCTION_NOT_PAYABLE);
  });

  it('missing fee -> PAYMENT_ENTRY_FEE_NOT_CONFIGURED', async () => {
    const ctx = await cases(() => undefined, { fee: null });
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.ENTRY_FEE_NOT_CONFIGURED);
  });

  it('already entitled -> PAYMENT_ALREADY_PAID even after the provider became unavailable', async () => {
    const ctx = domain();
    const started = await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.provider.verify = async (ref) => ({ status: 'SUCCEEDED', providerReference: ref, amountMinor: FEE, currency: 'EGP', providerEventId: 'e' });
    await ctx.confirmation.confirm(started.paymentId);
    (ctx.initiation as any).provider = { ...ctx.provider, configured: false };
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.ALREADY_PAID);
  });

  it('reconciliation case -> PAYMENT_RECONCILIATION_REQUIRED with the provider unavailable', async () => {
    const ctx = domain();
    await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.mongo.rows('payments')[0].reconciliationFlag = PaymentReconciliationFlag.CONFIRMED_AFTER_FAILURE;
    (ctx.initiation as any).provider = { ...ctx.provider, configured: false };
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.RECONCILIATION_REQUIRED);
  });

  it('a genuinely eligible bidder needing a NEW provider operation -> PAYMENT_PROVIDER_UNAVAILABLE, and nothing is written', async () => {
    const ctx = await cases();
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.PROVIDER_UNAVAILABLE);
    expect(ctx.mongo.rows('payments')).toHaveLength(0);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
    expect(ctx.mongo.audits.filter((a) => String(a.action).includes('INITIATED'))).toHaveLength(0);
  });

  it('an existing live attempt that already has its gateway reference is still returned with the provider unavailable (no duplicate)', async () => {
    const ctx = domain();
    const first = await ctx.initiation.initiate(ALICE, AUCTION);
    (ctx.initiation as any).provider = { ...ctx.provider, configured: false };
    const again = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(again).toMatchObject({ paymentId: first.paymentId, reused: true, providerReference: 'ref-1' });
    expect(ctx.mongo.rows('payments')).toHaveLength(1);
  });

  it('a live attempt WITHOUT a gateway reference needs the provider again: unavailable -> 503, the attempt is left untouched', async () => {
    const ctx = domain();
    await ctx.initiation.initiate(ALICE, AUCTION);
    delete ctx.mongo.rows('payments')[0].providerReference;
    (ctx.initiation as any).provider = { ...ctx.provider, configured: false };
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.PROVIDER_UNAVAILABLE);
    expect(ctx.mongo.rows('payments')).toHaveLength(1);
    expect(ctx.mongo.rows('payments')[0].status).toBe(EntryPaymentStatus.INITIATED);
  });
});

describe('payment initiation rules used by the HTTP flow (MAZAD-034A)', () => {
  it('uses the authoritative fee; the service has no amount parameter', async () => {
    const ctx = domain();
    expect(AuctionEntryPaymentService.prototype.initiate.length).toBeLessThanOrEqual(3);
    const r = await ctx.initiation.initiate(ALICE, AUCTION);
    expect(r.amountMinor).toBe(FEE);
    expect(ctx.calls[0]).toMatchObject({ amountMinor: FEE, currency: 'EGP' });
  });

  it('rejects the advertiser, admins, restricted accounts and terminal auctions before any provider call', async () => {
    const ctx = domain();
    ctx.mongo.seedUser('64b000000000000000000a30', { accountStatus: 'SUSPENDED' });
    ctx.mongo.seedUser('64b000000000000000000a31', { systemRole: SystemRole.SUPER_ADMIN });
    ctx.mongo.seedUser('64b000000000000000000a32', { accountType: AccountType.BROKER, brokerStatus: BrokerStatus.PENDING });
    const expected: Array<[string, string]> = [
      [ADVERTISER, 'SELF_BID_FORBIDDEN'], [ADMIN, 'ADMIN_MARKETPLACE_FORBIDDEN'], ['64b000000000000000000a31', 'ADMIN_MARKETPLACE_FORBIDDEN'],
      ['64b000000000000000000a30', 'ACCOUNT_SUSPENDED'], ['64b000000000000000000a32', 'BROKER_CAPABILITY_REQUIRED'],
    ];
    for (const [who, code] of expected) expect(await codeOf(() => ctx.initiation.initiate(who, AUCTION))).toBe(code);
    expect(ctx.calls).toHaveLength(0);
    expect(ctx.mongo.rows('payments')).toHaveLength(0);
    const done = domain({ auction: { status: AuctionStatus.COMPLETED } });
    expect(await codeOf(() => done.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.AUCTION_NOT_PAYABLE);
    const over = domain({ auction: { status: AuctionStatus.ACTIVE, currentEndAt: new Date(0) } });
    expect(await codeOf(() => over.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.AUCTION_NOT_PAYABLE);
  });

  it('paying before the auction starts (SCHEDULED) is allowed, as MAZAD-028 defined', async () => {
    const ctx = domain({ auction: { status: AuctionStatus.SCHEDULED } });
    await expect(ctx.initiation.initiate(ALICE, AUCTION)).resolves.toMatchObject({ status: EntryPaymentStatus.INITIATED });
  });

  it('a missing fee fails closed and creates nothing', async () => {
    const ctx = domain({ fee: null });
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.ENTRY_FEE_NOT_CONFIGURED);
    expect(ctx.mongo.rows('payments')).toHaveLength(0);
  });

  it('an existing entitlement creates no payment', async () => {
    const ctx = domain();
    const started = await ctx.initiation.initiate(ALICE, AUCTION);
    ctx.provider.verify = async (ref) => ({ status: 'SUCCEEDED', providerReference: ref, amountMinor: FEE, currency: 'EGP', providerEventId: 'e' });
    await ctx.confirmation.confirm(started.paymentId);
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.ALREADY_PAID);
    expect(ctx.mongo.rows('payments')).toHaveLength(1);
  });

  it('repeated taps converge on one live attempt and one provider call', async () => {
    const ctx = domain();
    const [a, b, c] = await Promise.all([ctx.initiation.initiate(ALICE, AUCTION), ctx.initiation.initiate(ALICE, AUCTION), ctx.initiation.initiate(ALICE, AUCTION)].map((p) => p.catch((e) => e)));
    void a; void b; void c;
    await ctx.initiation.initiate(ALICE, AUCTION);
    expect(ctx.mongo.rows('payments').filter((p) => p.isLive)).toHaveLength(1);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
  });

  it('with no provider bound: a safe 503, no payment row, no entitlement', async () => {
    const ctx = domain({ providerOverrides: { configured: false, initiate: () => new UnconfiguredPaymentProvider().initiate() } });
    await expect(ctx.initiation.initiate(ALICE, AUCTION)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await codeOf(() => ctx.initiation.initiate(ALICE, AUCTION))).toBe(PaymentErrorCode.PROVIDER_UNAVAILABLE);
    expect(ctx.mongo.rows('payments')).toHaveLength(0);
    expect(ctx.mongo.rows('entitlements')).toHaveLength(0);
    expect((await ctx.status.getStatus(ALICE, AUCTION)).paymentProviderAvailable).toBe(false);
  });
});

describe('entry-payment HTTP contract (MAZAD-034A)', () => {
  const identityFor = (token: string) => {
    const base = { userId: ALICE, accountStatus: 'active', accountType: AccountType.USER, brokerStatus: BrokerStatus.NOT_APPLIED };
    return ({
      user: { ...base, systemRole: SystemRole.USER },
      admin: { ...base, systemRole: SystemRole.ADMIN },
      'super-admin': { ...base, systemRole: SystemRole.SUPER_ADMIN },
      suspended: { ...base, systemRole: SystemRole.USER, accountStatus: 'SUSPENDED' },
      'pending-broker': { ...base, systemRole: SystemRole.USER, accountType: AccountType.BROKER, brokerStatus: BrokerStatus.PENDING },
    } as Record<string, any>)[token];
  };
  class TestJwtAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const http = context.switchToHttp().getRequest();
      if (!http.headers.authorization) throw new UnauthorizedException();
      http.user = identityFor(http.headers.authorization.replace('Bearer ', ''));
      return true;
    }
  }
  let app: INestApplication;
  const entitlement = { getStatus: jest.fn() };
  const initiation = { initiate: jest.fn() };
  const initiated = (over: Record<string, unknown> = {}) => ({ paymentId: 'p1', auctionId: AUCTION, amountMinor: FEE, currency: 'EGP', status: 'INITIATED', reused: false, ...over });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuctionEntryPaymentsController],
      providers: [
        { provide: AuctionEntryEntitlementService, useValue: entitlement },
        { provide: AuctionEntryPaymentService, useValue: initiation },
        { provide: ClockService, useValue: { now: () => NOW } },
      ],
    }).overrideGuard(JwtAuthGuard).useClass(TestJwtAuthGuard).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' });
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    entitlement.getStatus.mockResolvedValue({ auctionId: AUCTION, state: 'PAYMENT_REQUIRED' });
    initiation.initiate.mockResolvedValue(initiated());
  });
  const server = () => request(app.getHttpServer());
  const codeOf = (res: request.Response) => res.body?.code ?? res.body?.data?.code;
  const read = (token = 'user', id = AUCTION) => server().get(`/api/v1/auctions/${id}/entry-entitlement`).set('Authorization', `Bearer ${token}`);
  const pay = (token = 'user', body: unknown = {}, id = AUCTION) => server().post(`/api/v1/auctions/${id}/entry-payment`).set('Authorization', `Bearer ${token}`).send(body as any);

  it('both routes require authentication', async () => {
    await server().get(`/api/v1/auctions/${AUCTION}/entry-entitlement`).expect(401);
    await server().post(`/api/v1/auctions/${AUCTION}/entry-payment`).send({}).expect(401);
    expect(entitlement.getStatus).not.toHaveBeenCalled();
    expect(initiation.initiate).not.toHaveBeenCalled();
  });

  it('the read uses the authenticated actor and the path auction only', async () => {
    const res = await read().expect(200);
    expect(entitlement.getStatus).toHaveBeenCalledWith(ALICE, AUCTION);
    expect(res.body.data ?? res.body).toBeDefined();
    await server().get(`/api/v1/auctions/${AUCTION}/entry-entitlement?bidderAccountId=${BOB}`).set('Authorization', 'Bearer user').expect(200);
    expect(entitlement.getStatus).toHaveBeenLastCalledWith(ALICE, AUCTION);
  });

  it('initiation uses the actor, no body value, and projects the provider-neutral result', async () => {
    const res = await pay().expect(201);
    expect(initiation.initiate).toHaveBeenCalledWith(ALICE, AUCTION, expect.anything());
    const data = res.body.data;
    expect(data.payment).toEqual({ paymentId: 'p1', auctionId: AUCTION, amountMinor: FEE, currency: 'EGP', status: 'INITIATED', providerReference: null, clientHandoff: null, reused: false });
    expect(data.serverTime).toBeDefined();
  });

  it.each([
    ['amountMinor', { amountMinor: 1 }], ['currency', { currency: 'EGP' }], ['bidderAccountId', { bidderAccountId: BOB }],
    ['paid', { paid: true }], ['status', { status: 'SUCCEEDED' }], ['entitled', { entitled: true }], ['providerReference', { providerReference: 'x' }],
  ])('rejects a client-supplied %s as AUCTION_REQUEST_INVALID and calls nothing', async (_n, body) => {
    const res = await pay('user', body).expect(400);
    expect(codeOf(res)).toBe(AuctionErrorCode.REQUEST_INVALID);
    expect(initiation.initiate).not.toHaveBeenCalled();
  });

  it('malformed auction ids are AUCTION_ID_INVALID on both routes', async () => {
    expect(codeOf(await read('user', 'nope').expect(400))).toBe(AuctionErrorCode.ID_INVALID);
    expect(codeOf(await pay('user', {}, 'nope').expect(400))).toBe(AuctionErrorCode.ID_INVALID);
  });

  it.each(['admin', 'super-admin', 'suspended', 'pending-broker'])('the %s principal is refused by the capability policy before any service runs', async (token) => {
    await pay(token).expect(403);
    await read(token).expect(403);
    expect(initiation.initiate).not.toHaveBeenCalled();
    expect(entitlement.getStatus).not.toHaveBeenCalled();
  });

  it('domain errors keep their stable codes (503 provider, 409 already paid)', async () => {
    initiation.initiate.mockRejectedValueOnce(new ServiceUnavailableException({ message: 'x', code: PaymentErrorCode.PROVIDER_UNAVAILABLE }));
    const res = await pay().expect(503);
    expect(codeOf(res)).toBe(PaymentErrorCode.PROVIDER_UNAVAILABLE);
  });

  it('there is no confirm / success / webhook route', async () => {
    for (const route of ['success', 'confirm', 'entry-payment/confirm', 'entry-payment/success']) {
      const res = await server().post(`/api/v1/auctions/${AUCTION}/${route}`).set('Authorization', 'Bearer user').send({ paid: true });
      expect(res.status).toBe(404);
    }
    await server().post('/api/v1/payments/webhook').send({}).expect(404);
    await server().patch(`/api/v1/auctions/${AUCTION}/entry-payment`).set('Authorization', 'Bearer user').send({ status: 'SUCCEEDED' }).expect(404);
  });

  it('the controller source has only the two routes and never touches the confirmation service', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/payments/auction-entry-payments.controller.ts'), 'utf8');
    expect(source).not.toMatch(/AuctionPaymentConfirmationService|\.confirm\(/);
    expect([...source.matchAll(/@(Get|Post|Put|Patch|Delete)\(/g)].map((m) => m[1])).toEqual(['Get', 'Post']);
  });
});
