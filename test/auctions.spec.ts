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

  it('does not invent an unrequested uniqueness constraint', () => {
    const uniqueIndexes = AuctionSchema.indexes().filter(([, options]) => (options as any)?.unique);
    expect(uniqueIndexes).toHaveLength(0);
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

describe('AuctionsService.create (MAZAD-023)', () => {
  it('creates a SCHEDULED auction anchored to the property\'s attribution and current public revision', async () => {
    const { instance, auctions, audit } = service();
    const result = await instance.create(ACTOR_ID, validInput());

    expect(auctions.create).toHaveBeenCalledTimes(1);
    const [[docs]] = auctions.create.mock.calls;
    expect(docs[0]).toMatchObject({
      propertyId: PROPERTY_ID,
      propertyRevisionId: REVISION_ID,
      advertiserAccountId: ADVERTISER_ID,
      advertiserAccountTypeSnapshot: AccountType.USER,
      createdByActorId: expect.anything(),
      startingPriceMinor: 100_000,
      minimumBidStepMinor: 5_000,
      currency: 'EGP',
      status: AuctionStatus.SCHEDULED,
      scheduledStartAt: validInput().scheduledStartAt,
      scheduledEndAt: validInput().scheduledEndAt,
      currentEndAt: validInput().scheduledEndAt, // starts equal to scheduledEndAt; only anti-sniping (MAZAD-024) ever moves it
    });
    expect(Object.isFrozen(docs[0].ruleSnapshot)).toBe(true);
    expect(result.auction).toMatchObject({ status: AuctionStatus.SCHEDULED, currency: 'EGP', ruleSnapshotVersion: AUCTION_RULE_SNAPSHOT_VERSION_V1 });
    expect(audit.logRequired).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.AUCTION_CREATED, actorUserId: ACTOR_ID }), expect.anything());
  });

  it('rejects a malformed propertyId without looking up the property or the actor', async () => {
    const { instance, properties } = service();
    await expect(instance.create(ACTOR_ID, validInput({ propertyId: 'not-an-object-id' })))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.PROPERTY_NOT_ELIGIBLE }) });
    expect(properties.getEligibleForAuctionAnchor).not.toHaveBeenCalled();
  });

  it('rejects when the property is not an eligible auction anchor (pending review / hidden / archived / admin-hidden / missing — anything getEligibleForAuctionAnchor rejects)', async () => {
    const { instance, properties } = service({ anchor: null });
    await expect(instance.create(ACTOR_ID, validInput()))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.PROPERTY_NOT_ELIGIBLE }) });
    expect(properties.getEligibleForAuctionAnchor).toHaveBeenCalledWith(PROPERTY_ID);
  });

  it('rejects when the acting account does not exist', async () => {
    const { instance } = service({ actor: null });
    await expect(instance.create(ACTOR_ID, validInput()))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.ACTOR_INVALID }) });
  });

  it('denies a staff/admin account (AUCTION_CREATE_OWN is a marketplace-only capability)', async () => {
    const { instance } = service({ actor: marketplaceUser({ systemRole: SystemRole.ADMIN }) });
    await expect(forbiddenCode(() => instance.create(ACTOR_ID, validInput())))
      .resolves.toBe(AuthorizationErrorCode.ADMIN_MARKETPLACE_FORBIDDEN);
  });

  it('denies an unapproved broker, same as PROPERTY_CREATE', async () => {
    const { instance } = service({ actor: marketplaceUser({ accountType: AccountType.BROKER, brokerStatus: BrokerStatus.PENDING }) });
    await expect(forbiddenCode(() => instance.create(ACTOR_ID, validInput())))
      .resolves.toBe(AuthorizationErrorCode.BROKER_CAPABILITY_REQUIRED);
  });

  it('rejects an actor who is not the property\'s advertiser (self-service only, IDOR boundary)', async () => {
    const { instance, auctions } = service({ anchor: anchor({ advertiserAccountId: OTHER_ADVERTISER_ID }) });
    await expect(forbiddenCode(() => instance.create(ACTOR_ID, validInput())))
      .resolves.toBe(AuthorizationErrorCode.RESOURCE_ACCESS_FORBIDDEN);
    expect(auctions.create).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5])('rejects a non-positive/non-integer starting price (%p) before touching the database', async (value) => {
    const { instance, auctions } = service();
    await expect(instance.create(ACTOR_ID, validInput({ startingPriceMinor: value })))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.STARTING_PRICE_INVALID }) });
    expect(auctions.create).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5])('rejects a non-positive/non-integer minimum bid step (%p)', async (value) => {
    const { instance, auctions } = service();
    await expect(instance.create(ACTOR_ID, validInput({ minimumBidStepMinor: value })))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.MINIMUM_BID_STEP_INVALID }) });
    expect(auctions.create).not.toHaveBeenCalled();
  });

  it('rejects a schedule where the end is not after the start', async () => {
    const start = new Date('2026-03-01T00:00:00Z');
    const { instance, auctions } = service();
    await expect(instance.create(ACTOR_ID, validInput({ scheduledStartAt: start, scheduledEndAt: start })))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.SCHEDULE_INVALID }) });
    expect(auctions.create).not.toHaveBeenCalled();
  });

  it('never includes private property evidence or any evidence-shaped field in the created record or its summary', async () => {
    const { instance, createCalls } = service();
    const result = await instance.create(ACTOR_ID, validInput());
    const forbidden = /evidence|titledeed|deed/i;
    expect(Object.keys(createCalls[0]).some((key) => forbidden.test(key))).toBe(false);
    expect(Object.keys(result.auction).some((key) => forbidden.test(key))).toBe(false);
  });

  it('ends the Mongo session on the happy path', async () => {
    const { instance, session } = service();
    await instance.create(ACTOR_ID, validInput());
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it('ends the Mongo session even when the write inside the transaction fails', async () => {
    const { instance, session, auctions } = service();
    auctions.create.mockRejectedValueOnce(new Error('connection reset'));
    await expect(instance.create(ACTOR_ID, validInput())).rejects.toThrow('connection reset');
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });
});
