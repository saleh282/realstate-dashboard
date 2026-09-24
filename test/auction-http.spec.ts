import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { SystemRole } from '../src/auth/roles.enum';
import { AdminAuctionsController } from '../src/auctions/admin-auctions.controller';
import { AuctionLifecycleService } from '../src/auctions/auction-lifecycle.service';
import { AuctionsController } from '../src/auctions/auctions.controller';
import { AuctionsQueryService } from '../src/auctions/auctions-query.service';
import { AuctionsService } from '../src/auctions/auctions.service';
import { RolesGuard } from '../src/auth/roles.guard';
import { AuctionErrorCode } from '../src/common/errors/auction-error-codes';
import { AccountType, BrokerStatus } from '../src/users/identity.types';

/**
 * MAZAD-025 — real HTTP pipeline (global pipes/filters/interceptors from
 * `configureApp`, real guards, real route matching) with the three auction
 * services mocked. Proves the wiring the unit tests cannot: the coded
 * validation errors survive the global pipe, capability guards run before any
 * service, admins are rejected from marketplace routes, public routes need no
 * token, and the error envelope carries the stable code.
 */
const ME = '64b000000000000000000a01';
const AUCTION_ID = '64b000000000000000000c01';
const PROPERTY_ID = '64b000000000000000000b01';

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp().getRequest();
    const header = http.headers.authorization;
    if (!header) throw new UnauthorizedException();
    const base = { userId: ME, accountStatus: 'active', accountType: AccountType.USER, brokerStatus: BrokerStatus.NOT_APPLIED };
    http.user = {
      user: { ...base, systemRole: SystemRole.USER },
      admin: { ...base, systemRole: SystemRole.ADMIN },
      'super-admin': { ...base, systemRole: SystemRole.SUPER_ADMIN },
      'pending-broker': { ...base, systemRole: SystemRole.USER, accountType: AccountType.BROKER, brokerStatus: BrokerStatus.PENDING },
    }[header.replace('Bearer ', '') as 'user'];
    return true;
  }
}

describe('auction HTTP contract (MAZAD-025)', () => {
  let app: INestApplication;
  const auctions = { create: jest.fn() };
  const lifecycle = { cancel: jest.fn() };
  const queries = {
    listMine: jest.fn(), getMine: jest.fn(), listPublic: jest.fn(), getPublic: jest.fn(), listForAdmin: jest.fn(), getForAdmin: jest.fn(),
  };
  const body = {
    propertyId: PROPERTY_ID, startingPriceMinor: 100_000, minimumBidStepMinor: 5_000,
    scheduledStartAt: '2026-03-02T10:00:00.000Z', scheduledEndAt: '2026-03-09T10:00:00.000Z',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuctionsController, AdminAuctionsController],
      providers: [
        RolesGuard,
        { provide: AuctionsService, useValue: auctions },
        { provide: AuctionLifecycleService, useValue: lifecycle },
        { provide: AuctionsQueryService, useValue: queries },
      ],
    }).overrideGuard(JwtAuthGuard).useClass(TestJwtAuthGuard).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' });
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    auctions.create.mockResolvedValue({ message: 'ok', auction: { id: AUCTION_ID } });
    lifecycle.cancel.mockResolvedValue({ message: 'ok', auction: { id: AUCTION_ID } });
    for (const fn of Object.values(queries)) fn.mockResolvedValue({ items: [] });
  });

  const server = () => request(app.getHttpServer());
  const codeOf = (res: request.Response) => res.body?.code ?? res.body?.data?.code ?? res.body?.error?.code;

  describe('public routes', () => {
    it('GET /auctions and /auctions/:id need no token', async () => {
      await server().get('/api/v1/auctions').expect(200);
      await server().get(`/api/v1/auctions/${AUCTION_ID}`).expect(200);
      expect(queries.getPublic).toHaveBeenCalledWith(AUCTION_ID);
    });

    it('does not shadow `mine`: an unauthenticated GET /auctions/mine is 401, not treated as an auction id', async () => {
      await server().get('/api/v1/auctions/mine').expect(401);
      expect(queries.getPublic).not.toHaveBeenCalled();
    });

    it('returns AUCTION_ID_INVALID (400) for a malformed id', async () => {
      const res = await server().get('/api/v1/auctions/not-an-id').expect(400);
      expect(codeOf(res)).toBe(AuctionErrorCode.ID_INVALID);
    });

    it('returns AUCTION_QUERY_INVALID (400) for out-of-bounds pagination and non-public status', async () => {
      for (const qs of ['limit=51', 'page=0', 'status=cancelled', 'sort=random', 'advertiserAccountId=x']) {
        const res = await server().get(`/api/v1/auctions?${qs}`).expect(400);
        expect(codeOf(res)).toBe(AuctionErrorCode.QUERY_INVALID);
      }
      expect(queries.listPublic).not.toHaveBeenCalled();
    });

    it('passes validated, coerced filters through to the query service', async () => {
      await server().get('/api/v1/auctions?page=2&limit=10&status=active&sort=ending_soon').expect(200);
      expect(queries.listPublic).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 10, status: 'active', sort: 'ending_soon' }));
    });
  });

  describe('marketplace routes', () => {
    it('require authentication', async () => {
      await server().post('/api/v1/auctions').send(body).expect(401);
      await server().get('/api/v1/auctions/mine').expect(401);
      await server().post(`/api/v1/auctions/mine/${AUCTION_ID}/cancel`).send({}).expect(401);
    });

    it('lets an eligible USER create, using the token identity', async () => {
      await server().post('/api/v1/auctions').set('Authorization', 'Bearer user').send(body).expect(201);
      expect(auctions.create).toHaveBeenCalledWith(ME, expect.objectContaining({ propertyId: PROPERTY_ID }), expect.anything());
    });

    it.each(['admin', 'super-admin'])('rejects %s from create/read/cancel before any service runs', async (role) => {
      const create = await server().post('/api/v1/auctions').set('Authorization', `Bearer ${role}`).send(body).expect(403);
      expect(codeOf(create)).toBe('ADMIN_MARKETPLACE_FORBIDDEN');
      await server().get('/api/v1/auctions/mine').set('Authorization', `Bearer ${role}`).expect(403);
      await server().get(`/api/v1/auctions/mine/${AUCTION_ID}`).set('Authorization', `Bearer ${role}`).expect(403);
      await server().post(`/api/v1/auctions/mine/${AUCTION_ID}/cancel`).set('Authorization', `Bearer ${role}`).send({}).expect(403);
      expect(auctions.create).not.toHaveBeenCalled();
      expect(lifecycle.cancel).not.toHaveBeenCalled();
      expect(queries.listMine).not.toHaveBeenCalled();
    });

    it('rejects an unapproved broker from create/cancel (403) but lets them read their own', async () => {
      await server().post('/api/v1/auctions').set('Authorization', 'Bearer pending-broker').send(body).expect(403);
      await server().post(`/api/v1/auctions/mine/${AUCTION_ID}/cancel`).set('Authorization', 'Bearer pending-broker').send({}).expect(403);
      await server().get('/api/v1/auctions/mine').set('Authorization', 'Bearer pending-broker').expect(200);
      expect(auctions.create).not.toHaveBeenCalled();
    });

    it('rejects client-supplied attribution/state on create with AUCTION_REQUEST_INVALID', async () => {
      for (const extra of [{ advertiserAccountId: '64b000000000000000000a02' }, { status: 'active' }, { propertyRevisionId: AUCTION_ID }]) {
        const res = await server().post('/api/v1/auctions').set('Authorization', 'Bearer user').send({ ...body, ...extra }).expect(400);
        expect(codeOf(res)).toBe(AuctionErrorCode.REQUEST_INVALID);
      }
      expect(auctions.create).not.toHaveBeenCalled();
    });

    it('cancels via the lifecycle service with reason and optimistic expectedStatus', async () => {
      await server().post(`/api/v1/auctions/mine/${AUCTION_ID}/cancel`).set('Authorization', 'Bearer user')
        .send({ reason: 'تغيرت الظروف', expectedStatus: 'active' }).expect(201);
      expect(lifecycle.cancel).toHaveBeenCalledWith(ME, AUCTION_ID, 'تغيرت الظروف', expect.anything(), 'active');
    });

    it('rejects a malformed cancel id / body without touching the lifecycle service', async () => {
      const badId = await server().post('/api/v1/auctions/mine/xyz/cancel').set('Authorization', 'Bearer user').send({}).expect(400);
      expect(codeOf(badId)).toBe(AuctionErrorCode.ID_INVALID);
      const badBody = await server().post(`/api/v1/auctions/mine/${AUCTION_ID}/cancel`).set('Authorization', 'Bearer user').send({ expectedStatus: 'nope' }).expect(400);
      expect(codeOf(badBody)).toBe(AuctionErrorCode.REQUEST_INVALID);
      expect(lifecycle.cancel).not.toHaveBeenCalled();
    });

    it('surfaces stable domain errors from the lifecycle service in the envelope', async () => {
      const { ConflictException } = await import('@nestjs/common');
      lifecycle.cancel.mockRejectedValue(new ConflictException({ message: 'x', code: AuctionErrorCode.STATE_CONFLICT }));
      const res = await server().post(`/api/v1/auctions/mine/${AUCTION_ID}/cancel`).set('Authorization', 'Bearer user').send({}).expect(409);
      expect(codeOf(res)).toBe(AuctionErrorCode.STATE_CONFLICT);
    });

    it('exposes no bid, payment, winner or edit routes', async () => {
      for (const [method, path] of [['post', 'bids'], ['post', 'pay'], ['post', 'winner'], ['patch', '']] as const) {
        const res = await (server() as any)[method](`/api/v1/auctions/${AUCTION_ID}/${path}`).set('Authorization', 'Bearer user').send({});
        expect(res.status).toBe(404);
      }
      await server().patch(`/api/v1/auctions/mine/${AUCTION_ID}`).set('Authorization', 'Bearer user').send({}).expect(404);
      await server().delete(`/api/v1/auctions/mine/${AUCTION_ID}`).set('Authorization', 'Bearer user').expect(404);
    });
  });

  describe('admin routes', () => {
    it('allow ADMIN and SUPER_ADMIN to read', async () => {
      await server().get('/api/v1/admin/auctions?status=cancelled').set('Authorization', 'Bearer admin').expect(200);
      await server().get(`/api/v1/admin/auctions/${AUCTION_ID}`).set('Authorization', 'Bearer super-admin').expect(200);
      expect(queries.listForAdmin).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
      expect(queries.getForAdmin).toHaveBeenCalledWith(AUCTION_ID);
    });

    it('reject marketplace users and anonymous callers', async () => {
      await server().get('/api/v1/admin/auctions').expect(401);
      await server().get('/api/v1/admin/auctions').set('Authorization', 'Bearer user').expect(403);
      expect(queries.listForAdmin).not.toHaveBeenCalled();
    });

    it('expose no mutation routes', async () => {
      for (const method of ['post', 'patch', 'put', 'delete'] as const) {
        const res = await (server() as any)[method](`/api/v1/admin/auctions/${AUCTION_ID}`).set('Authorization', 'Bearer admin').send({});
        expect(res.status).toBe(404);
      }
      await server().post('/api/v1/admin/auctions').set('Authorization', 'Bearer admin').send(body).expect(404);
    });

    it('validates admin query filters', async () => {
      const res = await server().get('/api/v1/admin/auctions?propertyId=bad').set('Authorization', 'Bearer admin').expect(400);
      expect(codeOf(res)).toBe(AuctionErrorCode.QUERY_INVALID);
    });
  });
});
