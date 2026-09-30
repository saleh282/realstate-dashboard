import { operationalMetrics } from '../src/common/observability/operational-metrics';
import { Logger } from '@nestjs/common';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { CAPABILITIES_KEY } from '../src/authorization/capabilities.decorator';
import { AuthorizationErrorCode } from '../src/authorization/authorization-error-codes';
import { AuthorizationPolicyService } from '../src/authorization/authorization-policy.service';
import { Capability } from '../src/authorization/capability';
import { SystemRole } from '../src/auth/roles.enum';
import { ROLES_KEY } from '../src/auth/roles.decorator';
import { AuctionErrorCode } from '../src/common/errors/auction-error-codes';
import { AccountStatus, AccountType, BrokerStatus } from '../src/users/identity.types';
import { AdminAuctionsController } from '../src/auctions/admin-auctions.controller';
import { toAdminAuction, toOwnAuction, toPublicAuction } from '../src/auctions/auction-projections';
import { AuctionStatus, DEFAULT_PUBLIC_LIST_STATUSES, PUBLIC_AUCTION_STATUSES } from '../src/auctions/auction.types';
import { AuctionsController } from '../src/auctions/auctions.controller';
import { AuctionsQueryService } from '../src/auctions/auctions-query.service';
import { auctionValidation } from '../src/auctions/dto/auction-validation.pipe';
import { CancelAuctionDto } from '../src/auctions/dto/cancel-auction.dto';
import { CreateAuctionDto } from '../src/auctions/dto/create-auction.dto';
import { ListAdminAuctionsDto, ListOwnAuctionsDto, ListPublicAuctionsDto } from '../src/auctions/dto/list-auctions.dto';
import { ParseAuctionIdPipe } from '../src/auctions/dto/parse-auction-id.pipe';
import { PropertiesService } from '../src/properties/properties.service';

/**
 * MAZAD-025 — auction HTTP contract: routes/policies, request validation,
 * public/own/admin projections, listing/pagination, ownership isolation and
 * delegation to the (unchanged) MAZAD-023/024 mutation services. Mutation
 * semantics themselves (transitions, audit, races) are covered in
 * auctions.spec.ts / auction-lifecycle.spec.ts.
 */

const ME = '64b000000000000000000a01';
const OTHER = '64b000000000000000000a02';
const PROPERTY_ID = '64b000000000000000000b01';
const REVISION_ID = '64b000000000000000000b02';
const AUCTION_ID = '64b000000000000000000c01';
const AUCTION_2 = '64b000000000000000000c02';
const NOW = new Date('2026-03-01T12:00:00Z');

const oid = (hex: string) => new Types.ObjectId(hex);

function identity(overrides: Record<string, unknown> = {}) {
  return {
    _id: ME,
    systemRole: SystemRole.USER,
    accountType: AccountType.USER,
    accountStatus: AccountStatus.ACTIVE,
    brokerStatus: BrokerStatus.NOT_APPLIED,
    ...overrides,
  };
}

/** A raw Mongo auction document deliberately stuffed with every internal field a projection must NOT leak. */
function rawAuction(overrides: Record<string, unknown> = {}) {
  return {
    _id: oid(AUCTION_ID),
    propertyId: oid(PROPERTY_ID),
    propertyRevisionId: oid(REVISION_ID),
    advertiserAccountId: oid(ME),
    advertiserAccountTypeSnapshot: AccountType.USER,
    createdByActorId: oid(ME),
    cancelledByActorId: oid(ME),
    winnerAccountId: oid(OTHER),
    winningBidAmountMinor: 999,
    completedAt: new Date('2026-03-09T00:00:00Z'),
    startingPriceMinor: 100_000,
    minimumBidStepMinor: 5_000,
    currency: 'EGP',
    scheduledStartAt: new Date('2026-03-02T10:00:00Z'),
    scheduledEndAt: new Date('2026-03-09T10:00:00Z'),
    currentEndAt: new Date('2026-03-09T10:00:00Z'),
    status: AuctionStatus.SCHEDULED,
    version: 4,
    createdAt: new Date('2026-03-01T00:00:00Z'),
    updatedAt: new Date('2026-03-01T01:00:00Z'),
    ruleSnapshot: {
      version: 1,
      startingPriceMinor: 100_000,
      minimumBidStepMinor: 5_000,
      currency: 'EGP',
      scheduledStartAt: new Date('2026-03-02T10:00:00Z'),
      scheduledEndAt: new Date('2026-03-09T10:00:00Z'),
      hasReservePrice: false,
      advertiserSelfBidForbidden: true,
      adminBiddingForbidden: true,
      bidsAreImmutable: true,
      serverTimeAuthoritative: true,
      automaticWinnerDetermination: true,
      secondPlacePromotionOnCancellation: false,
      antiSnipingWindowSeconds: 300,
      antiSnipingExtensionSeconds: 300,
    },
    ...overrides,
  };
}

const PUBLIC_PROPERTY = { id: PROPERTY_ID, title: 'شقة', totalPriceMinor: 5_000_000 };

async function codeOf(action: () => unknown | Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return ((error as any).getResponse?.() as { code?: string } | undefined)?.code;
  }
}

describe('MAZAD-025 route policy contract', () => {
  const caps = (proto: object, method: string) => Reflect.getMetadata(CAPABILITIES_KEY, (proto as any)[method]);
  const guards = (proto: object, method: string) => Reflect.getMetadata('__guards__', (proto as any)[method]);
  const path = (proto: object, method: string) => Reflect.getMetadata('path', (proto as any)[method]);

  it('declares the exact marketplace routes and capabilities', () => {
    const p = AuctionsController.prototype;
    expect(Reflect.getMetadata('path', AuctionsController)).toBe('auctions');
    expect([path(p, 'create'), path(p, 'listMine'), path(p, 'getMine'), path(p, 'cancel'), path(p, 'listPublic'), path(p, 'getPublic')])
      .toEqual(['/', 'mine', 'mine/:auctionId', 'mine/:auctionId/cancel', '/', ':auctionId']);
    expect(caps(p, 'create')).toEqual([Capability.AUCTION_CREATE_OWN]);
    expect(caps(p, 'listMine')).toEqual([Capability.AUCTION_READ_OWN]);
    expect(caps(p, 'getMine')).toEqual([Capability.AUCTION_READ_OWN]);
    expect(caps(p, 'cancel')).toEqual([Capability.AUCTION_MANAGE_OWN]);
  });

  it('keeps public discovery unauthenticated and every private route behind JWT + capability guards', () => {
    const p = AuctionsController.prototype;
    expect(guards(p, 'listPublic')).toBeUndefined();
    expect(guards(p, 'getPublic')).toBeUndefined();
    for (const method of ['create', 'listMine', 'getMine', 'cancel']) {
      expect(guards(p, method)).toHaveLength(2);
    }
  });

  it('declares `mine` routes before the public `:auctionId` catch-all so they are never shadowed', () => {
    const order = Object.getOwnPropertyNames(AuctionsController.prototype).filter((name) => name !== 'constructor');
    expect(order.indexOf('getMine')).toBeLessThan(order.indexOf('getPublic'));
    expect(order.indexOf('listMine')).toBeLessThan(order.indexOf('getPublic'));
  });

  it('puts the staff read API behind ADMIN role + ADMIN_AUCTION_READ and exposes no mutation route', () => {
    expect(Reflect.getMetadata('path', AdminAuctionsController)).toBe('admin/auctions');
    expect(Reflect.getMetadata(CAPABILITIES_KEY, AdminAuctionsController)).toEqual([Capability.ADMIN_AUCTION_READ]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminAuctionsController)).toEqual([SystemRole.ADMIN]);
    expect(Reflect.getMetadata('__guards__', AdminAuctionsController)).toHaveLength(3);
    // MAZAD-035: + the read-only staff ledger and Admin cancellation (its own narrower capability); nothing else mutates.
    expect(Object.getOwnPropertyNames(AdminAuctionsController.prototype).filter((n) => n !== 'constructor').sort()).toEqual(['cancel', 'get', 'ledger', 'list']);
    expect(Reflect.getMetadata(CAPABILITIES_KEY, (AdminAuctionsController.prototype as any).cancel)).toEqual([Capability.ADMIN_AUCTION_CANCEL]);
    expect(Reflect.getMetadata(CAPABILITIES_KEY, (AdminAuctionsController.prototype as any).ledger)).toBeUndefined();
  });
});

describe('MAZAD-025 authorization capabilities', () => {
  const eligible: Array<[string, Record<string, unknown>]> = [
    ['USER', { accountType: AccountType.USER }],
    ['approved BROKER', { accountType: AccountType.BROKER, brokerStatus: BrokerStatus.APPROVED }],
    ['COMPANY', { accountType: AccountType.COMPANY }],
  ];

  it.each(eligible)('lets an active %s create, read and manage own auctions', (_label, overrides) => {
    for (const capability of [Capability.AUCTION_CREATE_OWN, Capability.AUCTION_READ_OWN, Capability.AUCTION_MANAGE_OWN]) {
      expect(AuthorizationPolicyService.can(identity(overrides), capability)).toBe(true);
    }
  });

  it('blocks an unapproved broker from creating and managing, but not from reading their own', () => {
    const pending = identity({ accountType: AccountType.BROKER, brokerStatus: BrokerStatus.PENDING });
    expect(AuthorizationPolicyService.can(pending, Capability.AUCTION_CREATE_OWN)).toBe(false);
    expect(AuthorizationPolicyService.can(pending, Capability.AUCTION_MANAGE_OWN)).toBe(false);
    expect(AuthorizationPolicyService.can(pending, Capability.AUCTION_READ_OWN)).toBe(true);
  });

  it('lets a suspended account read its own auctions but not mutate them', () => {
    const suspended = identity({ accountStatus: AccountStatus.SUSPENDED });
    expect(AuthorizationPolicyService.can(suspended, Capability.AUCTION_READ_OWN)).toBe(true);
    expect(AuthorizationPolicyService.can(suspended, Capability.AUCTION_CREATE_OWN)).toBe(false);
    expect(AuthorizationPolicyService.can(suspended, Capability.AUCTION_MANAGE_OWN)).toBe(false);
  });

  it.each([SystemRole.ADMIN, SystemRole.SUPER_ADMIN])('denies %s every marketplace auction capability with the admin-marketplace error', (systemRole) => {
    const admin = identity({ systemRole });
    for (const capability of [Capability.AUCTION_CREATE_OWN, Capability.AUCTION_READ_OWN, Capability.AUCTION_MANAGE_OWN]) {
      expect(AuthorizationPolicyService.can(admin, capability)).toBe(false);
      expect(() => AuthorizationPolicyService.assert(admin, capability)).toThrow(ForbiddenException);
      try {
        AuthorizationPolicyService.assert(admin, capability);
      } catch (error) {
        expect((error as ForbiddenException).getResponse()).toMatchObject({ code: AuthorizationErrorCode.ADMIN_MARKETPLACE_FORBIDDEN });
      }
    }
  });

  it('grants ADMIN_AUCTION_READ to active staff only', () => {
    expect(AuthorizationPolicyService.can(identity({ systemRole: SystemRole.ADMIN }), Capability.ADMIN_AUCTION_READ)).toBe(true);
    expect(AuthorizationPolicyService.can(identity({ systemRole: SystemRole.SUPER_ADMIN }), Capability.ADMIN_AUCTION_READ)).toBe(true);
    expect(AuthorizationPolicyService.can(identity(), Capability.ADMIN_AUCTION_READ)).toBe(false);
    expect(AuthorizationPolicyService.can(identity({ systemRole: SystemRole.ADMIN, accountStatus: AccountStatus.SUSPENDED }), Capability.ADMIN_AUCTION_READ)).toBe(false);
  });
});

describe('MAZAD-025 request validation', () => {
  const createPipe = auctionValidation(CreateAuctionDto, AuctionErrorCode.REQUEST_INVALID);
  const valid = {
    propertyId: PROPERTY_ID,
    startingPriceMinor: 100_000,
    minimumBidStepMinor: 5_000,
    scheduledStartAt: '2026-03-02T10:00:00.000Z',
    scheduledEndAt: '2026-03-09T10:00:00.000Z',
  };

  it('accepts a well-formed create body', () => {
    expect(createPipe.transform(valid, {} as any)).toMatchObject(valid);
  });

  it.each([
    ['client-supplied advertiserAccountId', { ...valid, advertiserAccountId: OTHER }],
    ['client-supplied status', { ...valid, status: 'active' }],
    ['client-supplied propertyRevisionId', { ...valid, propertyRevisionId: REVISION_ID }],
    ['client-supplied ruleSnapshot', { ...valid, ruleSnapshot: {} }],
    ['client-supplied currentEndAt', { ...valid, currentEndAt: valid.scheduledEndAt }],
    ['malformed propertyId', { ...valid, propertyId: 'nope' }],
    ['string money', { ...valid, startingPriceMinor: '100000' }],
    ['fractional money', { ...valid, startingPriceMinor: 10.5 }],
    ['zero step', { ...valid, minimumBidStepMinor: 0 }],
    ['non-ISO date', { ...valid, scheduledStartAt: 'tomorrow' }],
    ['missing end', { ...valid, scheduledEndAt: undefined }],
  ])('rejects %s with AUCTION_REQUEST_INVALID', async (_label, body) => {
    expect(await codeOf(() => createPipe.transform(body, {} as any))).toBe(AuctionErrorCode.REQUEST_INVALID);
  });

  it('validates the cancel body (reason length, expectedStatus enum, unknown fields)', async () => {
    const pipe = auctionValidation(CancelAuctionDto, AuctionErrorCode.REQUEST_INVALID);
    expect(pipe.transform({}, {} as any)).toBeDefined();
    expect(pipe.transform({ reason: '  سبب  ', expectedStatus: 'active' }, {} as any)).toMatchObject({ reason: 'سبب', expectedStatus: 'active' });
    expect(await codeOf(() => pipe.transform({ reason: 'x'.repeat(1001) }, {} as any))).toBe(AuctionErrorCode.REQUEST_INVALID);
    expect(await codeOf(() => pipe.transform({ expectedStatus: 'exploded' }, {} as any))).toBe(AuctionErrorCode.REQUEST_INVALID);
    expect(await codeOf(() => pipe.transform({ cancelledByActorId: OTHER }, {} as any))).toBe(AuctionErrorCode.REQUEST_INVALID);
  });

  describe('query validation (pagination/filter bounds)', () => {
    const publicPipe = auctionValidation(ListPublicAuctionsDto, AuctionErrorCode.QUERY_INVALID);

    it('coerces numeric query strings and accepts valid filters', () => {
      expect(publicPipe.transform({ page: '2', limit: '50', status: 'active', sort: 'ending_soon', minStartingPriceMinor: '10' }, {} as any))
        .toMatchObject({ page: 2, limit: 50, status: 'active', sort: 'ending_soon', minStartingPriceMinor: 10 });
    });

    it.each([
      ['limit above the cap', { limit: '51' }],
      ['limit zero', { limit: '0' }],
      ['page zero', { page: '0' }],
      ['non-numeric page', { page: 'abc' }],
      ['fractional page', { page: '1.5' }],
      ['non-public status (cancelled)', { status: 'cancelled' }],
      ['non-public status (completed)', { status: 'completed' }],
      ['unknown status', { status: 'bogus' }],
      ['unknown sort', { sort: 'random' }],
      ['malformed category id', { purposeCategoryId: 'x' }],
      ['negative price', { minStartingPriceMinor: '-1' }],
      ['unknown filter key', { advertiserAccountId: OTHER }],
    ])('rejects %s with AUCTION_QUERY_INVALID', async (_label, query) => {
      expect(await codeOf(() => publicPipe.transform(query, {} as any))).toBe(AuctionErrorCode.QUERY_INVALID);
    });

    it('allows any real status on own listing, and only valid ids on the admin listing', async () => {
      const own = auctionValidation(ListOwnAuctionsDto, AuctionErrorCode.QUERY_INVALID);
      expect(own.transform({ status: 'cancelled' }, {} as any)).toMatchObject({ status: 'cancelled' });
      expect(await codeOf(() => own.transform({ status: 'bogus' }, {} as any))).toBe(AuctionErrorCode.QUERY_INVALID);
      const admin = auctionValidation(ListAdminAuctionsDto, AuctionErrorCode.QUERY_INVALID);
      expect(admin.transform({ propertyId: PROPERTY_ID, advertiserAccountId: ME }, {} as any)).toBeDefined();
      expect(await codeOf(() => admin.transform({ propertyId: 'bad' }, {} as any))).toBe(AuctionErrorCode.QUERY_INVALID);
    });
  });

  it('rejects a malformed :auctionId path param with AUCTION_ID_INVALID', async () => {
    const pipe = new ParseAuctionIdPipe();
    expect(pipe.transform(AUCTION_ID)).toBe(AUCTION_ID);
    for (const bad of ['nope', '123', '', 'zzzzzzzzzzzzzzzzzzzzzzzz']) {
      expect(await codeOf(() => pipe.transform(bad))).toBe(AuctionErrorCode.ID_INVALID);
    }
  });
});

describe('MAZAD-025 projections (whitelist, no leakage)', () => {
  const FORBIDDEN_PUBLIC_KEYS = [
    'advertiserAccountId', 'advertiserAccountTypeSnapshot', 'createdByActorId', 'cancelledByActorId', 'cancelledAt', 'cancellationReason',
    'winnerAccountId', 'winningBidAmountMinor', 'completedAt', 'propertyRevisionId', 'propertyId', 'version', 'createdAt', 'updatedAt', 'ruleSnapshot',
    '_id', '__v',
  ];

  it('public projection exposes only the whitelisted browsing facts', () => {
    const view = toPublicAuction(rawAuction({ status: AuctionStatus.ACTIVE }), PUBLIC_PROPERTY);
    expect(Object.keys(view).sort()).toEqual([
      'currency', 'currentEndAt', 'entryFee', 'id', 'minimumBidStepMinor', 'property', 'rules', 'scheduledEndAt', 'scheduledStartAt', 'startingPriceMinor', 'status',
    ]);
    // MAZAD-035: the Admin-approved fee is public (bidders must know it before paying); a missing fee is never "free".
    expect(view.entryFee).toEqual({ configured: false, free: false, amountMinor: null, currency: 'EGP' });
    expect(toPublicAuction(rawAuction({ entryFee: { amountMinor: 0, currency: 'EGP' } }), PUBLIC_PROPERTY).entryFee).toEqual({ configured: true, free: true, amountMinor: 0, currency: 'EGP' });
    for (const key of FORBIDDEN_PUBLIC_KEYS) expect(view).not.toHaveProperty(key);
    expect(view.id).toBe(AUCTION_ID);
    expect(view.property).toBe(PUBLIC_PROPERTY);
  });

  it('public rules expose timing/bid-rule facts only, never internal snapshot flags', () => {
    const { rules } = toPublicAuction(rawAuction(), PUBLIC_PROPERTY);
    expect(rules).toEqual({ version: 1, antiSnipingWindowSeconds: 300, antiSnipingExtensionSeconds: 300, hasReservePrice: false, advertiserSelfBidForbidden: true });
  });

  it('never serialises private ids or future-domain fields for the public, even when a fat document is passed in', () => {
    const json = JSON.stringify(toPublicAuction(rawAuction({ secretInternalNote: 'admin-only', workerLease: 'x', paymentRef: 'p' }), PUBLIC_PROPERTY));
    for (const leaked of [ME, OTHER, REVISION_ID, 'admin-only', 'workerLease', 'paymentRef', 'winner']) expect(json).not.toContain(leaked);
  });

  it('own projection adds the owner\'s lifecycle facts but still no actor ids or winner data', () => {
    const view = toOwnAuction(rawAuction({ status: AuctionStatus.CANCELLED, cancelledAt: NOW, cancellationReason: 'تغيرت الظروف' }), null);
    expect(view).toMatchObject({ id: AUCTION_ID, propertyId: PROPERTY_ID, propertyRevisionId: REVISION_ID, cancelledAt: NOW, cancellationReason: 'تغيرت الظروف', property: null });
    for (const key of ['advertiserAccountId', 'createdByActorId', 'cancelledByActorId', 'winnerAccountId', 'winningBidAmountMinor', 'ruleSnapshot', 'version', 'updatedAt']) {
      expect(view).not.toHaveProperty(key);
    }
  });

  it('admin projection carries attribution and cancellation actors but no bid/winner/payment/snapshot internals', () => {
    const view = toAdminAuction(rawAuction());
    expect(view).toMatchObject({ advertiserAccountId: ME, createdByActorId: ME, cancelledByActorId: ME, propertyId: PROPERTY_ID });
    for (const key of ['winnerAccountId', 'winningBidAmountMinor', 'ruleSnapshot', 'version']) expect(view).not.toHaveProperty(key);
  });
});

/** Minimal in-memory Auction model covering the exact query shapes AuctionsQueryService issues. */
function fakeAuctionModel(docs: any[], aggregateResult?: any) {
  const idStr = (value: any) => (value && value.toString ? value.toString() : String(value));
  const matches = (doc: any, filter: Record<string, any>) =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = doc[key];
      if (expected && typeof expected === 'object' && !(expected instanceof Types.ObjectId) && '$in' in expected) return expected.$in.includes(actual);
      return idStr(actual) === idStr(expected);
    });
  const calls: Record<string, any[]> = { find: [], findOne: [], sort: [], skip: [], limit: [], aggregate: [] };
  const model = {
    find: jest.fn((filter: any) => {
      calls.find.push(filter);
      let result = docs.filter((doc) => matches(doc, filter));
      const chain: any = {
        sort: (s: any) => { calls.sort.push(s); return chain; },
        skip: (n: number) => { calls.skip.push(n); result = result.slice(n); return chain; },
        limit: (n: number) => { calls.limit.push(n); result = result.slice(0, n); return chain; },
        lean: () => chain,
        exec: async () => result,
      };
      return chain;
    }),
    findOne: jest.fn((filter: any) => {
      calls.findOne.push(filter);
      return { lean: () => ({ exec: async () => docs.find((doc) => matches(doc, filter)) ?? null }) };
    }),
    findById: jest.fn((id: string) => ({ lean: () => ({ exec: async () => docs.find((doc) => idStr(doc._id) === id) ?? null }) })),
    countDocuments: jest.fn((filter: any) => ({ exec: async () => docs.filter((doc) => matches(doc, filter)).length })),
    aggregate: jest.fn((pipeline: any[]) => {
      calls.aggregate.push(pipeline);
      return { exec: async () => [aggregateResult ?? { items: [], total: [] }] };
    }),
  };
  return { model, calls };
}

function queryService(docs: any[], options: { aggregateResult?: any; projections?: Map<string, any> } = {}) {
  const { model, calls } = fakeAuctionModel(docs, options.aggregateResult);
  const properties = {
    buildPublicAuctionMatches: jest.fn().mockResolvedValue({
      propertyMatch: { status: 'approved', isOwnerVisible: { $ne: false } },
      revisionMatch: { governorateCode: 'CAI', city: 'Nasr City' },
    }),
    getAnchoredPublicProjections: jest.fn().mockResolvedValue(options.projections ?? new Map()),
  };
  const clock = { now: jest.fn(() => NOW) };
  const instance = Object.create(AuctionsQueryService.prototype) as any;
  Object.assign(instance, { auctions: model, properties, clock });
  return { instance: instance as AuctionsQueryService, model, calls, properties };
}

const anchoredKey = (propertyId = PROPERTY_ID, revisionId = REVISION_ID) => `${propertyId}:${revisionId}`;

describe('AuctionsQueryService — own auctions (MAZAD-025)', () => {
  const mine = rawAuction();
  const theirs = rawAuction({ _id: oid(AUCTION_2), advertiserAccountId: oid(OTHER), status: AuctionStatus.ACTIVE });
  const cancelled = rawAuction({ _id: oid('64b000000000000000000c03'), status: AuctionStatus.CANCELLED });

  it('lists only the caller\'s auctions, in every status (including non-public ones)', async () => {
    const { instance } = queryService([mine, theirs, cancelled]);
    const result = await instance.listMine(ME);
    expect(result.items.map((item) => item.id).sort()).toEqual([AUCTION_ID, '64b000000000000000000c03'].sort());
    expect(result.items.some((item) => item.status === AuctionStatus.CANCELLED)).toBe(true);
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(result.serverTime).toEqual(NOW);
  });

  it('scopes the query by the server-derived account id and applies an optional status filter', async () => {
    const { instance, calls } = queryService([mine, cancelled]);
    await instance.listMine(ME, { status: AuctionStatus.CANCELLED });
    expect(calls.find[0].advertiserAccountId.toString()).toBe(ME);
    expect(calls.find[0].status).toBe(AuctionStatus.CANCELLED);
  });

  it('bounds pagination: clamps limit to 50 and page to >= 1', async () => {
    const { instance, calls } = queryService([mine]);
    await instance.listMine(ME, { page: -3, limit: 9999 });
    expect(calls.limit[0]).toBe(50);
    expect(calls.skip[0]).toBe(0);
    const second = queryService([mine]);
    await second.instance.listMine(ME, { page: 3, limit: 10 });
    expect(second.calls.skip[0]).toBe(20);
    expect(second.calls.limit[0]).toBe(10);
  });

  it('attaches the anchored property projection when available and null when the property is no longer public', async () => {
    const withProperty = queryService([mine], { projections: new Map([[anchoredKey(), PUBLIC_PROPERTY]]) });
    expect((await withProperty.instance.listMine(ME)).items[0].property).toBe(PUBLIC_PROPERTY);
    const hidden = queryService([mine]);
    expect((await hidden.instance.listMine(ME)).items[0].property).toBeNull();
  });

  it('returns own auction detail', async () => {
    const { instance } = queryService([mine], { projections: new Map([[anchoredKey(), PUBLIC_PROPERTY]]) });
    const { auction } = await instance.getMine(ME, AUCTION_ID);
    expect(auction).toMatchObject({ id: AUCTION_ID, status: AuctionStatus.SCHEDULED, property: PUBLIC_PROPERTY });
    expect(auction).not.toHaveProperty('advertiserAccountId');
  });

  it('treats another account\'s auction exactly like a missing one (404, no ownership oracle)', async () => {
    const { instance } = queryService([theirs]);
    expect(await codeOf(() => instance.getMine(ME, AUCTION_2))).toBe(AuctionErrorCode.NOT_FOUND);
    expect(await codeOf(() => instance.getMine(ME, '64b000000000000000000ffff'.slice(0, 24)))).toBe(AuctionErrorCode.NOT_FOUND);
    await expect(instance.getMine(ME, AUCTION_2)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a malformed id with AUCTION_ID_INVALID before querying', async () => {
    const { instance, model } = queryService([mine]);
    expect(await codeOf(() => instance.getMine(ME, 'nope'))).toBe(AuctionErrorCode.ID_INVALID);
    expect(model.findOne).not.toHaveBeenCalled();
  });
});

describe('AuctionsQueryService — public discovery (MAZAD-025)', () => {
  const page = (docs: any[], total = docs.length) => ({ items: docs, total: [{ count: total }] });

  it('defaults to open-to-browse statuses (SCHEDULED/ACTIVE) and never includes terminal or cancelled auctions', async () => {
    const { instance, calls } = queryService([], { aggregateResult: page([]) });
    await instance.listPublic({});
    const match = calls.aggregate[0][0].$match;
    expect(match.status).toEqual({ $in: [...DEFAULT_PUBLIC_LIST_STATUSES] });
    for (const status of [AuctionStatus.CANCELLED, AuctionStatus.ENDED_NO_BIDS, AuctionStatus.COMPLETED]) {
      expect(JSON.stringify(match)).not.toContain(status);
    }
    expect(PUBLIC_AUCTION_STATUSES).not.toContain(AuctionStatus.CANCELLED);
  });

  it('joins to the property with the shared public-visibility gate before paginating', async () => {
    const { instance, calls, properties } = queryService([], { aggregateResult: page([]) });
    await instance.listPublic({ governorateCode: 'CAI', city: 'Nasr City' });
    expect(properties.buildPublicAuctionMatches).toHaveBeenCalledWith(expect.objectContaining({ governorateCode: 'CAI', city: 'Nasr City' }));
    const pipeline = calls.aggregate[0];
    const lookups = pipeline.filter((stage: any) => stage.$lookup).map((stage: any) => stage.$lookup);
    expect(lookups.map((lookup: any) => lookup.from)).toEqual(['properties', 'property_revisions']);
    expect(JSON.stringify(lookups[0].pipeline[0].$match.$and[1])).toContain('approved');
    expect(lookups[1].pipeline[0].$match.$and[1]).toEqual({ governorateCode: 'CAI', city: 'Nasr City' });
    const stageNames = pipeline.map((stage: any) => Object.keys(stage)[0]);
    expect(stageNames.lastIndexOf('$lookup')).toBeLessThan(stageNames.indexOf('$facet'));
    expect(stageNames.indexOf('$sort')).toBeLessThan(stageNames.indexOf('$facet'));
  });

  it.each([
    ['newest', { createdAt: -1, _id: -1 }],
    ['ending_soon', { currentEndAt: 1, _id: 1 }],
    ['starting_soon', { scheduledStartAt: 1, _id: 1 }],
    ['price_asc', { startingPriceMinor: 1, _id: 1 }],
    ['price_desc', { startingPriceMinor: -1, _id: -1 }],
  ] as const)('sorts by %s deterministically', async (sort, expected) => {
    const { instance, calls } = queryService([], { aggregateResult: page([]) });
    await instance.listPublic({ sort });
    expect(calls.aggregate[0].find((stage: any) => stage.$sort).$sort).toEqual(expected);
  });

  it('defaults to newest first', async () => {
    const { instance, calls } = queryService([], { aggregateResult: page([]) });
    await instance.listPublic({});
    expect(calls.aggregate[0].find((stage: any) => stage.$sort).$sort).toEqual({ createdAt: -1, _id: -1 });
  });

  it('applies a requested public status and a starting-price range; rejects an inverted range', async () => {
    const { instance, calls } = queryService([], { aggregateResult: page([]) });
    await instance.listPublic({ status: AuctionStatus.ACTIVE, minStartingPriceMinor: 10, maxStartingPriceMinor: 99 });
    expect(calls.aggregate[0][0].$match).toEqual({ status: AuctionStatus.ACTIVE, startingPriceMinor: { $gte: 10, $lte: 99 } });
    expect(await codeOf(() => instance.listPublic({ minStartingPriceMinor: 100, maxStartingPriceMinor: 10 }))).toBe(AuctionErrorCode.QUERY_INVALID);
  });

  it('bounds pagination and reports totals from the same filtered set', async () => {
    const { instance, calls } = queryService([], { aggregateResult: page([], 120) });
    const result = await instance.listPublic({ page: 3, limit: 9999 });
    const facet = calls.aggregate[0].find((stage: any) => stage.$facet).$facet;
    expect(facet.items).toEqual([{ $skip: 100 }, { $limit: 50 }]);
    expect(result.pagination).toEqual({ page: 3, limit: 50, total: 120, totalPages: 3 });
  });

  it('returns only whitelisted public projections and never a client-selectable identity filter', async () => {
    const doc = rawAuction({ status: AuctionStatus.ACTIVE });
    const { instance, calls } = queryService([], { aggregateResult: page([doc]), projections: new Map([[anchoredKey(), PUBLIC_PROPERTY]]) });
    const result = await instance.listPublic({});
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(toPublicAuction(doc, PUBLIC_PROPERTY));
    expect(JSON.stringify(result)).not.toContain(ME);
    expect(JSON.stringify(calls.aggregate[0][0])).not.toContain('advertiserAccountId');
  });

  it('omits an auction whose property projection is no longer available', async () => {
    const { instance } = queryService([], { aggregateResult: page([rawAuction()]) });
    operationalMetrics.reset();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    expect((await instance.listPublic({})).items).toEqual([]);
    // A row lost after the anchored pipeline is data corruption: it must be logged, never silent.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('auction_anchor_unresolved'));
    expect(operationalMetrics.snapshot().auction_anchor_unresolved).toBe(1);
    error.mockRestore();
  });

  it('public detail returns the safe projection plus the authoritative server time', async () => {
    const doc = rawAuction({ status: AuctionStatus.ACTIVE });
    const { instance } = queryService([doc], { projections: new Map([[anchoredKey(), PUBLIC_PROPERTY]]) });
    const result = await instance.getPublic(AUCTION_ID);
    expect(result.auction).toEqual(toPublicAuction(doc, PUBLIC_PROPERTY));
    expect(result.serverTime).toEqual(NOW);
  });

  it.each([AuctionStatus.SCHEDULED, AuctionStatus.ACTIVE, AuctionStatus.ENDED_PENDING_CLOSE])('serves a %s auction publicly', async (status) => {
    const { instance } = queryService([rawAuction({ status })], { projections: new Map([[anchoredKey(), PUBLIC_PROPERTY]]) });
    await expect(instance.getPublic(AUCTION_ID)).resolves.toBeDefined();
  });

  it.each([AuctionStatus.CANCELLED, AuctionStatus.ENDED_NO_BIDS, AuctionStatus.COMPLETED])('hides a %s auction with AUCTION_PUBLIC_UNAVAILABLE and never loads its property', async (status) => {
    const { instance, properties } = queryService([rawAuction({ status })], { projections: new Map([[anchoredKey(), PUBLIC_PROPERTY]]) });
    expect(await codeOf(() => instance.getPublic(AUCTION_ID))).toBe(AuctionErrorCode.PUBLIC_UNAVAILABLE);
    expect(properties.getAnchoredPublicProjections).not.toHaveBeenCalled();
  });

  it('hides an auction whose property is no longer publicly visible (hidden/archived/ineligible)', async () => {
    const { instance } = queryService([rawAuction({ status: AuctionStatus.ACTIVE })]);
    expect(await codeOf(() => instance.getPublic(AUCTION_ID))).toBe(AuctionErrorCode.PUBLIC_UNAVAILABLE);
  });

  it('distinguishes a missing auction (NOT_FOUND) from a malformed id (ID_INVALID)', async () => {
    const { instance } = queryService([]);
    expect(await codeOf(() => instance.getPublic(AUCTION_ID))).toBe(AuctionErrorCode.NOT_FOUND);
    expect(await codeOf(() => instance.getPublic('nope'))).toBe(AuctionErrorCode.ID_INVALID);
  });
});

describe('AuctionsQueryService — admin operational reads (MAZAD-025)', () => {
  const docs = [rawAuction(), rawAuction({ _id: oid(AUCTION_2), advertiserAccountId: oid(OTHER), status: AuctionStatus.CANCELLED })];

  it('lists all auctions in any status with attribution, filterable by status/property/advertiser', async () => {
    const { instance, calls } = queryService(docs);
    const all = await instance.listForAdmin({});
    expect(all.items).toHaveLength(2);
    expect(all.items[0]).toHaveProperty('advertiserAccountId');
    await instance.listForAdmin({ status: AuctionStatus.CANCELLED, propertyId: PROPERTY_ID, advertiserAccountId: OTHER });
    expect(calls.find[1].status).toBe(AuctionStatus.CANCELLED);
    expect(calls.find[1].propertyId.toString()).toBe(PROPERTY_ID);
    expect(calls.find[1].advertiserAccountId.toString()).toBe(OTHER);
  });

  it('reads one auction, 404 for a missing one, 400 for a malformed id', async () => {
    const { instance } = queryService(docs);
    expect((await instance.getForAdmin(AUCTION_ID)).auction.id).toBe(AUCTION_ID);
    expect(await codeOf(() => instance.getForAdmin('64b000000000000000000dd01'.slice(0, 24)))).toBe(AuctionErrorCode.NOT_FOUND);
    expect(await codeOf(() => instance.getForAdmin('nope'))).toBe(AuctionErrorCode.ID_INVALID);
  });

  it('is read-only and unaudited: the query service holds no audit or mutation dependency', () => {
    const { instance } = queryService(docs);
    expect((instance as any).audit).toBeUndefined();
    for (const method of Object.getOwnPropertyNames(AuctionsQueryService.prototype)) {
      expect(method).toMatch(/^(constructor|list|get)/);
    }
  });
});

describe('AuctionsController delegation (MAZAD-025)', () => {
  function controller() {
    const auctions = { rejectDirectCreation: jest.fn(() => { throw new Error('AUCTION_REVIEW_REQUIRED'); }) };
    const lifecycle = { cancel: jest.fn().mockResolvedValue({ ok: 'cancelled' }) };
    const queries = {
      listMine: jest.fn().mockResolvedValue('mine'), getMine: jest.fn().mockResolvedValue('one'),
      listPublic: jest.fn().mockResolvedValue('public'), getPublic: jest.fn().mockResolvedValue('pub-one'),
    };
    return { ctrl: new AuctionsController(auctions as any, lifecycle as any, queries as any), auctions, lifecycle, queries };
  }
  const req = { user: { userId: ME }, ip: '203.0.113.9' };

  it('MAZAD-035: create is retired and delegates only to the review-required rejection (no auction can be created here)', () => {
    const { ctrl, auctions } = controller();
    expect(() => ctrl.create()).toThrow();
    expect(auctions.rejectDirectCreation).toHaveBeenCalledTimes(1);
  });

  it('cancels through AuctionLifecycleService (never mutating status itself), passing reason, ip and the optimistic expectedStatus', async () => {
    const { ctrl, lifecycle } = controller();
    await ctrl.cancel(req, AUCTION_ID, { reason: 'سبب', expectedStatus: AuctionStatus.ACTIVE });
    expect(lifecycle.cancel).toHaveBeenCalledWith(ME, AUCTION_ID, 'سبب', '203.0.113.9', AuctionStatus.ACTIVE);
  });

  it('reads own/public data scoped by the token identity and route id only', async () => {
    const { ctrl, queries } = controller();
    await ctrl.listMine(req, { status: 'active' });
    await ctrl.getMine(req, AUCTION_ID);
    await ctrl.listPublic({ sort: 'newest' });
    await ctrl.getPublic(AUCTION_ID);
    expect(queries.listMine).toHaveBeenCalledWith(ME, { status: 'active' });
    expect(queries.getMine).toHaveBeenCalledWith(ME, AUCTION_ID);
    expect(queries.getPublic).toHaveBeenCalledWith(AUCTION_ID);
  });
});

describe('PropertiesService.getAnchoredPublicProjections (MAZAD-025)', () => {
  const REV_OLD = '64b000000000000000000b10';
  const REV_NEW = '64b000000000000000000b11';
  const REV_FOREIGN = '64b000000000000000000b12';

  function propertiesService(propertyDocs: any[], revisionDocs: any[]) {
    const propertyQueries: any[] = [];
    const properties = {
      find: jest.fn((filter: any) => {
        propertyQueries.push(filter);
        return { lean: () => ({ exec: async () => propertyDocs }) };
      }),
    };
    const revisions = { find: jest.fn(() => ({ lean: () => ({ exec: async () => revisionDocs }) })) };
    const instance = Object.create(PropertiesService.prototype) as any;
    // hydratePublicListings has its own coverage (MAZAD-021); stub it to expose which revision each item is anchored to.
    instance.hydratePublicListings = jest.fn(async (items: any[]) => items.map((item) => ({ id: item._id.toString(), title: item.currentPublicRevisionId.title })));
    Object.assign(instance, { properties, revisions });
    return { instance: instance as PropertiesService, propertyQueries, properties };
  }

  const property = { _id: oid(PROPERTY_ID), status: 'approved', currentPublicRevisionId: oid(REV_NEW) };
  const revOld = { _id: oid(REV_OLD), propertyId: oid(PROPERTY_ID), title: 'old anchored revision' };
  const revNew = { _id: oid(REV_NEW), propertyId: oid(PROPERTY_ID), title: 'newer current revision' };

  it('renders the frozen anchored revision, not the property\'s current public revision', async () => {
    const { instance } = propertiesService([property], [revOld, revNew]);
    const result = await instance.getAnchoredPublicProjections([{ propertyId: PROPERTY_ID, revisionId: REV_OLD }]);
    expect(result.get(`${PROPERTY_ID}:${REV_OLD}`)).toEqual({ id: PROPERTY_ID, title: 'old anchored revision' });
  });

  it('supports a re-auctioned property under two different anchored revisions without key collision', async () => {
    const { instance } = propertiesService([property], [revOld, revNew]);
    const result = await instance.getAnchoredPublicProjections([
      { propertyId: PROPERTY_ID, revisionId: REV_OLD }, { propertyId: PROPERTY_ID, revisionId: REV_NEW },
    ]);
    expect(result.get(`${PROPERTY_ID}:${REV_OLD}`)?.title).toBe('old anchored revision');
    expect(result.get(`${PROPERTY_ID}:${REV_NEW}`)?.title).toBe('newer current revision');
  });

  it('applies the shared public-visibility gate to the property query', async () => {
    const { instance, propertyQueries } = propertiesService([property], [revOld]);
    await instance.getAnchoredPublicProjections([{ propertyId: PROPERTY_ID, revisionId: REV_OLD }]);
    // Phase 13: set-membership form of the same gate (owner-visible or unset; lifecycle active or unset).
    expect(propertyQueries[0]).toMatchObject({ status: 'approved', isOwnerVisible: { $in: [true, null] }, lifecycleStatus: { $in: ['active', null] } });
    expect(JSON.stringify(propertyQueries[0].lifecycleStatus)).not.toContain('admin_hidden');
    expect(JSON.stringify(propertyQueries[0].lifecycleStatus)).not.toContain('archived');
  });

  it('omits properties that fail the gate, and revisions that do not belong to the property', async () => {
    const hidden = propertiesService([], [revOld]);
    expect((await hidden.instance.getAnchoredPublicProjections([{ propertyId: PROPERTY_ID, revisionId: REV_OLD }])).size).toBe(0);
    const foreign = { _id: oid(REV_FOREIGN), propertyId: oid('64b000000000000000000b99'), title: 'someone else' };
    const mismatch = propertiesService([property], [foreign]);
    expect((await mismatch.instance.getAnchoredPublicProjections([{ propertyId: PROPERTY_ID, revisionId: REV_FOREIGN }])).size).toBe(0);
  });

  it('returns empty without querying for empty or malformed input', async () => {
    const { instance, properties } = propertiesService([property], [revOld]);
    expect((await instance.getAnchoredPublicProjections([])).size).toBe(0);
    expect((await instance.getAnchoredPublicProjections([{ propertyId: 'bad', revisionId: REV_OLD }])).size).toBe(0);
    expect(properties.find).not.toHaveBeenCalled();
  });
});
