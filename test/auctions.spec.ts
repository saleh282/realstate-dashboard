import { Types } from 'mongoose';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuthorizationErrorCode } from '../src/authorization/authorization-error-codes';
import { SystemRole } from '../src/auth/roles.enum';
import { AccountStatus, AccountType, BrokerStatus } from '../src/users/identity.types';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';
import { AuctionErrorCode } from '../src/common/errors/auction-error-codes';
import {
  AUCTION_ANTI_SNIPING_EXTENSION_SECONDS_V1,
  AUCTION_ANTI_SNIPING_WINDOW_SECONDS_V1,
  AUCTION_RULE_SNAPSHOT_VERSION_V1,
  buildAuctionRuleSnapshot,
} from '../src/auctions/auction-rule-snapshot';
import { AUCTION_TERMINAL_STATUSES, AuctionStatus } from '../src/auctions/auction.types';
import { AuctionRuleSnapshot, AuctionSchema } from '../src/auctions/schemas/auction.schema';
import { AuctionsService, CreateAuctionInput } from '../src/auctions/auctions.service';

/**
 * MAZAD-023 — Auction persistence/domain foundation. This task deliberately
 * implements only auction *creation*; bid acceptance, anti-sniping
 * execution, scheduling/closing workers, cancellation and winner selection
 * are MAZAD-024+. These tests therefore cover: the schema's own invariants
 * (indexes, immutable fields, no evidence leakage), the immutable rule
 * snapshot builder, the status vocabulary, and `AuctionsService.create`'s
 * validation/attribution/authorization wiring.
 */

// Self-service creation (the only mode MAZAD-023 implements) requires the
// acting account to *be* the property's advertiser, so the default fixtures
// below deliberately use the same id for both; OTHER_ADVERTISER_ID exists
// only for the "not your own property" IDOR test.
const ACTOR_ID = '64b000000000000000000401';
const ADVERTISER_ID = ACTOR_ID;
const OTHER_ADVERTISER_ID = '64b000000000000000000202';
const PROPERTY_ID = '64b000000000000000000301';
const REVISION_ID = '64b000000000000000000302';

function marketplaceUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: ACTOR_ID,
    systemRole: SystemRole.USER,
    accountType: AccountType.USER,
    accountStatus: AccountStatus.ACTIVE,
    brokerStatus: BrokerStatus.NOT_APPLIED,
    ...overrides,
  };
}

function anchor(overrides: Record<string, unknown> = {}) {
  return {
    propertyId: PROPERTY_ID,
    advertiserAccountId: ADVERTISER_ID,
    advertiserAccountTypeSnapshot: AccountType.USER,
    currentPublicRevisionId: REVISION_ID,
    ...overrides,
  };
}

function validInput(overrides: Partial<CreateAuctionInput> = {}): CreateAuctionInput {
  return {
    propertyId: PROPERTY_ID,
    startingPriceMinor: 100_000,
    minimumBidStepMinor: 5_000,
    scheduledStartAt: new Date('2026-02-01T10:00:00Z'),
    scheduledEndAt: new Date('2026-02-08T10:00:00Z'),
    ...overrides,
  };
}

/** In-memory stand-in for the Mongoose Auction model's `.create([...], {session})`. */
function service(options: { actor?: any; anchor?: any } = {}) {
  const createCalls: any[] = [];
  const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn().mockResolvedValue(undefined) };
  const auctions = {
    create: jest.fn(async (docs: any[]) => {
      const doc = { _id: `auction-${createCalls.length + 1}`, ...docs[0], createdAt: new Date('2026-01-15T00:00:00Z'), toObject() { return this; } };
      createCalls.push(doc);
      return [doc];
    }),
  };
  const users = { findById: jest.fn(() => ({ lean: () => ({ exec: async () => (options.actor === undefined ? marketplaceUser() : options.actor) }) })) };
  const properties = { getEligibleForAuctionAnchor: jest.fn().mockResolvedValue(options.anchor === undefined ? anchor() : options.anchor) };
  const audit = { logRequired: jest.fn().mockResolvedValue(undefined) };
  const connection = { startSession: jest.fn().mockResolvedValue(session) };
  const instance = Object.create(AuctionsService.prototype) as any;
  Object.assign(instance, { auctions, users, properties, audit, connection });
  return { instance: instance as AuctionsService, auctions, users, properties, audit, createCalls, session };
}

async function forbiddenCode(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return ((error as ForbiddenException).getResponse() as { code?: string })?.code;
  }
}

describe('buildAuctionRuleSnapshot (MAZAD-023)', () => {
  it('builds a frozen snapshot carrying the frozen V1 rules', () => {
    const snapshot = buildAuctionRuleSnapshot(validInput());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toMatchObject({
      version: AUCTION_RULE_SNAPSHOT_VERSION_V1,
      startingPriceMinor: 100_000,
      minimumBidStepMinor: 5_000,
      currency: 'EGP',
      hasReservePrice: false,
      advertiserSelfBidForbidden: true,
      adminBiddingForbidden: true,
      bidsAreImmutable: true,
      serverTimeAuthoritative: true,
      automaticWinnerDetermination: true,
      secondPlacePromotionOnCancellation: false,
      antiSnipingWindowSeconds: AUCTION_ANTI_SNIPING_WINDOW_SECONDS_V1,
      antiSnipingExtensionSeconds: AUCTION_ANTI_SNIPING_EXTENSION_SECONDS_V1,
    });
  });

  it('freezes the "final 5 minutes, extend by 5 minutes, no cap" anti-sniping decision as data, not code', () => {
    const snapshot = buildAuctionRuleSnapshot(validInput());
    expect(snapshot.antiSnipingWindowSeconds).toBe(300);
    expect(snapshot.antiSnipingExtensionSeconds).toBe(300);
  });

  it.each([0, -1, 1.5, Number.NaN, 9_000_000_000_000_001])('rejects a non-positive/unsafe starting price %p', (value) => {
    expect(() => buildAuctionRuleSnapshot(validInput({ startingPriceMinor: value as number })))
      .toThrow(BadRequestException);
    try {
      buildAuctionRuleSnapshot(validInput({ startingPriceMinor: value as number }));
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: AuctionErrorCode.STARTING_PRICE_INVALID });
    }
  });

  it.each([0, -1, 1.5])('rejects a non-positive/non-integer minimum bid step %p', (value) => {
    try {
      buildAuctionRuleSnapshot(validInput({ minimumBidStepMinor: value as number }));
      throw new Error('expected to throw');
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: AuctionErrorCode.MINIMUM_BID_STEP_INVALID });
    }
  });

  it('rejects a schedule where the end is not strictly after the start', () => {
    const start = new Date('2026-02-01T10:00:00Z');
    try {
      buildAuctionRuleSnapshot(validInput({ scheduledStartAt: start, scheduledEndAt: start }));
      throw new Error('expected to throw');
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: AuctionErrorCode.SCHEDULE_INVALID });
    }
  });

  it('rejects an invalid Date instance', () => {
    try {
      buildAuctionRuleSnapshot(validInput({ scheduledStartAt: new Date('not-a-date') }));
      throw new Error('expected to throw');
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: AuctionErrorCode.SCHEDULE_INVALID });
    }
  });
});

describe('AuctionStatus vocabulary (MAZAD-023)', () => {
  it('defines exactly the statuses the frozen V1 outcomes require', () => {
    expect(Object.values(AuctionStatus).sort()).toEqual([
      'active', 'cancelled', 'completed', 'ended_no_bids', 'ended_pending_close', 'scheduled',
    ].sort());
  });

  it('marks ENDED_NO_BIDS, COMPLETED and CANCELLED (only) as terminal', () => {
    expect([...AUCTION_TERMINAL_STATUSES].sort()).toEqual(
      [AuctionStatus.ENDED_NO_BIDS, AuctionStatus.COMPLETED, AuctionStatus.CANCELLED].sort(),
    );
    expect(AUCTION_TERMINAL_STATUSES.has(AuctionStatus.SCHEDULED)).toBe(false);
    expect(AUCTION_TERMINAL_STATUSES.has(AuctionStatus.ACTIVE)).toBe(false);
    expect(AUCTION_TERMINAL_STATUSES.has(AuctionStatus.ENDED_PENDING_CLOSE)).toBe(false);
  });
});

describe('Auction schema invariants (MAZAD-023)', () => {
  it('declares the production-appropriate indexes (property, advertiser, status+scheduling, public listing)', () => {
    expect(AuctionSchema.indexes()).toEqual(expect.arrayContaining([
      [{ propertyId: 1, createdAt: -1 }, expect.objectContaining({ name: 'auction_property_history' })],
      [{ advertiserAccountId: 1, createdAt: -1 }, expect.objectContaining({ name: 'auction_advertiser_history' })],
      [{ status: 1, scheduledStartAt: 1 }, expect.objectContaining({ name: 'auction_status_start_schedule' })],
      [{ status: 1, currentEndAt: 1 }, expect.objectContaining({ name: 'auction_status_end_schedule' })],
      [{ status: 1, createdAt: -1 }, expect.objectContaining({ name: 'auction_public_listing_newest' })],
    ]));
  });

  it('declares exactly one uniqueness constraint: one auction per approval (MAZAD-035)', () => {
    const uniqueIndexes = AuctionSchema.indexes().filter(([, options]) => (options as any)?.unique);
    expect(uniqueIndexes).toEqual([[{ originRequestId: 1, originRequestRevision: 1 }, expect.objectContaining({ name: 'auction_origin_request_revision', partialFilterExpression: { originRequestId: { $exists: true } } })]]);
  });

  it.each(['originRequestId', 'originRequestRevision', 'approvedByActorId', 'approvedAt'])('MAZAD-035: marks the approval link %s immutable', (field) => {
    expect((AuctionSchema.path(field) as any)?.options?.immutable).toBeTruthy();
  });

  it.each([
    'propertyId', 'propertyRevisionId', 'advertiserAccountId', 'advertiserAccountTypeSnapshot', 'createdByActorId',
    'startingPriceMinor', 'minimumBidStepMinor', 'currency', 'scheduledStartAt', 'scheduledEndAt', 'ruleSnapshot',
  ])('marks %s immutable so it can never be silently changed after creation', (field) => {
    expect((AuctionSchema.path(field) as any)?.options?.immutable).toBeTruthy();
  });

  it.each(['status', 'currentEndAt', 'cancelledAt', 'completedAt', 'winnerAccountId', 'winningBidAmountMinor'])(
    'leaves %s mutable — later lifecycle tasks (MAZAD-024+) need to set it',
    (field) => {
      expect((AuctionSchema.path(field) as any)?.options?.immutable).toBeFalsy();
    },
  );

  it('defaults status to SCHEDULED and currency to EGP', () => {
    expect((AuctionSchema.path('status') as any).options.default).toBe(AuctionStatus.SCHEDULED);
    expect((AuctionSchema.path('currency') as any).options.default).toBe('EGP');
  });

  it('every field inside the immutable rule snapshot subdocument is itself immutable', () => {
    const snapshotSchema = (AuctionSchema.path('ruleSnapshot') as any).schema;
    const fields: (keyof AuctionRuleSnapshot)[] = [
      'version', 'startingPriceMinor', 'minimumBidStepMinor', 'currency', 'scheduledStartAt', 'scheduledEndAt',
      'hasReservePrice', 'advertiserSelfBidForbidden', 'adminBiddingForbidden', 'bidsAreImmutable',
      'serverTimeAuthoritative', 'automaticWinnerDetermination', 'secondPlacePromotionOnCancellation',
      'antiSnipingWindowSeconds', 'antiSnipingExtensionSeconds',
    ];
    for (const field of fields) {
      expect(snapshotSchema.path(field as string)?.options?.immutable).toBeTruthy();
    }
  });

  it('never declares a path for private property evidence, title deeds, or gallery media', () => {
    const paths = Object.keys((AuctionSchema as any).paths);
    const forbidden = /evidence|titledeed|gallery|privatemedia/i;
    expect(paths.some((path) => forbidden.test(path))).toBe(false);
  });

  it('uses integer minor-unit money validators, not float/double semantics', () => {
    expect((AuctionSchema.path('startingPriceMinor') as any).validators.length).toBeGreaterThan(0);
    expect((AuctionSchema.path('minimumBidStepMinor') as any).validators.length).toBeGreaterThan(0);
    expect((AuctionSchema.path('startingPriceMinor') as any).instance).toBe('Number');
    expect((AuctionSchema.path('minimumBidStepMinor') as any).instance).toBe('Number');
  });
});

describe('AuctionsService.createApprovedWithinTransaction (MAZAD-035; replaces direct creation)', () => {
  const approved = (overrides: Record<string, unknown> = {}) => ({
    auctionId: new Types.ObjectId('64b000000000000000000901'),
    propertyId: new Types.ObjectId(PROPERTY_ID),
    propertyRevisionId: new Types.ObjectId(REVISION_ID),
    advertiserAccountId: new Types.ObjectId(ADVERTISER_ID),
    advertiserAccountTypeSnapshot: AccountType.USER,
    createdByActorId: new Types.ObjectId(ACTOR_ID),
    originRequestId: new Types.ObjectId('64b000000000000000000902'),
    originRequestRevision: 3,
    approvedByActorId: new Types.ObjectId('64b000000000000000000903'),
    approvedAt: new Date('2026-01-20T00:00:00Z'),
    entryFeeMinor: 25_000,
    startingPriceMinor: 100_000,
    minimumBidStepMinor: 5_000,
    scheduledStartAt: new Date('2026-02-01T10:00:00Z'),
    scheduledEndAt: new Date('2026-02-08T10:00:00Z'),
    ...overrides,
  });
  const session = {} as any;

  it('creates the SCHEDULED auction with its approved terms, frozen snapshot, explicit fee and approval link in one write', async () => {
    const { instance, auctions, audit } = service();
    await instance.createApprovedWithinTransaction(session, approved() as any);
    expect(auctions.create).toHaveBeenCalledTimes(1);
    const [[docs, options]] = auctions.create.mock.calls as any[];
    expect(options).toEqual({ session });
    expect(docs[0]).toMatchObject({
      status: AuctionStatus.SCHEDULED, startingPriceMinor: 100_000, minimumBidStepMinor: 5_000, currency: 'EGP',
      scheduledStartAt: new Date('2026-02-01T10:00:00Z'), scheduledEndAt: new Date('2026-02-08T10:00:00Z'), currentEndAt: new Date('2026-02-08T10:00:00Z'),
      entryFee: { amountMinor: 25_000, currency: 'EGP' }, originRequestRevision: 3,
    });
    expect(String(docs[0].originRequestId)).toBe('64b000000000000000000902');
    expect(Object.isFrozen(docs[0].ruleSnapshot)).toBe(true);
    expect(audit.logRequired).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUCTION_CREATED, metadata: expect.objectContaining({ entryFeeMinor: 25_000 }) }), session);
  });

  it('persists an explicit 0 fee as a configured FREE fee (never absent)', async () => {
    const { instance, auctions } = service();
    await instance.createApprovedWithinTransaction(session, approved({ entryFeeMinor: 0 }) as any);
    expect(auctions.create.mock.calls[0][0][0].entryFee).toMatchObject({ amountMinor: 0, currency: 'EGP' });
  });

  it.each([0, -1, 1.5])('still rejects a non-positive/non-integer starting price (%p) through the rule snapshot', async (value) => {
    const { instance, auctions } = service();
    await expect(instance.createApprovedWithinTransaction(session, approved({ startingPriceMinor: value }) as any))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.STARTING_PRICE_INVALID }) });
    expect(auctions.create).not.toHaveBeenCalled();
  });

  it('retired direct creation always answers AUCTION_REVIEW_REQUIRED', () => {
    const { instance } = service();
    try { instance.rejectDirectCreation(); throw new Error('expected rejection'); } catch (error) {
      expect((error as any).getStatus()).toBe(409);
      expect((error as any).getResponse().code).toBe(AuctionErrorCode.REVIEW_REQUIRED);
    }
  });
});
