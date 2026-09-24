import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthorizationErrorCode } from '../src/authorization/authorization-error-codes';
import { SystemRole } from '../src/auth/roles.enum';
import { AccountStatus, AccountType, BrokerStatus } from '../src/users/identity.types';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';
import { AuctionErrorCode } from '../src/common/errors/auction-error-codes';
import {
  AUCTION_TRANSITIONS,
  assertValidAuctionTransition,
  isValidAuctionTransition,
} from '../src/auctions/auction-transitions';
import { AuctionStatus } from '../src/auctions/auction.types';
import { AuctionLifecycleService } from '../src/auctions/auction-lifecycle.service';
import { BidLedgerService } from '../src/bids/bid-ledger.service';
import { AuctionLifecycleWorker } from '../src/auctions/auction-lifecycle.worker';
import { AUCTION_BID_EXISTENCE_PORT, BidLedgerAuctionBidExistencePort } from '../src/auctions/auction-bid-existence.port';

/**
 * MAZAD-024 — Auction lifecycle, scheduling, property locking, cancellation
 * and the anti-sniping primitive. Covers the pure transition matrix, the
 * scheduling worker's activation/expiry primitives (boundary, idempotency,
 * concurrency), self-service cancellation, the anti-sniping extension
 * primitive's atomicity guarantees, and the background worker's timing/
 * concurrency shape. Bid acceptance, the Bid collection, and winner
 * determination are explicitly not covered here — they are MAZAD-026/027+.
 */

const ADVERTISER_ID = '64b000000000000000000601';
const OTHER_ADVERTISER_ID = '64b000000000000000000602';
const PROPERTY_ID = '64b000000000000000000701';
const AUCTION_ID = '64b000000000000000000801';
const NOW = new Date('2026-02-05T10:00:00Z');

function marketplaceUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: ADVERTISER_ID,
    systemRole: SystemRole.USER,
    accountType: AccountType.USER,
    accountStatus: AccountStatus.ACTIVE,
    brokerStatus: BrokerStatus.NOT_APPLIED,
    ...overrides,
  };
}

type FakeAuction = {
  _id: string;
  propertyId: string;
  advertiserAccountId: string;
  status: AuctionStatus;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  currentEndAt: Date;
  ruleSnapshot: { antiSnipingWindowSeconds: number; antiSnipingExtensionSeconds: number };
  cancelledByActorId?: string;
  cancelledAt?: Date;
  cancellationReason?: string;
};

function auctionDoc(overrides: Partial<FakeAuction> = {}): FakeAuction {
  return {
    _id: AUCTION_ID,
    propertyId: PROPERTY_ID,
    advertiserAccountId: ADVERTISER_ID,
    status: AuctionStatus.SCHEDULED,
    scheduledStartAt: new Date('2026-02-05T10:00:00Z'),
    scheduledEndAt: new Date('2026-02-12T10:00:00Z'),
    currentEndAt: new Date('2026-02-12T10:00:00Z'),
    ruleSnapshot: { antiSnipingWindowSeconds: 300, antiSnipingExtensionSeconds: 300 },
    ...overrides,
  };
}

function matchesFilter(doc: Record<string, any>, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (cond && typeof cond === 'object') {
      if ('$in' in cond) return (cond.$in as unknown[]).includes(value);
      if ('$lte' in cond) return value instanceof Date && value.getTime() <= (cond.$lte as Date).getTime();
      return true;
    }
    return value === cond;
  });
}

/** In-memory stand-in for the Mongoose `Auction` model, matching only the query shapes AuctionLifecycleService issues. */
function fakeAuctionCollection(seed: FakeAuction[]) {
  const docs = seed.map((doc) => ({ ...doc }));
  const findOneAndUpdateCalls: any[] = [];

  function sorted(candidates: FakeAuction[], sort?: Record<string, 1 | -1>) {
    if (!sort) return candidates;
    const [[field, dir]] = Object.entries(sort);
    return [...candidates].sort((a: any, b: any) => (dir === 1 ? a[field].getTime() - b[field].getTime() : b[field].getTime() - a[field].getTime()));
  }

  const model = {
    findOneAndUpdate: jest.fn((filter: Record<string, any>, update: any, options: any = {}) => ({
      exec: async () => {
        findOneAndUpdateCalls.push({ filter, update });
        const candidates = sorted(docs.filter((doc) => matchesFilter(doc, filter)), options.sort);
        const doc = candidates[0];
        if (!doc) return null;
        Object.assign(doc, update.$set ?? {});
        return { ...doc, toObject: () => ({ ...doc }) };
      },
    })),
    findOne: jest.fn((filter: Record<string, any>) => {
      let sort: Record<string, 1 | -1> | undefined;
      const chain: any = {
        sort: (s: any) => { sort = s; return chain; },
        select: () => chain,
        lean: () => chain,
        exec: async () => {
          const candidates = sorted(docs.filter((doc) => matchesFilter(doc, filter)), sort);
          return candidates[0] ? { ...candidates[0] } : null;
        },
      };
      return chain;
    }),
    findById: jest.fn((id: string) => {
      const chain: any = {
        session: () => chain,
        exec: async () => {
          const doc = docs.find((d) => d._id === id);
          return doc ? { ...doc, toObject: () => ({ ...doc }) } : null;
        },
      };
      return chain;
    }),
  };
  return { model, docs, findOneAndUpdateCalls };
}

function lifecycleService(options: {
  docs?: FakeAuction[];
  actor?: any;
  hasValidBids?: jest.Mock;
  now?: Date;
} = {}) {
  const store = fakeAuctionCollection(options.docs ?? [auctionDoc()]);
  const users = { findById: jest.fn(() => ({ lean: () => ({ exec: async () => (options.actor === undefined ? marketplaceUser() : options.actor) }) })) };
  const audit = { logRequired: jest.fn().mockResolvedValue(undefined), logSystemAction: jest.fn().mockResolvedValue(undefined) };
  const clock = { now: jest.fn(() => options.now ?? NOW) };
  const bidExistence = { hasValidBids: options.hasValidBids ?? jest.fn().mockResolvedValue(false) };
  const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn().mockResolvedValue(undefined) };
  const connection = { startSession: jest.fn().mockResolvedValue(session) };
  const instance = Object.create(AuctionLifecycleService.prototype) as any;
  Object.assign(instance, { auctions: store.model, users, audit, clock, bidExistence, connection });
  return { instance: instance as AuctionLifecycleService, store, users, audit, clock, bidExistence, session };
}

async function errorCode(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return ((error as ForbiddenException | BadRequestException | ConflictException | NotFoundException).getResponse() as { code?: string })?.code;
  }
}

describe('AUCTION_TRANSITIONS matrix (MAZAD-024)', () => {
  const ALL_STATUSES = Object.values(AuctionStatus);

  it.each([
    [AuctionStatus.SCHEDULED, AuctionStatus.ACTIVE],
    [AuctionStatus.SCHEDULED, AuctionStatus.CANCELLED],
    [AuctionStatus.ACTIVE, AuctionStatus.ENDED_PENDING_CLOSE],
    [AuctionStatus.ACTIVE, AuctionStatus.ENDED_NO_BIDS],
    [AuctionStatus.ACTIVE, AuctionStatus.CANCELLED],
    [AuctionStatus.ENDED_PENDING_CLOSE, AuctionStatus.COMPLETED],
  ])('allows %s -> %s', (from, to) => {
    expect(isValidAuctionTransition(from, to)).toBe(true);
    expect(() => assertValidAuctionTransition(from, to)).not.toThrow();
  });

  it('rejects every (from, to) pair not explicitly declared as legal', () => {
    const legal = new Set<string>();
    for (const [from, tos] of Object.entries(AUCTION_TRANSITIONS)) {
      for (const to of tos) legal.add(`${from}->${to}`);
    }
    const illegalPairs: Array<[AuctionStatus, AuctionStatus]> = [];
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (from === to) continue;
        if (!legal.has(`${from}->${to}`)) illegalPairs.push([from, to]);
      }
    }
    // Sanity: this set is non-trivial (otherwise the test below would be vacuous).
    expect(illegalPairs.length).toBeGreaterThan(10);
    for (const [from, to] of illegalPairs) {
      expect(isValidAuctionTransition(from, to)).toBe(false);
      expect(() => assertValidAuctionTransition(from, to)).toThrow(ConflictException);
    }
  });

  it.each([AuctionStatus.CANCELLED, AuctionStatus.COMPLETED, AuctionStatus.ENDED_NO_BIDS])(
    'never allows a transition out of the terminal status %s',
    (terminal) => {
      for (const to of ALL_STATUSES) {
        expect(isValidAuctionTransition(terminal, to)).toBe(false);
      }
    },
  );

  it('assertValidAuctionTransition throws a stable AUCTION_TRANSITION_INVALID code', async () => {
    expect(await errorCode(async () => assertValidAuctionTransition(AuctionStatus.COMPLETED, AuctionStatus.ACTIVE)))
      .toBe(AuctionErrorCode.TRANSITION_INVALID);
  });
});

describe('AuctionLifecycleService.activateDueAuctions (MAZAD-024)', () => {
  it('activates a SCHEDULED auction exactly at its scheduledStartAt boundary', async () => {
    const { instance, store, audit } = lifecycleService({
      docs: [auctionDoc({ scheduledStartAt: NOW })],
      now: NOW,
    });
    await expect(instance.activateDueAuctions()).resolves.toEqual({ activated: 1 });
    expect(store.docs[0].status).toBe(AuctionStatus.ACTIVE);
    expect(audit.logSystemAction).toHaveBeenCalledWith(AuditAction.AUCTION_ACTIVATED, AUCTION_ID, expect.any(String), expect.anything());
  });

  it('does not activate a SCHEDULED auction one millisecond before its start', async () => {
    const { instance, store, audit } = lifecycleService({
      docs: [auctionDoc({ scheduledStartAt: new Date(NOW.getTime() + 1) })],
      now: NOW,
    });
    await expect(instance.activateDueAuctions()).resolves.toEqual({ activated: 0 });
    expect(store.docs[0].status).toBe(AuctionStatus.SCHEDULED);
    expect(audit.logSystemAction).not.toHaveBeenCalled();
  });

  it('activates a SCHEDULED auction whose start has already passed', async () => {
    const { instance, store } = lifecycleService({
      docs: [auctionDoc({ scheduledStartAt: new Date(NOW.getTime() - 3_600_000) })],
      now: NOW,
    });
    await expect(instance.activateDueAuctions()).resolves.toEqual({ activated: 1 });
    expect(store.docs[0].status).toBe(AuctionStatus.ACTIVE);
  });

  it('is idempotent: a second run finds nothing left to activate', async () => {
    const { instance } = lifecycleService({ docs: [auctionDoc({ scheduledStartAt: NOW })], now: NOW });
    await expect(instance.activateDueAuctions()).resolves.toEqual({ activated: 1 });
    await expect(instance.activateDueAuctions()).resolves.toEqual({ activated: 0 });
  });

  it('processes every due auction in a batch, one atomic claim per document', async () => {
    const { instance, store } = lifecycleService({
      docs: [
        auctionDoc({ _id: 'a1', scheduledStartAt: NOW }),
        auctionDoc({ _id: 'a2', scheduledStartAt: new Date(NOW.getTime() - 1000) }),
        auctionDoc({ _id: 'a3', scheduledStartAt: new Date(NOW.getTime() + 1000) }), // not due
      ],
      now: NOW,
    });
    await expect(instance.activateDueAuctions()).resolves.toEqual({ activated: 2 });
    expect(store.docs.find((d) => d._id === 'a1')!.status).toBe(AuctionStatus.ACTIVE);
    expect(store.docs.find((d) => d._id === 'a2')!.status).toBe(AuctionStatus.ACTIVE);
    expect(store.docs.find((d) => d._id === 'a3')!.status).toBe(AuctionStatus.SCHEDULED);
  });

  it('never touches an auction that is due but already in a non-SCHEDULED status (stale/conditional protection)', async () => {
    const { instance, store, audit } = lifecycleService({
      docs: [auctionDoc({ status: AuctionStatus.CANCELLED, scheduledStartAt: new Date(NOW.getTime() - 1000) })],
      now: NOW,
    });
    await expect(instance.activateDueAuctions()).resolves.toEqual({ activated: 0 });
    expect(store.docs[0].status).toBe(AuctionStatus.CANCELLED);
    expect(audit.logSystemAction).not.toHaveBeenCalled();
  });

  it('respects the batch limit', async () => {
    const docs = Array.from({ length: 5 }, (_, i) => auctionDoc({ _id: `a${i}`, scheduledStartAt: NOW }));
    const { instance } = lifecycleService({ docs, now: NOW });
    await expect(instance.activateDueAuctions(2)).resolves.toEqual({ activated: 2 });
  });
});

describe('AuctionLifecycleService.expireDueAuctions (MAZAD-024)', () => {
  it('ends an ACTIVE auction with no bids exactly at its currentEndAt boundary', async () => {
    const { instance, store, audit } = lifecycleService({
      docs: [auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: NOW })],
      now: NOW,
    });
    await expect(instance.expireDueAuctions()).resolves.toEqual({ endedNoBids: 1, endedPendingClose: 0 });
    expect(store.docs[0].status).toBe(AuctionStatus.ENDED_NO_BIDS);
    expect(audit.logSystemAction).toHaveBeenCalledWith(AuditAction.AUCTION_ENDED_NO_BIDS, AUCTION_ID, expect.any(String), expect.anything());
  });

  it('does not end an ACTIVE auction one millisecond before currentEndAt', async () => {
    const { instance, store, audit } = lifecycleService({
      docs: [auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: new Date(NOW.getTime() + 1) })],
      now: NOW,
    });
    await expect(instance.expireDueAuctions()).resolves.toEqual({ endedNoBids: 0, endedPendingClose: 0 });
    expect(store.docs[0].status).toBe(AuctionStatus.ACTIVE);
    expect(audit.logSystemAction).not.toHaveBeenCalled();
  });

  it('routes to ENDED_PENDING_CLOSE when the bid-existence port reports a valid bid', async () => {
    const { instance, store, audit, bidExistence } = lifecycleService({
      docs: [auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: NOW })],
      now: NOW,
      hasValidBids: jest.fn().mockResolvedValue(true),
    });
    await expect(instance.expireDueAuctions()).resolves.toEqual({ endedNoBids: 0, endedPendingClose: 1 });
    expect(store.docs[0].status).toBe(AuctionStatus.ENDED_PENDING_CLOSE);
    expect(bidExistence.hasValidBids).toHaveBeenCalledWith(AUCTION_ID);
    expect(audit.logSystemAction).toHaveBeenCalledWith(AuditAction.AUCTION_ENDED_PENDING_CLOSE, AUCTION_ID, expect.any(String), expect.anything());
  });

  it('is idempotent: a second run finds nothing left to expire', async () => {
    const { instance } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: NOW })], now: NOW });
    await expect(instance.expireDueAuctions()).resolves.toEqual({ endedNoBids: 1, endedPendingClose: 0 });
    await expect(instance.expireDueAuctions()).resolves.toEqual({ endedNoBids: 0, endedPendingClose: 0 });
  });

  it('skips a document that raced away from ACTIVE between the claim read and the commit, without erroring', async () => {
    const doc = auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: NOW });
    const { instance, store, audit } = lifecycleService({
      docs: [doc],
      now: NOW,
      hasValidBids: jest.fn(async () => {
        // Simulate a concurrent cancellation landing between the read and the conditional write.
        store.docs[0].status = AuctionStatus.CANCELLED;
        return false;
      }),
    });
    await expect(instance.expireDueAuctions()).resolves.toEqual({ endedNoBids: 0, endedPendingClose: 0 });
    expect(store.docs[0].status).toBe(AuctionStatus.CANCELLED);
    expect(audit.logSystemAction).not.toHaveBeenCalled();
  });

  it('processes every due auction in a batch', async () => {
    const { instance, store } = lifecycleService({
      docs: [
        auctionDoc({ _id: 'a1', status: AuctionStatus.ACTIVE, currentEndAt: NOW }),
        auctionDoc({ _id: 'a2', status: AuctionStatus.ACTIVE, currentEndAt: new Date(NOW.getTime() - 1000) }),
        auctionDoc({ _id: 'a3', status: AuctionStatus.ACTIVE, currentEndAt: new Date(NOW.getTime() + 1000) }), // not due
      ],
      now: NOW,
    });
    await expect(instance.expireDueAuctions()).resolves.toEqual({ endedNoBids: 2, endedPendingClose: 0 });
    expect(store.docs.find((d) => d._id === 'a3')!.status).toBe(AuctionStatus.ACTIVE);
  });
});

describe('AuctionLifecycleService.cancel (MAZAD-024)', () => {
  it('cancels a SCHEDULED auction without requiring a reason', async () => {
    const { instance, store, audit } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.SCHEDULED })] });
    const result = await instance.cancel(ADVERTISER_ID, AUCTION_ID, undefined);
    expect(store.docs[0].status).toBe(AuctionStatus.CANCELLED);
    expect(store.docs[0].cancelledByActorId!.toString()).toBe(ADVERTISER_ID);
    expect(result.auction.status).toBe(AuctionStatus.CANCELLED);
    expect(audit.logRequired).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AUCTION_CANCELLED, actorUserId: ADVERTISER_ID, targetResourceId: AUCTION_ID }),
      expect.anything(),
    );
  });

  it('rejects an ACTIVE cancellation without a reason', async () => {
    const { instance, store } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE })] });
    await expect(instance.cancel(ADVERTISER_ID, AUCTION_ID, undefined))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.CANCELLATION_REASON_REQUIRED }) });
    expect(store.docs[0].status).toBe(AuctionStatus.ACTIVE);
  });

  it('rejects an ACTIVE cancellation with a blank/whitespace-only reason', async () => {
    const { instance } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE })] });
    await expect(instance.cancel(ADVERTISER_ID, AUCTION_ID, '   '))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.CANCELLATION_REASON_REQUIRED }) });
  });

  it('cancels an ACTIVE auction when a reason is given and stores it', async () => {
    const { instance, store } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE })] });
    await instance.cancel(ADVERTISER_ID, AUCTION_ID, 'تغيرت ظروف المالك');
    expect(store.docs[0].status).toBe(AuctionStatus.CANCELLED);
    expect(store.docs[0].cancellationReason).toBe('تغيرت ظروف المالك');
    expect(store.docs[0].cancelledAt).toBeInstanceOf(Date);
  });

  it.each([AuctionStatus.ENDED_NO_BIDS, AuctionStatus.COMPLETED, AuctionStatus.CANCELLED])(
    'rejects cancelling an auction that is already terminal (%s)',
    async (status) => {
      const { instance, store } = lifecycleService({ docs: [auctionDoc({ status })] });
      await expect(instance.cancel(ADVERTISER_ID, AUCTION_ID, 'reason'))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.TRANSITION_INVALID }) });
      expect(store.docs[0].status).toBe(status);
    },
  );

  it('denies an actor who is not the auction\'s advertiser (IDOR boundary)', async () => {
    const { instance, store } = lifecycleService({
      docs: [auctionDoc({ advertiserAccountId: OTHER_ADVERTISER_ID })],
    });
    expect(await errorCode(() => instance.cancel(ADVERTISER_ID, AUCTION_ID, undefined))).toBe(AuthorizationErrorCode.RESOURCE_ACCESS_FORBIDDEN);
    expect(store.docs[0].status).toBe(AuctionStatus.SCHEDULED);
  });

  it('denies a staff/admin account (no admin marketplace-participation model exists for auctions)', async () => {
    const { instance } = lifecycleService({ actor: marketplaceUser({ systemRole: SystemRole.ADMIN }) });
    expect(await errorCode(() => instance.cancel(ADVERTISER_ID, AUCTION_ID, undefined))).toBe(AuthorizationErrorCode.RESOURCE_ACCESS_FORBIDDEN);
  });

  it('rejects a malformed auctionId without any lookup', async () => {
    const { instance, store } = lifecycleService();
    await expect(instance.cancel(ADVERTISER_ID, 'not-an-object-id', undefined))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.NOT_FOUND }) });
    expect(store.model.findById).not.toHaveBeenCalled();
  });

  it('rejects a nonexistent auction', async () => {
    const { instance } = lifecycleService({ docs: [] });
    await expect(instance.cancel(ADVERTISER_ID, AUCTION_ID, undefined))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.NOT_FOUND }) });
  });

  it('rejects when the acting account does not exist', async () => {
    const { instance } = lifecycleService({ actor: null });
    await expect(instance.cancel(ADVERTISER_ID, AUCTION_ID, undefined))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.ACTOR_INVALID }) });
  });

  it('surfaces a state conflict (not a silent no-op) when the status changes between read and commit', async () => {
    const { instance, store } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.SCHEDULED })] });
    // Simulate a worker racing the cancel: flip status after the initial read, before the conditional write commits.
    const originalFindOneAndUpdate = store.model.findOneAndUpdate.getMockImplementation()!;
    store.model.findOneAndUpdate.mockImplementationOnce((filter: any, update: any, options: any) => ({
      exec: async () => {
        store.docs[0].status = AuctionStatus.ACTIVE; // raced away from SCHEDULED
        return originalFindOneAndUpdate(filter, update, options).exec();
      },
    }));
    await expect(instance.cancel(ADVERTISER_ID, AUCTION_ID, undefined))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.STATE_CONFLICT }) });
  });

  it('never creates a new document — the cancelled auction keeps its own id (re-auction is a separate creation flow)', async () => {
    const { instance } = lifecycleService({ docs: [auctionDoc()] });
    const result = await instance.cancel(ADVERTISER_ID, AUCTION_ID, undefined);
    expect(result.auction.id).toBe(AUCTION_ID);
  });

  it('ends the session even when the transaction fails', async () => {
    const { instance, session, store } = lifecycleService({ docs: [] });
    await expect(instance.cancel(ADVERTISER_ID, AUCTION_ID, undefined)).rejects.toBeDefined();
    // NOT_FOUND is thrown before a session even starts here; verify the happy path also closes it.
    const withDoc = lifecycleService({ docs: [auctionDoc()] });
    await withDoc.instance.cancel(ADVERTISER_ID, AUCTION_ID, undefined);
    expect(withDoc.session.endSession).toHaveBeenCalledTimes(1);
  });
});

describe('AuctionLifecycleService.extendIfWithinAntiSnipingWindow (MAZAD-024)', () => {
  const endAt = new Date('2026-02-12T10:00:00Z'); // window/extension = 300s (5 min)

  it('extends when a bid lands exactly at the anti-sniping threshold (remaining == window)', async () => {
    const bidAt = new Date(endAt.getTime() - 300_000);
    const { instance, store } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: endAt })] });
    const result = await instance.extendIfWithinAntiSnipingWindow(AUCTION_ID, bidAt);
    expect(result.extended).toBe(true);
    expect(result.currentEndAt.getTime()).toBe(endAt.getTime() + 300_000);
    expect(store.docs[0].currentEndAt.getTime()).toBe(endAt.getTime() + 300_000);
  });

  it('does not extend when a bid lands one second outside the window', async () => {
    const bidAt = new Date(endAt.getTime() - 301_000);
    const { instance, store } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: endAt })] });
    const result = await instance.extendIfWithinAntiSnipingWindow(AUCTION_ID, bidAt);
    expect(result.extended).toBe(false);
    expect(result.currentEndAt.getTime()).toBe(endAt.getTime());
    expect(store.docs[0].currentEndAt.getTime()).toBe(endAt.getTime());
  });

  it('extends when a bid lands well inside the window', async () => {
    const bidAt = new Date(endAt.getTime() - 30_000);
    const { instance } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: endAt })] });
    await expect(instance.extendIfWithinAntiSnipingWindow(AUCTION_ID, bidAt)).resolves.toMatchObject({ extended: true });
  });

  it('extends repeatedly with no cap, each extension measured from the *current* (already-extended) end', async () => {
    const { instance, store } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: endAt })] });
    const firstBidAt = new Date(endAt.getTime() - 60_000);
    await instance.extendIfWithinAntiSnipingWindow(AUCTION_ID, firstBidAt);
    const afterFirst = store.docs[0].currentEndAt.getTime();
    expect(afterFirst).toBe(endAt.getTime() + 300_000);

    // A second bid lands within 5 minutes of the *new* end, not the original.
    const secondBidAt = new Date(afterFirst - 60_000);
    await instance.extendIfWithinAntiSnipingWindow(AUCTION_ID, secondBidAt);
    expect(store.docs[0].currentEndAt.getTime()).toBe(afterFirst + 300_000);
  });

  it('never shortens currentEndAt', async () => {
    const { instance, store } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: endAt })] });
    const before = store.docs[0].currentEndAt.getTime();
    await instance.extendIfWithinAntiSnipingWindow(AUCTION_ID, new Date(endAt.getTime() - 1000));
    expect(store.docs[0].currentEndAt.getTime()).toBeGreaterThan(before);
  });

  it.each([AuctionStatus.SCHEDULED, AuctionStatus.ENDED_PENDING_CLOSE, AuctionStatus.ENDED_NO_BIDS, AuctionStatus.COMPLETED, AuctionStatus.CANCELLED])(
    'never extends once the auction has left ACTIVE (%s)',
    async (status) => {
      const { instance, store } = lifecycleService({ docs: [auctionDoc({ status, currentEndAt: endAt })] });
      const result = await instance.extendIfWithinAntiSnipingWindow(AUCTION_ID, new Date(endAt.getTime() - 1000));
      expect(result.extended).toBe(false);
      expect(store.model.findOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  it('leaves the immutable ruleSnapshot untouched — only currentEndAt moves', async () => {
    const { instance, store } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: endAt })] });
    const snapshotBefore = { ...store.docs[0].ruleSnapshot };
    await instance.extendIfWithinAntiSnipingWindow(AUCTION_ID, new Date(endAt.getTime() - 1000));
    expect(store.docs[0].ruleSnapshot).toEqual(snapshotBefore);
  });

  it('reports extended:false (not an error) when a concurrent write races the compare-and-swap', async () => {
    const { instance, store } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: endAt })] });
    store.model.findOneAndUpdate.mockImplementationOnce(() => ({ exec: async () => null }));
    const result = await instance.extendIfWithinAntiSnipingWindow(AUCTION_ID, new Date(endAt.getTime() - 1000));
    expect(result.extended).toBe(false);
  });

  it('rejects a malformed or nonexistent auction id', async () => {
    const { instance } = lifecycleService({ docs: [] });
    await expect(instance.extendIfWithinAntiSnipingWindow('not-an-object-id', new Date()))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.NOT_FOUND }) });
    await expect(instance.extendIfWithinAntiSnipingWindow(AUCTION_ID, new Date()))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: AuctionErrorCode.NOT_FOUND }) });
  });

  it('audits the extension exactly once on success and never when not extended', async () => {
    const { instance, audit } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: endAt })] });
    await instance.extendIfWithinAntiSnipingWindow(AUCTION_ID, new Date(endAt.getTime() - 1000));
    expect(audit.logSystemAction).toHaveBeenCalledTimes(1);
    expect(audit.logSystemAction).toHaveBeenCalledWith(AuditAction.AUCTION_END_TIME_EXTENDED, AUCTION_ID, expect.any(String), expect.anything());

    const outside = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE, currentEndAt: endAt })] });
    await outside.instance.extendIfWithinAntiSnipingWindow(AUCTION_ID, new Date(endAt.getTime() - 400_000));
    expect(outside.audit.logSystemAction).not.toHaveBeenCalled();
  });
});

describe('AuctionLifecycleWorker (MAZAD-024)', () => {
  const config = (values: Record<string, string> = {}) => ({ get: (key: string) => values[key] }) as any;
  const zero = { activated: 0, endedNoBids: 0, endedPendingClose: 0 };

  function build(values: Record<string, string> = {}, overrides: Partial<Record<'activate' | 'expire', jest.Mock>> = {}) {
    const lifecycle = {
      activateDueAuctions: overrides.activate ?? jest.fn().mockResolvedValue({ activated: 0 }),
      expireDueAuctions: overrides.expire ?? jest.fn().mockResolvedValue({ endedNoBids: 0, endedPendingClose: 0 }),
    };
    const worker = new AuctionLifecycleWorker(lifecycle as any, config(values));
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (worker as any).logger = logger;
    return { worker, lifecycle, logger };
  }

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('is off under test by default and on otherwise, and can be forced either way', () => {
    expect(build({ NODE_ENV: 'test' }).worker.enabled).toBe(false);
    expect(build({ NODE_ENV: 'production' }).worker.enabled).toBe(true);
    expect(build({ NODE_ENV: 'production', AUCTION_LIFECYCLE_WORKER_ENABLED: 'false' }).worker.enabled).toBe(false);
    expect(build({ NODE_ENV: 'test', AUCTION_LIFECYCLE_WORKER_ENABLED: 'true' }).worker.enabled).toBe(true);
  });

  it('never runs two passes at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const activate = jest.fn(async () => { await gate; return { activated: 0 }; });
    const { worker } = build({}, { activate });

    const first = worker.runOnce();
    await expect(worker.runOnce()).resolves.toBeNull();
    expect(activate).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toEqual(zero);
    await expect(worker.runOnce()).resolves.not.toBeNull();
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('survives a failed pass and recovers on the next one', async () => {
    const activate = jest.fn()
      .mockRejectedValueOnce(new Error('mongo down'))
      .mockResolvedValue({ activated: 0 });
    const { worker, logger } = build({}, { activate });

    await expect(worker.runOnce()).resolves.toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
    await expect(worker.runOnce()).resolves.toEqual(zero);
    expect(worker.lastRunAt).toBeInstanceOf(Date);
  });

  it('logs only when something actually transitioned, and stays quiet on an idle tick', async () => {
    const active = build({}, { activate: jest.fn().mockResolvedValue({ activated: 2 }) });
    await active.worker.runOnce();
    expect(active.logger.log).toHaveBeenCalledTimes(1);

    const idle = build();
    await idle.worker.runOnce();
    expect(idle.logger.log).not.toHaveBeenCalled();
    expect(idle.logger.error).not.toHaveBeenCalled();
  });

  it('honours the configured batch size for both activation and expiry, capped at 200', async () => {
    const small = build({ AUCTION_LIFECYCLE_BATCH_SIZE: '7' });
    await small.worker.runOnce();
    expect(small.lifecycle.activateDueAuctions).toHaveBeenCalledWith(7);
    expect(small.lifecycle.expireDueAuctions).toHaveBeenCalledWith(7);
    const huge = build({ AUCTION_LIFECYCLE_BATCH_SIZE: '99999' });
    await huge.worker.runOnce();
    expect(huge.lifecycle.activateDueAuctions).toHaveBeenCalledWith(200);
  });

  it('schedules itself on bootstrap, repeats on the interval, and stops cleanly on shutdown', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // first run after 5s + 2.5s jitter
    const { worker, lifecycle } = build({ NODE_ENV: 'production', AUCTION_LIFECYCLE_INTERVAL_SECONDS: '30' });
    worker.onApplicationBootstrap();

    await jest.advanceTimersByTimeAsync(7_499);
    expect(lifecycle.activateDueAuctions).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2);
    expect(lifecycle.activateDueAuctions).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(lifecycle.activateDueAuctions).toHaveBeenCalledTimes(2);

    await worker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(lifecycle.activateDueAuctions).toHaveBeenCalledTimes(2);
  });

  it('does not start a timer when disabled', async () => {
    jest.useFakeTimers();
    const { worker, lifecycle, logger } = build({ NODE_ENV: 'production', AUCTION_LIFECYCLE_WORKER_ENABLED: 'false' });
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(lifecycle.activateDueAuctions).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  it('waits for an in-flight pass during shutdown', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { worker } = build({}, { activate: jest.fn(async () => { await gate; return { activated: 0 }; }) });
    const run = worker.runOnce();
    let stopped = false;
    const stopping = worker.onModuleDestroy().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    await run;
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe('AuctionLifecycleWorker dependency wiring', () => {
  it('resolves inside a real Nest provider graph and follows Nest lifecycle hooks', async () => {
    const { Test } = await import('@nestjs/testing');
    const { ConfigModule } = await import('@nestjs/config');
    const { getModelToken, getConnectionToken } = await import('@nestjs/mongoose');
    const { Auction } = await import('../src/auctions/schemas/auction.schema');
    const { User } = await import('../src/users/schemas/user.schema');
    const { AuditLogService } = await import('../src/audit/audit-log.service');
    const { ClockService } = await import('../src/common/time/clock.service');

    const auctionModel = {
      findOneAndUpdate: jest.fn(() => ({ exec: async () => null })),
      findOne: jest.fn(() => ({ sort: () => ({ select: () => ({ lean: () => ({ exec: async () => null }) }) }) })),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, load: [() => ({ NODE_ENV: 'test' })] })],
      providers: [
        { provide: getModelToken(Auction.name), useValue: auctionModel },
        { provide: getModelToken(User.name), useValue: {} },
        { provide: getConnectionToken(), useValue: {} },
        { provide: AuditLogService, useValue: { logSystemAction: jest.fn(), logRequired: jest.fn() } },
        ClockService,
        { provide: BidLedgerService, useValue: { hasAcceptedBids: async () => false } },
        { provide: AUCTION_BID_EXISTENCE_PORT, useClass: BidLedgerAuctionBidExistencePort },
        AuctionLifecycleService,
        AuctionLifecycleWorker,
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.init(); // runs onApplicationBootstrap: disabled under NODE_ENV=test, so no timer is armed
    const worker = moduleRef.get(AuctionLifecycleWorker);
    expect(worker.enabled).toBe(false);
    await expect(worker.runOnce()).resolves.toMatchObject({ activated: 0, endedNoBids: 0, endedPendingClose: 0 });
    await app.close(); // runs onModuleDestroy
  });
});

describe('AuctionLifecycleService.cancel optimistic expectedStatus (MAZAD-025)', () => {
  it('cancels normally when expectedStatus matches the current status', async () => {
    const { instance, store } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.SCHEDULED })] });
    await instance.cancel(ADVERTISER_ID, AUCTION_ID, undefined, undefined, AuctionStatus.SCHEDULED);
    expect(store.docs[0].status).toBe(AuctionStatus.CANCELLED);
  });

  it('fails with AUCTION_STATE_CONFLICT — and changes/audits nothing — when the auction moved past the status the client saw', async () => {
    const { instance, store, audit, session } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE })] });
    expect(await errorCode(() => instance.cancel(ADVERTISER_ID, AUCTION_ID, undefined, undefined, AuctionStatus.SCHEDULED)))
      .toBe(AuctionErrorCode.STATE_CONFLICT);
    expect(store.docs[0].status).toBe(AuctionStatus.ACTIVE);
    expect(audit.logRequired).not.toHaveBeenCalled();
    expect(session.withTransaction).not.toHaveBeenCalled();
  });

  it('still enforces ownership before the optimistic check', async () => {
    const { instance } = lifecycleService({ docs: [auctionDoc({ advertiserAccountId: OTHER_ADVERTISER_ID })] });
    expect(await errorCode(() => instance.cancel(ADVERTISER_ID, AUCTION_ID, undefined, undefined, AuctionStatus.ACTIVE)))
      .toBe(AuthorizationErrorCode.RESOURCE_ACCESS_FORBIDDEN);
  });

  it('a terminal auction stays terminal even when the client\'s expectedStatus is right', async () => {
    const { instance } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.CANCELLED })] });
    expect(await errorCode(() => instance.cancel(ADVERTISER_ID, AUCTION_ID, 'x', undefined, AuctionStatus.CANCELLED)))
      .toBe(AuctionErrorCode.TRANSITION_INVALID);
  });
});

describe('lifecycle expiry with the Bid-ledger-backed port (MAZAD-026)', () => {
  const EXPIRED = { status: AuctionStatus.ACTIVE, currentEndAt: new Date('2026-02-05T09:59:59Z') };

  function ledgerBackedPort(bidAuctionIds: string[]) {
    const ledger = { hasAcceptedBids: jest.fn(async (id: string) => bidAuctionIds.includes(id)) };
    return new BidLedgerAuctionBidExistencePort(ledger as any);
  }

  it('an expired ACTIVE auction with no persisted bids ends as ENDED_NO_BIDS', async () => {
    const port = ledgerBackedPort([]);
    const { instance, store, audit } = lifecycleService({ docs: [auctionDoc(EXPIRED)], hasValidBids: jest.fn((id: string) => port.hasValidBids(id)) });
    await expect(instance.expireDueAuctions()).resolves.toEqual({ endedNoBids: 1, endedPendingClose: 0 });
    expect(store.docs[0].status).toBe(AuctionStatus.ENDED_NO_BIDS);
    expect(audit.logSystemAction).toHaveBeenCalledWith(AuditAction.AUCTION_ENDED_NO_BIDS, AUCTION_ID, expect.any(String), expect.anything());
  });

  it('an expired ACTIVE auction with a persisted bid ends as ENDED_PENDING_CLOSE — never COMPLETED, no winner set', async () => {
    const port = ledgerBackedPort([AUCTION_ID]);
    const { instance, store, audit } = lifecycleService({ docs: [auctionDoc(EXPIRED)], hasValidBids: jest.fn((id: string) => port.hasValidBids(id)) });
    await expect(instance.expireDueAuctions()).resolves.toEqual({ endedNoBids: 0, endedPendingClose: 1 });
    expect(store.docs[0].status).toBe(AuctionStatus.ENDED_PENDING_CLOSE);
    expect((store.docs[0] as any).winnerAccountId).toBeUndefined();
    expect(audit.logSystemAction).toHaveBeenCalledWith(AuditAction.AUCTION_ENDED_PENDING_CLOSE, AUCTION_ID, expect.any(String), expect.anything());
  });

  it('a second worker pass is a no-op either way (idempotent)', async () => {
    const port = ledgerBackedPort([AUCTION_ID]);
    const { instance, audit } = lifecycleService({ docs: [auctionDoc(EXPIRED)], hasValidBids: jest.fn((id: string) => port.hasValidBids(id)) });
    await instance.expireDueAuctions();
    await expect(instance.expireDueAuctions()).resolves.toEqual({ endedNoBids: 0, endedPendingClose: 0 });
    expect(audit.logSystemAction).toHaveBeenCalledTimes(1);
  });
});

describe('extendIfWithinAntiSnipingWindow inside a caller transaction (MAZAD-027)', () => {
  it('extends but leaves auditing to the caller: no best-effort audit for an extension a rollback could still discard', async () => {
    const { instance, store, audit } = lifecycleService({ docs: [auctionDoc({ status: AuctionStatus.ACTIVE })] });
    const bidAt = new Date(auctionDoc().currentEndAt.getTime() - 60_000);
    const result = await instance.extendIfWithinAntiSnipingWindow(AUCTION_ID, bidAt, { session: { id: 'txn' } as any });
    expect(result.extended).toBe(true);
    expect(store.docs[0].currentEndAt.getTime()).toBe(auctionDoc().currentEndAt.getTime() + 300_000);
    expect(audit.logSystemAction).not.toHaveBeenCalled();
  });
});
