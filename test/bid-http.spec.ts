import { CanActivate, ConflictException, ExecutionContext, ForbiddenException, INestApplication, UnauthorizedException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { AuctionBidAcceptanceService } from '../src/auctions/auction-bid-acceptance.service';
import { AuctionBiddingReadService } from '../src/auctions/auction-bidding-read.service';
import { AuctionBidsController } from '../src/auctions/auction-bids.controller';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../src/auth/optional-jwt-auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { SystemRole } from '../src/auth/roles.enum';
import { AuctionErrorCode } from '../src/common/errors/auction-error-codes';
import { BidErrorCode } from '../src/common/errors/bid-error-codes';
import { ClockService } from '../src/common/time/clock.service';
import { AccountType, BrokerStatus } from '../src/users/identity.types';

/**
 * MAZAD-029 — the bid HTTP contract through the real pipeline (global
 * pipes/filters/interceptors, real CapabilityGuard, real route matching) with
 * the acceptance/read services mocked. Acceptance rules themselves are proven
 * in bid-acceptance.spec.ts; here: auth, validation, identity, envelope.
 */
const ME = '64b000000000000000000a01';
const AUCTION_ID = '64b000000000000000000c01';
const KEY = 'client-key-0001';
const NOW = new Date('2026-05-02T10:00:00Z');

const identityFor = (token: string) => {
  const base = { userId: ME, accountStatus: 'active', accountType: AccountType.USER, brokerStatus: BrokerStatus.NOT_APPLIED };
  return ({
    user: { ...base, systemRole: SystemRole.USER },
    admin: { ...base, systemRole: SystemRole.ADMIN },
    'super-admin': { ...base, systemRole: SystemRole.SUPER_ADMIN },
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
/** Mirrors OptionalJwtAuthGuard's contract: no header → guest; bad token → 401. */
class TestOptionalJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp().getRequest();
    if (!http.headers.authorization) return true;
    const user = identityFor(http.headers.authorization.replace('Bearer ', ''));
    if (!user) throw new UnauthorizedException();
    http.user = user;
    return true;
  }
}

describe('bid HTTP contract (MAZAD-029)', () => {
  let app: INestApplication;
  const acceptance = { acceptBid: jest.fn() };
  const reads = { getPublicBidState: jest.fn(), getPublicBidHistory: jest.fn() };
  const accepted = (overrides: Record<string, unknown> = {}) => ({
    bid: { id: 'bid-1', auctionId: AUCTION_ID, bidderAccountId: ME, bidderAccountTypeSnapshot: 'user', sequence: 3, amountMinor: 110_000, currency: 'EGP', acceptedAt: NOW },
    auction: { id: AUCTION_ID, status: 'active', currentEndAt: new Date('2026-05-08T10:05:00Z'), previousEndAt: new Date('2026-05-08T10:00:00Z'), extended: true, acceptedBidCount: 3 },
    nextMinimumBidMinor: 115_000,
    replayed: false,
    ...overrides,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuctionBidsController],
      providers: [
        RolesGuard,
        { provide: AuctionBidAcceptanceService, useValue: acceptance },
        { provide: AuctionBiddingReadService, useValue: reads },
        { provide: ClockService, useValue: { now: () => NOW } },
      ],
    })
      .overrideGuard(JwtAuthGuard).useClass(TestJwtAuthGuard)
      .overrideGuard(OptionalJwtAuthGuard).useClass(TestOptionalJwtGuard)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' });
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    acceptance.acceptBid.mockResolvedValue(accepted());
    reads.getPublicBidState.mockResolvedValue({ bidding: {}, serverTime: NOW });
    reads.getPublicBidHistory.mockResolvedValue({ items: [], pagination: {}, serverTime: NOW });
  });

  const server = () => request(app.getHttpServer());
  const codeOf = (res: request.Response) => res.body?.code ?? res.body?.data?.code ?? res.body?.error?.code;
  const place = (token = 'user', body: unknown = { amountMinor: 110_000 }, key: string | null = KEY) => {
    let r = server().post(`/api/v1/auctions/${AUCTION_ID}/bids`).set('Authorization', `Bearer ${token}`);
    if (key !== null) r = r.set('Idempotency-Key', key);
    return r.send(body as any);
  };

  describe('POST /auctions/:auctionId/bids', () => {
    it('places a bid as the authenticated actor, passing only the amount and the key', async () => {
      const res = await place().expect(201);
      expect(acceptance.acceptBid).toHaveBeenCalledWith(ME, AUCTION_ID, 110_000, expect.anything(), { key: KEY });
      expect(res.body.data ?? res.body).toBeDefined();
    });

    it('returns the stable client projection: no bidder id, no Mongo internals, no bid id', async () => {
      const res = await place().expect(201);
      const data = res.body.data;
      expect(data.bid).toEqual({ auctionId: AUCTION_ID, sequence: 3, amountMinor: 110_000, currency: 'EGP', acceptedAt: NOW.toISOString() });
      expect(data.auction).toEqual({ currentEndAt: '2026-05-08T10:05:00.000Z', previousEndAt: '2026-05-08T10:00:00.000Z', extended: true, acceptedBidCount: 3 });
      expect(data).toMatchObject({ nextMinimumBidMinor: 115_000, replayed: false, serverTime: NOW.toISOString() });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(ME);
      expect(text).not.toMatch(/bidderAccount|_id|"id"|bid-1/);
    });

    it('marks a replay', async () => {
      acceptance.acceptBid.mockResolvedValue(accepted({ replayed: true }));
      const res = await place().expect(201);
      expect(res.body.data.replayed).toBe(true);
    });

    it('rejects guests (401) before any service runs', async () => {
      await server().post(`/api/v1/auctions/${AUCTION_ID}/bids`).set('Idempotency-Key', KEY).send({ amountMinor: 1 }).expect(401);
      expect(acceptance.acceptBid).not.toHaveBeenCalled();
    });

    it.each(['admin', 'super-admin'])('rejects %s (403 ADMIN_MARKETPLACE_FORBIDDEN) before any service runs', async (role) => {
      const res = await place(role).expect(403);
      expect(codeOf(res)).toBe('ADMIN_MARKETPLACE_FORBIDDEN');
      expect(acceptance.acceptBid).not.toHaveBeenCalled();
    });

    it('rejects a not-yet-approved broker via BID_PLACE before any service runs', async () => {
      await place('pending-broker').expect(403);
      expect(acceptance.acceptBid).not.toHaveBeenCalled();
    });

    it.each([
      ['bidderAccountId', { amountMinor: 1, bidderAccountId: 'x' }],
      ['acceptedAt', { amountMinor: 1, acceptedAt: '2020-01-01T00:00:00Z' }],
      ['sequence', { amountMinor: 1, sequence: 1 }],
      ['currentEndAt', { amountMinor: 1, currentEndAt: '2020-01-01T00:00:00Z' }],
      ['minimumBidMinor', { amountMinor: 1, minimumBidMinor: 1 }],
      ['paid', { amountMinor: 1, paid: true }],
      ['idempotencyKey in the body', { amountMinor: 1, idempotencyKey: KEY }],
    ])('rejects a client-supplied %s as AUCTION_REQUEST_INVALID', async (_n, body) => {
      const res = await place('user', body).expect(400);
      expect(codeOf(res)).toBe(AuctionErrorCode.REQUEST_INVALID);
      expect(acceptance.acceptBid).not.toHaveBeenCalled();
    });

    it('rejects an empty body and a missing amount', async () => {
      const res = await place('user', {}).expect(400);
      expect(codeOf(res)).toBe(AuctionErrorCode.REQUEST_INVALID);
    });

    it('requires an Idempotency-Key (400 BID_IDEMPOTENCY_KEY_REQUIRED)', async () => {
      const res = await place('user', { amountMinor: 1 }, null).expect(400);
      expect(codeOf(res)).toBe(BidErrorCode.IDEMPOTENCY_KEY_REQUIRED);
      expect(acceptance.acceptBid).not.toHaveBeenCalled();
    });

    it.each(['short', 'has spaces in it!', 'x'.repeat(129)])('rejects a malformed Idempotency-Key %p', async (key) => {
      const res = await place('user', { amountMinor: 1 }, key).expect(400);
      expect(codeOf(res)).toBe('IDEMPOTENCY_KEY_INVALID');
      expect(acceptance.acceptBid).not.toHaveBeenCalled();
    });

    it('rejects a malformed auction id with AUCTION_ID_INVALID', async () => {
      const res = await server().post('/api/v1/auctions/nope/bids').set('Authorization', 'Bearer user').set('Idempotency-Key', KEY).send({ amountMinor: 1 }).expect(400);
      expect(codeOf(res)).toBe(AuctionErrorCode.ID_INVALID);
    });

    it('passes a non-integer amount through so the acceptance service returns its stable BID_AMOUNT_INVALID', async () => {
      acceptance.acceptBid.mockRejectedValue(new (require('@nestjs/common').BadRequestException)({ message: 'x', code: BidErrorCode.AMOUNT_INVALID }));
      const res = await place('user', { amountMinor: '100.5' }).expect(400);
      expect(codeOf(res)).toBe(BidErrorCode.AMOUNT_INVALID);
      expect(acceptance.acceptBid).toHaveBeenCalledWith(ME, AUCTION_ID, '100.5', expect.anything(), { key: KEY });
    });

    it.each([
      [new ForbiddenException({ message: 'x', code: BidErrorCode.ENTITLEMENT_REQUIRED }), 403, BidErrorCode.ENTITLEMENT_REQUIRED],
      [new ForbiddenException({ message: 'x', code: 'SELF_BID_FORBIDDEN' }), 403, 'SELF_BID_FORBIDDEN'],
      [new ConflictException({ message: 'x', code: BidErrorCode.AUCTION_ENDED }), 409, BidErrorCode.AUCTION_ENDED],
      [new ConflictException({ message: 'x', code: BidErrorCode.AUCTION_NOT_ACTIVE }), 409, BidErrorCode.AUCTION_NOT_ACTIVE],
      [new ConflictException({ message: 'x', code: 'IDEMPOTENCY_KEY_REUSED' }), 409, 'IDEMPOTENCY_KEY_REUSED'],
    ])('maps domain error %#', async (error, status, code) => {
      acceptance.acceptBid.mockRejectedValue(error);
      const res = await place().expect(status as number);
      expect(codeOf(res)).toBe(code);
    });

    it('exposes BID_RETRY_EXHAUSTED as a retryable 409 with retryAfterSeconds', async () => {
      acceptance.acceptBid.mockRejectedValue(new ConflictException({ message: 'x', code: BidErrorCode.RETRY_EXHAUSTED, retryAfterSeconds: 1, details: { retryable: true } }));
      const res = await place().expect(409);
      expect(codeOf(res)).toBe(BidErrorCode.RETRY_EXHAUSTED);
      expect(JSON.stringify(res.body)).toContain('retryAfterSeconds');
      expect(JSON.stringify(res.body)).toContain('"retryable":true');
    });

    it('never leaks a raw database error', async () => {
      acceptance.acceptBid.mockRejectedValue(Object.assign(new Error('E11000 duplicate key collection: bids index: bid_auction_sequence'), { code: 11000 }));
      const res = await place().expect(500);
      expect(JSON.stringify(res.body)).not.toMatch(/E11000|bid_auction_sequence|collection/);
    });
  });

  describe('GET /auctions/:auctionId/bid-state and /bids (public)', () => {
    it('need no token', async () => {
      await server().get(`/api/v1/auctions/${AUCTION_ID}/bid-state`).expect(200);
      await server().get(`/api/v1/auctions/${AUCTION_ID}/bids`).expect(200);
      expect(reads.getPublicBidState).toHaveBeenCalledWith(AUCTION_ID);
    });

    it('history gives the read service NO viewer for a guest and the token identity for a signed-in user', async () => {
      await server().get(`/api/v1/auctions/${AUCTION_ID}/bids`).expect(200);
      expect(reads.getPublicBidHistory).toHaveBeenLastCalledWith(AUCTION_ID, expect.any(Object), undefined);
      await server().get(`/api/v1/auctions/${AUCTION_ID}/bids`).set('Authorization', 'Bearer user').expect(200);
      expect(reads.getPublicBidHistory).toHaveBeenLastCalledWith(AUCTION_ID, expect.any(Object), ME);
    });

    it('an invalid token on history is a 401, not a silent guest', async () => {
      await server().get(`/api/v1/auctions/${AUCTION_ID}/bids`).set('Authorization', 'Bearer stale').expect(401);
      expect(reads.getPublicBidHistory).not.toHaveBeenCalled();
    });

    it('validates and bounds pagination', async () => {
      for (const qs of ['limit=101', 'limit=0', 'afterSequence=-1', 'afterSequence=x', 'page=2', 'bidderAccountId=x']) {
        const res = await server().get(`/api/v1/auctions/${AUCTION_ID}/bids?${qs}`).expect(400);
        expect(codeOf(res)).toBe(AuctionErrorCode.QUERY_INVALID);
      }
      await server().get(`/api/v1/auctions/${AUCTION_ID}/bids?limit=100&afterSequence=7`).expect(200);
      expect(reads.getPublicBidHistory).toHaveBeenLastCalledWith(AUCTION_ID, expect.objectContaining({ limit: 100, afterSequence: 7 }), undefined);
    });

    it('rejects a malformed auction id', async () => {
      const res = await server().get('/api/v1/auctions/nope/bids').expect(400);
      expect(codeOf(res)).toBe(AuctionErrorCode.ID_INVALID);
    });
  });

  it('exposes exactly these routes on the controller — no payment, winner, close or realtime surface', () => {
    const names = Object.getOwnPropertyNames(AuctionBidsController.prototype).filter((n) => n !== 'constructor' && !n.startsWith('require'));
    expect(names.sort()).toEqual(['bidState', 'history', 'place']);
  });
});
