import { CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { SystemRole } from '../src/auth/roles.enum';
import { RolesGuard } from '../src/auth/roles.guard';
import { AuthorizationPolicyService } from '../src/authorization/authorization-policy.service';
import { Capability } from '../src/authorization/capability';
import { AuctionErrorCode } from '../src/common/errors/auction-error-codes';
import { AdminAuctionRequestsController } from '../src/auctions/admin-auction-requests.controller';
import { AuctionActivationGate } from '../src/auctions/auction-activation-gate';
import { entryFeeView } from '../src/auctions/auction-projections';
import {
  AUCTION_MAX_DURATION_MS,
  AUCTION_MIN_DURATION_MS,
  AUCTION_REQUEST_TRANSITIONS,
  AuctionActivationHoldCode,
  AuctionRequestStatus,
  assertReasonWithNote,
  assertValidAuctionRequestTransition,
  validateAuctionRequestTerms,
} from '../src/auctions/auction-request.types';
import { AuctionRequestsController } from '../src/auctions/auction-requests.controller';
import { AuctionRequestsService } from '../src/auctions/auction-requests.service';
import { AUCTION_REQUEST_INDEXES, AuctionRequestSchema } from '../src/auctions/schemas/auction-request.schema';
import { AuctionSchema } from '../src/auctions/schemas/auction.schema';
import { AuctionEntryPaymentSchema } from '../src/payments/schemas/auction-entry-payment.schema';
import { MAZAD035_INDEXES } from '../src/migrations/036-mazad035-auction-review';
import { mapNotificationEvent } from '../src/notifications/notification-event.mapper';
import { NotificationTargetType, NotificationType } from '../src/notifications/notification.types';
import {
  OutboxAggregateType,
  assertValidOutboxDraft,
  auctionCancelledEvent,
  auctionRequestApprovedEvent,
  auctionRequestRejectedEvent,
} from '../src/outbox/outbox-events';
import { REALTIME_SUBSCRIBED_EVENT_TYPES } from '../src/realtime/realtime-events';
import { AuctionEntryEntitlementService, EntryEntitlementState } from '../src/payments/auction-entry-entitlement.service';
import { isFreeEntryFee } from '../src/payments/persistent-bid-entitlement.port';
import { AccountStatus, AccountType, BrokerStatus } from '../src/users/identity.types';

/**
 * MAZAD-035 pure logic (no database): the terms policy (Product decisions 3/4),
 * the AuctionRequest state machine (no DRAFT, decisions 1/6/11), reason/note
 * rules (8), outbox/notification mapping (14), free vs missing fee (5), the
 * activation gate, schema/migration parity and the HTTP pipeline for the new
 * routes. The transactional behaviour is covered on a real replica set by
 * `mazad035-local-db.spec.ts`.
 */
const NOW = new Date('2026-10-01T10:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const codeOf = (fn: () => unknown) => { try { fn(); return 'OK'; } catch (error) { return (error as any).getResponse?.()?.code ?? (error as Error).message; } };
const ID = (n: number) => `64b0000000000000000000${n.toString(16).padStart(2, '0')}`;

describe('terms policy (decisions 3 and 4)', () => {
  const terms = (startMs: number, durationMs: number, overrides: Record<string, unknown> = {}) => ({
    startingPriceMinor: 100_000, minimumBidStepMinor: 5_000, proposedStartAt: at(startMs), proposedEndAt: at(startMs + durationMs), ...overrides,
  });

  it('has no approval lead time: any start strictly after the server time is accepted', () => {
    expect(codeOf(() => validateAuctionRequestTerms(terms(1, AUCTION_MIN_DURATION_MS), NOW))).toBe('OK');
    expect(codeOf(() => validateAuctionRequestTerms(terms(0, AUCTION_MIN_DURATION_MS), NOW))).toBe(AuctionErrorCode.SCHEDULE_EXPIRED);
    expect(codeOf(() => validateAuctionRequestTerms(terms(-1, AUCTION_MIN_DURATION_MS), NOW))).toBe(AuctionErrorCode.SCHEDULE_EXPIRED);
  });

  it('bounds the duration to [1 hour, 30 days] inclusive', () => {
    expect(AUCTION_MIN_DURATION_MS).toBe(3_600_000);
    expect(AUCTION_MAX_DURATION_MS).toBe(30 * 24 * 3_600_000);
    expect(codeOf(() => validateAuctionRequestTerms(terms(60_000, AUCTION_MIN_DURATION_MS - 1), NOW))).toBe(AuctionErrorCode.DURATION_TOO_SHORT);
    expect(codeOf(() => validateAuctionRequestTerms(terms(60_000, AUCTION_MIN_DURATION_MS), NOW))).toBe('OK');
    expect(codeOf(() => validateAuctionRequestTerms(terms(60_000, AUCTION_MAX_DURATION_MS), NOW))).toBe('OK');
    expect(codeOf(() => validateAuctionRequestTerms(terms(60_000, AUCTION_MAX_DURATION_MS + 1), NOW))).toBe(AuctionErrorCode.DURATION_TOO_LONG);
    expect(codeOf(() => validateAuctionRequestTerms(terms(60_000, 0), NOW))).toBe(AuctionErrorCode.SCHEDULE_INVALID);
  });

  it('requires positive integer EGP minor units and real dates', () => {
    for (const bad of [0, -1, 1.5, '100', null]) {
      expect(codeOf(() => validateAuctionRequestTerms(terms(60_000, AUCTION_MIN_DURATION_MS, { startingPriceMinor: bad }), NOW))).toBe(AuctionErrorCode.STARTING_PRICE_INVALID);
      expect(codeOf(() => validateAuctionRequestTerms(terms(60_000, AUCTION_MIN_DURATION_MS, { minimumBidStepMinor: bad }), NOW))).toBe(AuctionErrorCode.MINIMUM_BID_STEP_INVALID);
    }
    expect(codeOf(() => validateAuctionRequestTerms(terms(60_000, AUCTION_MIN_DURATION_MS, { proposedStartAt: new Date('x') }), NOW))).toBe(AuctionErrorCode.SCHEDULE_INVALID);
    expect(validateAuctionRequestTerms(terms(60_000, AUCTION_MIN_DURATION_MS), NOW).currency).toBe('EGP');
  });
});

describe('AuctionRequest state machine (decisions 1, 6, 7, 11)', () => {
  it('has no DRAFT state; the first persisted state is PENDING_REVIEW', () => {
    expect(Object.values(AuctionRequestStatus).sort()).toEqual(['approved', 'pending_review', 'rejected', 'withdrawn']);
  });

  it.each([
    [AuctionRequestStatus.PENDING_REVIEW, AuctionRequestStatus.APPROVED],
    [AuctionRequestStatus.PENDING_REVIEW, AuctionRequestStatus.REJECTED],
    [AuctionRequestStatus.PENDING_REVIEW, AuctionRequestStatus.WITHDRAWN],
    [AuctionRequestStatus.REJECTED, AuctionRequestStatus.PENDING_REVIEW],
    [AuctionRequestStatus.REJECTED, AuctionRequestStatus.WITHDRAWN],
    [AuctionRequestStatus.APPROVED, AuctionRequestStatus.PENDING_REVIEW],
  ])('allows %s -> %s', (from, to) => expect(codeOf(() => assertValidAuctionRequestTransition(from, to))).toBe('OK'));

  it('rejects everything else (a rejected request never auto-becomes pending; withdrawn is terminal; approved cannot be withdrawn)', () => {
    const all = Object.values(AuctionRequestStatus);
    let illegal = 0;
    for (const from of all) for (const to of all) {
      if (from === to || AUCTION_REQUEST_TRANSITIONS[from].has(to)) continue;
      illegal += 1;
      expect(codeOf(() => assertValidAuctionRequestTransition(from, to))).toBe(AuctionErrorCode.REQUEST_TRANSITION_INVALID);
    }
    expect(illegal).toBe(6);
    expect(AUCTION_REQUEST_TRANSITIONS[AuctionRequestStatus.WITHDRAWN].size).toBe(0);
    expect(AUCTION_REQUEST_TRANSITIONS[AuctionRequestStatus.APPROVED].has(AuctionRequestStatus.WITHDRAWN)).toBe(false);
  });
});

describe('structured reasons (decision 8 and rejection)', () => {
  const codes = ['FRAUD_SUSPECTED', 'OTHER'];
  it('requires a code from the closed list; OTHER requires a note; other codes do not', () => {
    expect(codeOf(() => assertReasonWithNote(undefined, codes, undefined))).toBe(AuctionErrorCode.REASON_CODE_REQUIRED);
    expect(codeOf(() => assertReasonWithNote('made_up', codes, 'x'))).toBe(AuctionErrorCode.REASON_CODE_REQUIRED);
    expect(codeOf(() => assertReasonWithNote('OTHER', codes, '   '))).toBe(AuctionErrorCode.NOTE_REQUIRED);
    expect(assertReasonWithNote('OTHER', codes, '  تفاصيل  ')).toEqual({ reasonCode: 'OTHER', note: 'تفاصيل' });
    expect(assertReasonWithNote('FRAUD_SUSPECTED', codes, undefined)).toEqual({ reasonCode: 'FRAUD_SUSPECTED' });
  });
});

describe('fee semantics (decision 5)', () => {
  it('0 EGP is an explicitly configured FREE fee; absence or malformed values are never free', () => {
    expect(isFreeEntryFee({ amountMinor: 0, currency: 'EGP' })).toBe(true);
    for (const fee of [undefined, null, {}, { amountMinor: 0 }, { amountMinor: '0', currency: 'EGP' }, { amountMinor: 1, currency: 'EGP' }, { amountMinor: -0.1, currency: 'EGP' }]) {
      expect(isFreeEntryFee(fee as any)).toBe(false);
    }
    expect(entryFeeView({ currency: 'EGP' })).toEqual({ configured: false, free: false, amountMinor: null, currency: 'EGP' });
    expect(entryFeeView({ entryFee: { amountMinor: 0, currency: 'EGP' } })).toEqual({ configured: true, free: true, amountMinor: 0, currency: 'EGP' });
    expect(entryFeeView({ entryFee: { amountMinor: 5_000, currency: 'EGP' } })).toEqual({ configured: true, free: false, amountMinor: 5_000, currency: 'EGP' });
    const feePath = (AuctionSchema.path('entryFee') as any).schema.path('amountMinor');
    expect(feePath.doValidateSync(0)).toBeFalsy();
    expect(feePath.doValidateSync(-1)).toBeTruthy();
  });

  describe('entry entitlement read model', () => {
    const service = (fee: unknown, actor: Record<string, unknown> = {}) => {
      const auction = { _id: ID(1), status: 'scheduled', advertiserAccountId: ID(2), currentEndAt: at(3_600_000), ...(fee === undefined ? {} : { entryFee: fee }) };
      const none = { lean: () => ({ exec: async () => null }), sort: () => ({ lean: () => ({ exec: async () => null }) }) };
      return Object.assign(Object.create(AuctionEntryEntitlementService.prototype), {
        queries: { getPubliclyVisible: async () => ({ doc: auction }) },
        users: { findById: () => ({ lean: () => ({ exec: async () => ({ _id: ID(3), systemRole: SystemRole.USER, accountType: AccountType.USER, accountStatus: AccountStatus.ACTIVE, brokerStatus: BrokerStatus.NOT_APPLIED, ...actor }) }) }) },
        payments: { findOne: () => none }, entitlements: { findOne: () => none },
        clock: { now: () => NOW }, provider: { configured: true },
      }) as AuctionEntryEntitlementService;
    };
    it('FREE: FREE_ENTRY, no payment required, eligible bidder can bid without a payment', async () => {
      expect(await service({ amountMinor: 0, currency: 'EGP' }).getStatus(ID(3), ID(1))).toMatchObject({
        state: EntryEntitlementState.FREE_ENTRY, paymentRequired: false, freeBiddingEligible: true, canInitiate: false, blockedReason: 'PAYMENT_NOT_REQUIRED', payment: null, entitled: false,
      });
    });
    it('FREE still reports the first failing bidding policy (advertiser, suspended, staff)', async () => {
      expect(await service({ amountMinor: 0, currency: 'EGP' }, { _id: ID(2) }).getStatus(ID(2), ID(1))).toMatchObject({ freeBiddingEligible: false, blockedReason: 'SELF_BID_FORBIDDEN' });
      expect(await service({ amountMinor: 0, currency: 'EGP' }, { accountStatus: AccountStatus.SUSPENDED }).getStatus(ID(3), ID(1))).toMatchObject({ freeBiddingEligible: false, blockedReason: 'ACCOUNT_SUSPENDED' });
      expect(await service({ amountMinor: 0, currency: 'EGP' }, { systemRole: SystemRole.ADMIN }).getStatus(ID(3), ID(1))).toMatchObject({ freeBiddingEligible: false, blockedReason: 'ADMIN_MARKETPLACE_FORBIDDEN' });
    });
    it('PAID: PAYMENT_REQUIRED with the configured fee; MISSING: FEE_NOT_CONFIGURED (never free)', async () => {
      expect(await service({ amountMinor: 50_000, currency: 'EGP' }).getStatus(ID(3), ID(1))).toMatchObject({ state: EntryEntitlementState.PAYMENT_REQUIRED, paymentRequired: true, freeBiddingEligible: false, canInitiate: true, entryFee: { configured: true, free: false, amountMinor: 50_000 } });
      expect(await service(undefined).getStatus(ID(3), ID(1))).toMatchObject({ state: EntryEntitlementState.FEE_NOT_CONFIGURED, paymentRequired: false, freeBiddingEligible: false, canInitiate: false, entryFee: { configured: false, free: false } });
    });
  });
});

describe('activation gate', () => {
  const gate = (seller: unknown, facts: unknown, anchor: unknown) => new AuctionActivationGate(
    { findById: () => ({ session: () => ({ lean: () => ({ exec: async () => seller }) }) }) } as any,
    { getAuctionOriginationFacts: async () => facts, resolveAuctionAnchor: async () => anchor } as any,
  );
  const auction = (fee: unknown = { amountMinor: 0, currency: 'EGP' }) => ({ entryFee: fee, advertiserAccountId: ID(2), propertyId: ID(4), propertyRevisionId: ID(5) });
  const seller = { _id: ID(2), systemRole: SystemRole.USER, accountType: AccountType.USER, accountStatus: AccountStatus.ACTIVE, brokerStatus: BrokerStatus.NOT_APPLIED };
  const facts = { publiclyVisible: true, advertiserAccountId: ID(2) };
  const session = {} as any;
  it('passes a valid auction (FREE counts as configured)', async () => {
    expect(await gate(seller, facts, { operationType: 'sale' }).evaluate(auction(), session)).toBeNull();
  });
  it.each([
    ['missing fee', auction(null), seller, facts, { operationType: 'sale' }, AuctionActivationHoldCode.ENTRY_FEE_MISSING],
    ['suspended seller', auction(), { ...seller, accountStatus: AccountStatus.SUSPENDED }, facts, { operationType: 'sale' }, AuctionActivationHoldCode.SELLER_NOT_ELIGIBLE],
    ['unapproved broker', auction(), { ...seller, accountType: AccountType.BROKER, brokerStatus: BrokerStatus.PENDING }, facts, { operationType: 'sale' }, AuctionActivationHoldCode.SELLER_NOT_ELIGIBLE],
    ['hidden property', auction(), seller, { ...facts, publiclyVisible: false }, { operationType: 'sale' }, AuctionActivationHoldCode.PROPERTY_NOT_ELIGIBLE],
    ['property changed hands', auction(), seller, { ...facts, advertiserAccountId: ID(9) }, { operationType: 'sale' }, AuctionActivationHoldCode.PROPERTY_NOT_ELIGIBLE],
    ['anchor gone', auction(), seller, facts, null, AuctionActivationHoldCode.ANCHOR_UNRESOLVED],
    ['rent', auction(), seller, facts, { operationType: 'rent' }, AuctionActivationHoldCode.PROPERTY_NOT_SALE],
  ])('holds a %s', async (_label, subject, s, f, anchor, expected) => {
    expect(await gate(s, f, anchor).evaluate(subject, session)).toBe(expected);
  });
});

describe('outbox and notifications (decision 14, realtime isolation)', () => {
  const T = new Date('2026-10-01T10:00:00.000Z');
  const delivery = (draft: any) => ({ ...draft, eventId: ID(99), aggregateVersion: 1, attempt: 1 });

  it('review events are PRIVATE on their own AUCTION_REQUEST stream and never subscribed by realtime', () => {
    const approved = auctionRequestApprovedEvent({ requestId: ID(1), auctionId: ID(2), occurredAt: T, entryFeeMinor: 0, scheduledStartAt: T, scheduledEndAt: T, advertiserAccountId: ID(3) });
    const rejected = auctionRequestRejectedEvent({ requestId: ID(1), occurredAt: T, rejectionCode: 'OTHER', advertiserAccountId: ID(3) });
    for (const draft of [approved, rejected]) {
      expect(() => assertValidOutboxDraft(draft)).not.toThrow();
      expect(draft).toMatchObject({ aggregateType: OutboxAggregateType.AUCTION_REQUEST, audience: 'PRIVATE', aggregateId: ID(1), privateRouting: { advertiserAccountId: ID(3) } });
      expect(REALTIME_SUBSCRIBED_EVENT_TYPES).not.toContain(draft.type);
    }
    expect(approved.payload).toMatchObject({ entryFeeMinor: 0, auctionId: ID(2) });
    // The payload guard forbids any "reason" key (free text) — which is why the closed code travels as `rejectionCode`.
    expect(() => assertValidOutboxDraft({ ...rejected, payload: { ...rejected.payload, reasonCode: 'OTHER' } })).toThrow(/forbidden payload key/);
  });

  it('cancellation routes participants privately (unique ids only) with an unchanged public payload', () => {
    const draft = auctionCancelledEvent({ auctionId: ID(1), occurredAt: T, previousStatus: 'active', advertiserAccountId: ID(2), participantAccountIds: [ID(3), ID(4)] });
    expect(() => assertValidOutboxDraft(draft)).not.toThrow();
    expect(Object.keys(draft.payload).sort()).toEqual(['auctionId', 'cancelledAt', 'previousStatus', 'status']);
    expect(draft.privateRouting).toEqual({ advertiserAccountId: ID(2), participantAccountIds: [ID(3), ID(4)] });
    expect(() => assertValidOutboxDraft({ ...draft, privateRouting: { participantAccountIds: [ID(3), ID(3)] } })).toThrow(/unique/);
    expect(auctionCancelledEvent({ auctionId: ID(1), occurredAt: T, previousStatus: 'scheduled' }).privateRouting).toBeUndefined();
  });

  it('notifies the seller of approval/rejection and every participant (not the seller twice) of a cancellation, with no notes', () => {
    const approved = mapNotificationEvent(delivery(auctionRequestApprovedEvent({ requestId: ID(1), auctionId: ID(2), occurredAt: T, entryFeeMinor: 5_000, scheduledStartAt: T, scheduledEndAt: T, advertiserAccountId: ID(3) })));
    expect(approved).toEqual([expect.objectContaining({ recipientAccountId: ID(3), type: NotificationType.AUCTION_REQUEST_APPROVED, target: { type: NotificationTargetType.AUCTION_REQUEST, id: ID(1) } })]);
    const rejected = mapNotificationEvent(delivery(auctionRequestRejectedEvent({ requestId: ID(1), occurredAt: T, rejectionCode: 'OTHER', advertiserAccountId: ID(3) })));
    expect(rejected).toEqual([expect.objectContaining({ recipientAccountId: ID(3), type: NotificationType.AUCTION_REQUEST_REJECTED })]);
    const cancelled = mapNotificationEvent(delivery(auctionCancelledEvent({ auctionId: ID(1), occurredAt: T, previousStatus: 'active', advertiserAccountId: ID(2), participantAccountIds: [ID(2), ID(5), ID(6)] })));
    expect(cancelled.map((row) => row.recipientAccountId)).toEqual([ID(2), ID(5), ID(6)]);
    expect(cancelled.every((row) => row.type === NotificationType.AUCTION_CANCELLED && row.target.type === NotificationTargetType.AUCTION)).toBe(true);
    const superseded = mapNotificationEvent(delivery(auctionCancelledEvent({ auctionId: ID(1), occurredAt: T, previousStatus: 'scheduled' })));
    expect(superseded).toEqual([]);
  });
});

describe('schema, migration and authorization parity', () => {
  it('migration 036 creates exactly the indexes the schemas declare (frozen copy stays in sync)', () => {
    const declared = (schema: any) => schema.indexes().map(([key, options]: any) => ({ key, name: options.name, unique: Boolean(options.unique), partial: options.partialFilterExpression ?? null }));
    const fromMigration = (collection: string) => MAZAD035_INDEXES.filter((index) => index.collection === collection)
      .map((index) => ({ key: index.key, name: index.options.name, unique: Boolean(index.options.unique), partial: index.options.partialFilterExpression ?? null }));
    expect(declared(AuctionRequestSchema)).toEqual(fromMigration('auction_requests'));
    expect(AUCTION_REQUEST_INDEXES.map((index) => index.options.name)).toEqual(fromMigration('auction_requests').map((index) => index.name));
    for (const [schema, collection] of [[AuctionSchema, 'auctions'], [AuctionEntryPaymentSchema, 'auction_entry_payments']] as const) {
      for (const expected of fromMigration(collection)) expect(declared(schema)).toContainEqual(expected);
    }
  });

  it('review and cancellation are ADMIN capabilities (SUPER_ADMIN inherits them); marketplace and inactive staff never get them', () => {
    const principal = (overrides: Record<string, unknown>) => ({ _id: ID(1), accountStatus: AccountStatus.ACTIVE, accountType: AccountType.USER, brokerStatus: BrokerStatus.NOT_APPLIED, ...overrides });
    for (const capability of [Capability.ADMIN_AUCTION_REVIEW, Capability.ADMIN_AUCTION_CANCEL]) {
      expect(AuthorizationPolicyService.can(principal({ systemRole: SystemRole.ADMIN }), capability)).toBe(true);
      expect(AuthorizationPolicyService.can(principal({ systemRole: SystemRole.SUPER_ADMIN }), capability)).toBe(true);
      expect(AuthorizationPolicyService.can(principal({ systemRole: SystemRole.ADMIN, accountStatus: AccountStatus.SUSPENDED }), capability)).toBe(false);
      expect(AuthorizationPolicyService.can(principal({ systemRole: SystemRole.USER }), capability)).toBe(false);
    }
    expect(AuthorizationPolicyService.can(principal({ systemRole: SystemRole.ADMIN }), Capability.AUCTION_CREATE_OWN)).toBe(false);
  });
});

describe('auction request HTTP pipeline (validation codes, guards, token identity)', () => {
  const ME = ID(10);
  class TestJwtAuthGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const http = context.switchToHttp().getRequest();
      const header = http.headers.authorization;
      if (!header) throw new UnauthorizedException();
      const base = { userId: ME, accountStatus: 'ACTIVE', accountType: AccountType.USER, brokerStatus: BrokerStatus.NOT_APPLIED };
      http.user = {
        user: { ...base, systemRole: SystemRole.USER },
        admin: { ...base, systemRole: SystemRole.ADMIN },
        'super-admin': { ...base, systemRole: SystemRole.SUPER_ADMIN },
        'pending-broker': { ...base, systemRole: SystemRole.USER, accountType: AccountType.BROKER, brokerStatus: BrokerStatus.PENDING },
      }[header.replace('Bearer ', '') as 'user'];
      return true;
    }
  }
  const service = {
    submit: jest.fn(), listMine: jest.fn(), getMine: jest.fn(), update: jest.fn(), resubmit: jest.fn(), withdraw: jest.fn(), listEligibleProperties: jest.fn(),
    listForAdmin: jest.fn(), getForAdmin: jest.fn(), review: jest.fn(),
  };
  let app: NestExpressApplication;
  const server = () => request(app.getHttpServer());
  const body = { propertyId: ID(20), startingPriceMinor: 100_000, minimumBidStepMinor: 5_000, proposedStartAt: '2026-10-02T10:00:00.000Z', proposedEndAt: '2026-10-02T12:00:00.000Z' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuctionRequestsController, AdminAuctionRequestsController],
      providers: [RolesGuard, { provide: AuctionRequestsService, useValue: service }],
    }).overrideGuard(JwtAuthGuard).useClass(TestJwtAuthGuard).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, { NODE_ENV: 'test' });
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => { jest.clearAllMocks(); for (const fn of Object.values(service)) fn.mockResolvedValue({ ok: true }); });

  it('submits with the token identity and parsed UTC dates; attribution/status/fee fields are rejected', async () => {
    await server().post('/api/v1/auction-requests').set('Authorization', 'Bearer user').send(body).expect(201);
    expect(service.submit).toHaveBeenCalledWith(ME, { ...body, proposedStartAt: new Date(body.proposedStartAt), proposedEndAt: new Date(body.proposedEndAt) }, expect.anything());
    for (const extra of [{ advertiserAccountId: ID(11) }, { status: 'approved' }, { entryFeeMinor: 0 }, { propertyRevisionId: ID(12) }]) {
      const res = await server().post('/api/v1/auction-requests').set('Authorization', 'Bearer user').send({ ...body, ...extra }).expect(400);
      expect(res.body.code).toBe(AuctionErrorCode.REQUEST_INVALID);
    }
    expect(service.submit).toHaveBeenCalledTimes(1);
  });

  it('blocks staff and unapproved brokers from seller commands before any service runs; lets brokers read their own', async () => {
    for (const role of ['admin', 'super-admin']) {
      const res = await server().post('/api/v1/auction-requests').set('Authorization', `Bearer ${role}`).send(body).expect(403);
      expect(res.body.code).toBe('ADMIN_MARKETPLACE_FORBIDDEN');
      await server().get('/api/v1/auction-requests/mine').set('Authorization', `Bearer ${role}`).expect(403);
    }
    await server().post('/api/v1/auction-requests').set('Authorization', 'Bearer pending-broker').send(body).expect(403);
    await server().post(`/api/v1/auction-requests/mine/${ID(30)}/withdraw`).set('Authorization', 'Bearer pending-broker').send({ expectedRevision: 1 }).expect(403);
    await server().get('/api/v1/auction-requests/mine').set('Authorization', 'Bearer pending-broker').expect(200);
    await server().get('/api/v1/auction-requests/mine').expect(401);
    expect(service.submit).not.toHaveBeenCalled();
    expect(service.withdraw).not.toHaveBeenCalled();
  });

  it('requires expectedRevision on every seller write and validates ids', async () => {
    expect((await server().patch(`/api/v1/auction-requests/mine/${ID(30)}`).set('Authorization', 'Bearer user').send({ ...body, propertyId: undefined }).expect(400)).body.code).toBe(AuctionErrorCode.REQUEST_INVALID);
    expect((await server().post(`/api/v1/auction-requests/mine/${ID(30)}/resubmit`).set('Authorization', 'Bearer user').send({}).expect(400)).body.code).toBe(AuctionErrorCode.REQUEST_INVALID);
    expect((await server().get('/api/v1/auction-requests/mine/nope').set('Authorization', 'Bearer user').expect(400)).body.code).toBe(AuctionErrorCode.REQUEST_ID_INVALID);
    const { propertyId: _unused, ...terms } = body;
    await server().patch(`/api/v1/auction-requests/mine/${ID(30)}`).set('Authorization', 'Bearer user').send({ ...terms, expectedRevision: 2 }).expect(200);
    expect(service.update).toHaveBeenCalledWith(ME, ID(30), expect.objectContaining({ expectedRevision: 2, proposedStartAt: new Date(body.proposedStartAt) }), expect.anything());
    await server().post(`/api/v1/auction-requests/mine/${ID(30)}/withdraw`).set('Authorization', 'Bearer user').send({ expectedRevision: 3 }).expect(201);
    expect(service.withdraw).toHaveBeenCalledWith(ME, ID(30), { expectedRevision: 3 }, expect.anything());
  });

  it('Admin queue/detail need ADMIN_AUCTION_READ; review needs ADMIN_AUCTION_REVIEW and accepts no schedule fields', async () => {
    await server().get('/api/v1/admin/auction-requests?status=all').set('Authorization', 'Bearer admin').expect(200);
    await server().get(`/api/v1/admin/auction-requests/${ID(31)}`).set('Authorization', 'Bearer super-admin').expect(200);
    await server().get('/api/v1/admin/auction-requests').set('Authorization', 'Bearer user').expect(403);
    await server().post(`/api/v1/admin/auction-requests/${ID(31)}/review`).set('Authorization', 'Bearer user').send({ decision: 'approve', expectedRevision: 1, entryFeeMinor: 0 }).expect(403);
    const schedule = await server().post(`/api/v1/admin/auction-requests/${ID(31)}/review`).set('Authorization', 'Bearer admin').send({ decision: 'approve', expectedRevision: 1, entryFeeMinor: 0, proposedStartAt: '2026-10-03T10:00:00.000Z' }).expect(400);
    expect(schedule.body.code).toBe(AuctionErrorCode.REQUEST_INVALID);
    expect((await server().get('/api/v1/admin/auction-requests?status=draft').set('Authorization', 'Bearer admin').expect(400)).body.code).toBe(AuctionErrorCode.QUERY_INVALID);
    await server().post(`/api/v1/admin/auction-requests/${ID(31)}/review`).set('Authorization', 'Bearer admin').send({ decision: 'approve', expectedRevision: 1, entryFeeMinor: 0 }).expect(201);
    expect(service.review).toHaveBeenCalledWith(ME, ID(31), expect.objectContaining({ decision: 'approve', expectedRevision: 1, entryFeeMinor: 0 }), expect.anything());
    expect(service.listForAdmin).toHaveBeenCalledWith(expect.objectContaining({ status: 'all' }));
  });
});
