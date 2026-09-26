import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AuctionBidAcceptanceService, BID_ACCEPTANCE_MAX_ATTEMPTS } from '../src/auctions/auction-bid-acceptance.service';
import { AUCTION_BID_ENTITLEMENT_PORT, AuctionBidEntitlementPort, FailClosedBidEntitlementPort } from '../src/auctions/auction-bid-entitlement.port';
import { BidLedgerAuctionBidExistencePort } from '../src/auctions/auction-bid-existence.port';
import { AuctionLifecycleService } from '../src/auctions/auction-lifecycle.service';
import { AuctionsController } from '../src/auctions/auctions.controller';
import { AuctionStatus } from '../src/auctions/auction.types';
import { PersistentBidEntitlementPort } from '../src/payments/persistent-bid-entitlement.port';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';
import { SystemRole } from '../src/auth/roles.enum';
import { AuthorizationErrorCode } from '../src/authorization/authorization-error-codes';
import { BidLedgerService } from '../src/bids/bid-ledger.service';
import { AuctionErrorCode } from '../src/common/errors/auction-error-codes';
import { BidErrorCode } from '../src/common/errors/bid-error-codes';
import { MONEY_MINOR_MAX } from '../src/common/money/money';
import { AccountStatus, AccountType, BrokerStatus } from '../src/users/identity.types';
import { FakeOutboxStore, outboxDuplicateVersion } from './support/fake-outbox';

/**
 * MAZAD-027 — atomic bid acceptance, tested against `FakeMongo`: an
 * in-memory model of the MongoDB behaviours the algorithm's correctness
 * rests on — snapshot reads per transaction, single-writer-per-document
 * with WriteConflict (a transient, retryable error) for the loser, a
 * stale-snapshot check at commit, unique `(auctionId, sequence)` enforcement,
 * abort discarding every buffered write, and non-transactional writers
 * waiting on an in-flight transaction's document lock. It is a model, not
 * MongoDB: the real transaction/unique-index behaviour still needs a
 * disposable-Mongo integration run during release qualification.
 */

const oid = (hex: string) => new Types.ObjectId(hex);
const AUCTION = '64b000000000000000000f01';
const ADVERTISER = '64b000000000000000000a10';
const ALICE = '64b000000000000000000a11';
const BOB = '64b000000000000000000a12';
const CAROL = '64b000000000000000000a13';
const ADMIN = '64b000000000000000000a20';
const SUPER = '64b000000000000000000a21';
const SUSPENDED = '64b000000000000000000a22';
const BROKER_OK = '64b000000000000000000a23';
const BROKER_PENDING = '64b000000000000000000a24';
const COMPANY = '64b000000000000000000a25';
const START = new Date('2026-05-01T10:00:00Z');
const END = new Date('2026-05-08T10:00:00Z');
const MIN = 60_000;
const OPEN_NOW = new Date(END.getTime() - 2 * 24 * 60 * MIN); // well before the anti-sniping window

const tick = () => Promise.resolve();
const ticks = async (n = 25) => { for (let i = 0; i < n; i++) await tick(); };
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const transient = (message: string) => Object.assign(new Error(message), { code: 112, hasErrorLabel: (l: string) => l === 'TransientTransactionError' });
const dupKey = () => Object.assign(new Error('E11000 duplicate key bid_auction_sequence'), { code: 11000, keyPattern: { auctionId: 1, sequence: 1 } });

const same = (a: any, b: any) => String(a.bidderAccountId) === String(b.bidderAccountId) && String(a.auctionId) === String(b.auctionId) && a.keyHash === b.keyHash;

type Txn = { id: number; active: boolean; snapAuctions: Map<string, { doc: any; version: number }>; snapBids: any[]; writes: Map<string, any>; bids: any[]; audits: any[]; reqs: any[] };

class FakeMongo {
  auctions = new Map<string, { doc: any; version: number }>();
  bids: any[] = [];
  bidRequests: any[] = [];
  audits: any[] = [];
  users = new Map<string, any>();
  locks = new Map<string, number>();
  clockNow = OPEN_NOW;
  nextTxn = 1;
  hooks: { beforeAuctionWrite?: () => Promise<void>; beforeBidInsert?: () => Promise<void>; bidInsertError?: () => Error | undefined; auditError?: () => Error | undefined; commitError?: () => Error | undefined } = {};
  transactionsStarted = 0;
  commits = 0;
  /** MAZAD-031: outbox rows follow this fake's session commit/abort. */
  outbox = new FakeOutboxStore();

  seedAuction(overrides: Record<string, unknown> = {}) {
    const doc = {
      _id: oid(AUCTION), propertyId: oid('64b000000000000000000b01'), advertiserAccountId: oid(ADVERTISER),
      status: AuctionStatus.ACTIVE, startingPriceMinor: 100_000, minimumBidStepMinor: 5_000,
      scheduledStartAt: START, scheduledEndAt: END, currentEndAt: END, acceptedBidCount: 0,
      ruleSnapshot: { antiSnipingWindowSeconds: 300, antiSnipingExtensionSeconds: 300 },
      ...overrides,
    };
    this.auctions.set(doc._id.toString(), { doc, version: 1 });
    return doc;
  }
  seedUser(id: string, overrides: Record<string, unknown> = {}) {
    this.users.set(id, { _id: oid(id), systemRole: SystemRole.USER, accountType: AccountType.USER, accountStatus: AccountStatus.ACTIVE, brokerStatus: BrokerStatus.NOT_APPLIED, ...overrides });
  }
  committedAuction(id = AUCTION) { return this.auctions.get(id)!.doc; }

  private view(txn: Txn | undefined, id: string) {
    if (!txn) return this.auctions.get(id)?.doc;
    return txn.writes.get(id) ?? txn.snapAuctions.get(id)?.doc;
  }
  private bidView(txn?: Txn) { return txn ? [...txn.snapBids, ...txn.bids] : this.bids; }

  // ---- connection / sessions ----
  connection = {
    startSession: async () => {
      const mongo = this;
      let txn: Txn | undefined;
      const session: any = {
        get txn() { return txn; },
        startTransaction() {
          mongo.transactionsStarted++;
          txn = {
            id: mongo.nextTxn++, active: true, writes: new Map(), bids: [], audits: [], reqs: [], snapBids: [...mongo.bids],
            snapAuctions: new Map([...mongo.auctions].map(([k, v]) => [k, { doc: { ...v.doc }, version: v.version }])),
          };
        },
        inTransaction: () => Boolean(txn?.active),
        async commitTransaction() {
          await ticks(3);
          const error = mongo.hooks.commitError?.();
          if (error) throw error;
          const t = txn!;
          for (const id of t.writes.keys()) {
            if (mongo.auctions.get(id)!.version !== t.snapAuctions.get(id)!.version) { mongo.release(t); t.active = false; throw transient('stale snapshot at commit'); }
          }
          for (const bid of t.bids) {
            if (mongo.bids.some((b) => b.auctionId.toString() === bid.auctionId.toString() && b.sequence === bid.sequence)) { mongo.release(t); t.active = false; throw dupKey(); }
          }
          for (const [id, doc] of t.writes) { const rec = mongo.auctions.get(id)!; rec.doc = doc; rec.version += 1; }
          for (const r of t.reqs) {
            if (mongo.bidRequests.some((x) => same(x, r))) { mongo.release(t); t.active = false; throw Object.assign(new Error('E11000 duplicate key bid_request_actor_auction_key'), { code: 11000, keyPattern: { bidderAccountId: 1, auctionId: 1, keyHash: 1 } }); }
          }
          mongo.bids.push(...t.bids);
          mongo.bidRequests.push(...t.reqs);
          mongo.audits.push(...t.audits);
          mongo.release(t);
          t.active = false;
          mongo.commits++;
        },
        async abortTransaction() { if (txn?.active) { mongo.release(txn); txn.active = false; } },
        async endSession() { if (txn?.active) { mongo.release(txn); txn.active = false; } },
      };
      mongo.outbox.attach(session);
      return session;
    },
  };
  release(txn: Txn) { for (const [k, v] of this.locks) if (v === txn.id) this.locks.delete(k); }

  // ---- models ----
  auctionModel = {
    findById: (id: string) => {
      let txn: Txn | undefined;
      const chain: any = {
        session: (s: any) => { txn = s?.txn; return chain; },
        exec: async () => { await tick(); const d = this.view(txn, String(id)); return d ? { ...d, ruleSnapshot: { ...d.ruleSnapshot } } : null; },
      };
      return chain;
    },
    findOne: (filter: any) => {
      let sorted = false; void sorted;
      const chain: any = {
        sort: () => chain, select: () => chain, lean: () => chain, session: () => chain,
        exec: async () => {
          await tick();
          const all = [...this.auctions.values()].map((r) => r.doc).filter((d) => this.matches(d, filter));
          all.sort((a, b) => a.currentEndAt - b.currentEndAt);
          return all[0] ? { _id: all[0]._id } : null;
        },
      };
      return chain;
    },
    findOneAndUpdate: (filter: any, update: any, options: any = {}) => ({
      exec: async () => {
        await tick();
        await this.hooks.beforeAuctionWrite?.();
        const txn: Txn | undefined = options.session?.txn;
        const id = String(filter._id);
        if (txn) {
          const rec = this.auctions.get(id);
          if (!rec) return null;
          if (rec.version !== txn.snapAuctions.get(id)!.version) throw transient('write conflict: document changed since snapshot');
          const holder = this.locks.get(id);
          if (holder !== undefined && holder !== txn.id) throw transient('write conflict: document locked by another transaction');
          const current = this.view(txn, id);
          if (!this.matches(current, filter)) return null;
          const next = this.apply(current, update);
          txn.writes.set(id, next);
          this.locks.set(id, txn.id);
          return { ...next };
        }
        // Non-transactional writer (the lifecycle worker): waits out any in-flight transaction on the document.
        for (let i = 0; this.locks.has(id) && i < 5000; i++) await tick();
        if (this.locks.has(id)) throw new Error('lock wait timed out');
        const rec = this.auctions.get(id);
        if (!rec || !this.matches(rec.doc, filter)) return null;
        rec.doc = this.apply(rec.doc, update);
        rec.version += 1;
        return { ...rec.doc };
      },
    }),
  };
  private apply(doc: any, update: any) {
    const next = { ...doc };
    for (const [k, v] of Object.entries(update.$set ?? {})) next[k] = v;
    for (const [k, v] of Object.entries(update.$inc ?? {})) next[k] = (next[k] ?? 0) + (v as number);
    return next;
  }
  private matches(doc: any, filter: any) {
    return Object.entries(filter).every(([k, expected]: [string, any]) => {
      const actual = doc[k];
      if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
      if (expected && typeof expected === 'object' && !(expected instanceof Types.ObjectId)) {
        if ('$lte' in expected) return actual.getTime() <= expected.$lte.getTime();
        if ('$gt' in expected) return actual.getTime() > expected.$gt.getTime();
        if ('$in' in expected) return expected.$in.includes(actual);
      }
      return String(actual) === String(expected);
    });
  }

  userModel = {
    findById: (id: string) => {
      const chain: any = { session: () => chain, lean: () => chain, exec: async () => { await tick(); return this.users.get(String(id)) ?? null; } };
      return chain;
    },
  };

  bidModel = {
    create: async (docs: any[], options: any) => {
      await tick();
      const txn: Txn = options.session.txn;
      await this.hooks.beforeBidInsert?.();
      const injected = this.hooks.bidInsertError?.();
      if (injected) throw injected;
      const out = [];
      for (const d of docs) {
        const row = { _id: new Types.ObjectId(), createdAt: new Date(), ...d };
        if ([...this.bids, ...txn.bids].some((b) => b.auctionId.toString() === row.auctionId.toString() && b.sequence === row.sequence)) throw dupKey();
        txn.bids.push(row);
        out.push(row);
      }
      return out;
    },
    exists: (filter: any) => this.readChain((rows) => (rows.some((r) => String(r.auctionId) === String(filter.auctionId)) ? { _id: 'x' } : null)),
    findOne: (filter: any) => this.readChain((rows, sort) => this.sorted(rows.filter((r) => String(r.auctionId) === String(filter.auctionId)), sort)[0] ?? null),
  };
  private sorted(rows: any[], sort: any) {
    return [...rows].sort((a, b) => { for (const [k, d] of Object.entries(sort ?? {}) as [string, number][]) { if (a[k] < b[k]) return -d; if (a[k] > b[k]) return d; } return 0; });
  }
  private readChain(compute: (rows: any[], sort: any) => any) {
    let txn: Txn | undefined; let sort: any;
    const chain: any = {
      sort: (s: any) => { sort = s; return chain; },
      session: (s: any) => { txn = s?.txn; return chain; },
      lean: () => chain,
      exec: async () => { await tick(); return compute(this.bidView(txn), sort); },
    };
    return chain;
  }

  bidRequestModel = {
    findOne: (filter: any) => {
      let txn: Txn | undefined;
      const chain: any = {
        session: (sess: any) => { txn = sess?.txn; return chain; }, lean: () => chain,
        exec: async () => { await tick(); const rows = txn ? [...this.bidRequests, ...txn.reqs] : this.bidRequests; return rows.find((r) => same(r, filter)) ?? null; },
      };
      return chain;
    },
    create: async (docs: any[], options: any) => {
      await tick();
      const txn: Txn = options.session.txn;
      const out = [];
      for (const d of docs) {
        const row = { _id: new Types.ObjectId(), ...d };
        if ([...this.bidRequests, ...txn.reqs].some((x) => same(x, row))) throw Object.assign(new Error('E11000 duplicate key bid_request_actor_auction_key'), { code: 11000, keyPattern: { bidderAccountId: 1, auctionId: 1, keyHash: 1 } });
        txn.reqs.push(row); out.push(row);
      }
      return out;
    },
  };

  audit = {
    logRequired: jest.fn(async (options: any, session: any) => {
      await tick();
      const error = this.hooks.auditError?.();
      if (error) throw error;
      session.txn.audits.push(options);
    }),
    logSystemAction: jest.fn().mockResolvedValue(undefined),
  };
}

function build(entitled: AuctionBidEntitlementPort | 'default' = { assertEntitled: async () => undefined }) {
  const mongo = new FakeMongo();
  mongo.seedAuction();
  for (const id of [ADVERTISER, ALICE, BOB, CAROL]) mongo.seedUser(id);
  mongo.seedUser(ADMIN, { systemRole: SystemRole.ADMIN });
  mongo.seedUser(SUPER, { systemRole: SystemRole.SUPER_ADMIN });
  mongo.seedUser(SUSPENDED, { accountStatus: AccountStatus.SUSPENDED });
  mongo.seedUser(BROKER_OK, { accountType: AccountType.BROKER, brokerStatus: BrokerStatus.APPROVED });
  mongo.seedUser(BROKER_PENDING, { accountType: AccountType.BROKER, brokerStatus: BrokerStatus.PENDING });
  mongo.seedUser(COMPANY, { accountType: AccountType.COMPANY });

  const clock = { now: jest.fn(() => mongo.clockNow) };
  const ledger = Object.assign(Object.create(BidLedgerService.prototype), { bids: mongo.bidModel }) as BidLedgerService;
  const port = new BidLedgerAuctionBidExistencePort(ledger);
  const lifecycle = Object.assign(Object.create(AuctionLifecycleService.prototype), {
    auctions: mongo.auctionModel, users: mongo.userModel, audit: mongo.audit, clock, bidExistence: port, connection: mongo.connection, outbox: mongo.outbox.service,
  }) as AuctionLifecycleService;
  const service = Object.assign(Object.create(AuctionBidAcceptanceService.prototype), {
    auctions: mongo.auctionModel, users: mongo.userModel, bids: mongo.bidModel, bidRequests: mongo.bidRequestModel, ledger, lifecycle, audit: mongo.audit, clock,
    entitlement: entitled === 'default' ? new FailClosedBidEntitlementPort() : entitled, connection: mongo.connection, outbox: mongo.outbox.service,
  }) as AuctionBidAcceptanceService;
  return { mongo, service, lifecycle, ledger };
}

async function codeOf(action: () => Promise<unknown>): Promise<string | undefined> {
  try { await action(); return undefined; } catch (error) { return (error as any).getResponse?.()?.code; }
}

describe('AuctionBidAcceptanceService — amount rules (MAZAD-027)', () => {
  it('accepts a first bid exactly at the starting price', async () => {
    const { service, mongo } = build();
    const result = await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(result.bid).toMatchObject({ sequence: 1, amountMinor: 100_000, bidderAccountId: ALICE, currency: 'EGP' });
    expect(mongo.bids).toHaveLength(1);
  });

  it('accepts a first bid above the starting price', async () => {
    const { service } = build();
    expect((await service.acceptBid(ALICE, AUCTION, 250_000)).bid.amountMinor).toBe(250_000);
  });

  it('rejects a first bid below the starting price and reports the server-computed minimum', async () => {
    const { service, mongo } = build();
    const error: any = await service.acceptBid(ALICE, AUCTION, 99_999).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({ code: BidErrorCode.BELOW_MINIMUM, details: { minimumBidMinor: 100_000 } });
    expect(mongo.bids).toHaveLength(0);
    expect(mongo.committedAuction().acceptedBidCount).toBe(0); // the acquiring write rolled back with the transaction
  });

  it('accepts a later bid at exactly highest + step, and above it', async () => {
    const { service } = build();
    await service.acceptBid(ALICE, AUCTION, 100_000);
    expect((await service.acceptBid(BOB, AUCTION, 105_000)).bid.sequence).toBe(2);
    expect((await service.acceptBid(ALICE, AUCTION, 200_000)).bid.sequence).toBe(3);
  });

  it('rejects a later bid below highest + step (including equal to the highest)', async () => {
    const { service, mongo } = build();
    await service.acceptBid(ALICE, AUCTION, 100_000);
    for (const amount of [100_000, 104_999]) {
      const error: any = await service.acceptBid(BOB, AUCTION, amount).catch((e) => e);
      expect(error.getResponse()).toMatchObject({ code: BidErrorCode.BELOW_MINIMUM, details: { minimumBidMinor: 105_000 } });
    }
    expect(mongo.bids).toHaveLength(1);
  });

  it('allows repeated bids by the same bidder, including raising their own leading bid', async () => {
    const { service, mongo } = build();
    await service.acceptBid(ALICE, AUCTION, 100_000);
    await service.acceptBid(ALICE, AUCTION, 105_000);
    expect(mongo.bids.map((b) => [b.bidderAccountId.toString(), b.sequence])).toEqual([[ALICE, 1], [ALICE, 2]]);
  });

  it.each([
    ['zero', 0], ['negative', -1], ['fractional', 10.5], ['NaN', Number.NaN], ['Infinity', Infinity], ['string', '150000'], ['null', null], ['undefined', undefined], ['object', {}],
  ])('rejects %s as BID_AMOUNT_INVALID before touching the database', async (_label, amount) => {
    const { service, mongo } = build();
    expect(await codeOf(() => service.acceptBid(ALICE, AUCTION, amount))).toBe(BidErrorCode.AMOUNT_INVALID);
    expect(mongo.transactionsStarted).toBe(0);
  });

  it('rejects an amount above the platform money ceiling as BID_MONEY_RANGE_EXCEEDED', async () => {
    const { service, mongo } = build();
    expect(await codeOf(() => service.acceptBid(ALICE, AUCTION, MONEY_MINOR_MAX + 1))).toBe(BidErrorCode.MONEY_RANGE_EXCEEDED);
    expect(mongo.transactionsStarted).toBe(0);
  });

  it('accepts a bid at exactly the money ceiling and reports no representable next minimum', async () => {
    const { service } = build();
    const result = await service.acceptBid(ALICE, AUCTION, MONEY_MINOR_MAX);
    expect(result.nextMinimumBidMinor).toBeNull();
  });

  it('refuses any further bid once highest + step would overflow the ceiling (no silent wraparound)', async () => {
    const { service, mongo } = build();
    await service.acceptBid(ALICE, AUCTION, MONEY_MINOR_MAX);
    expect(await codeOf(() => service.acceptBid(BOB, AUCTION, MONEY_MINOR_MAX))).toBe(BidErrorCode.MONEY_RANGE_EXCEEDED);
    expect(mongo.bids).toHaveLength(1);
  });

  it('never trusts a client-supplied minimum/price: acceptBid has no such parameter', () => {
    expect(AuctionBidAcceptanceService.prototype.acceptBid.length).toBeLessThanOrEqual(5); // (actorId, auctionId, amount, ip?, idempotency?) — the 5th is MAZAD-029's idempotency key, not a price
    expect(AuctionBidAcceptanceService.prototype.acceptBid.toString().split('{')[0]).not.toMatch(/minimum|price|time|endAt|sequence|bidder/i);
  });
});

describe('AuctionBidAcceptanceService — bidder policy (MAZAD-027)', () => {
  it('rejects the exact advertiser account bidding on its own auction', async () => {
    const { service, mongo } = build();
    expect(await codeOf(() => service.acceptBid(ADVERTISER, AUCTION, 100_000))).toBe(AuthorizationErrorCode.SELF_BID_FORBIDDEN);
    expect(mongo.bids).toHaveLength(0);
  });

  it.each([['ADMIN', ADMIN], ['SUPER_ADMIN', SUPER]])('rejects %s with the admin-marketplace error', async (_l, id) => {
    const { service, mongo } = build();
    expect(await codeOf(() => service.acceptBid(id, AUCTION, 100_000))).toBe(AuthorizationErrorCode.ADMIN_MARKETPLACE_FORBIDDEN);
    expect(mongo.bids).toHaveLength(0);
  });

  it('rejects a suspended (restricted) account', async () => {
    const { service } = build();
    expect(await codeOf(() => service.acceptBid(SUSPENDED, AUCTION, 100_000))).toBe(AuthorizationErrorCode.ACCOUNT_SUSPENDED);
  });

  it('rejects an unapproved broker but accepts an approved broker and a company (on another account\'s auction)', async () => {
    const { service } = build();
    expect(await codeOf(() => service.acceptBid(BROKER_PENDING, AUCTION, 100_000))).toBe(AuthorizationErrorCode.BROKER_CAPABILITY_REQUIRED);
    expect((await service.acceptBid(BROKER_OK, AUCTION, 100_000)).bid.bidderAccountTypeSnapshot).toBe(AccountType.BROKER);
    expect((await service.acceptBid(COMPANY, AUCTION, 105_000)).bid.bidderAccountTypeSnapshot).toBe(AccountType.COMPANY);
  });

  it('takes bidder identity solely from the actor id argument (there is no bidder field in the input)', async () => {
    const { service, mongo } = build();
    await service.acceptBid(BOB, AUCTION, 100_000);
    expect(mongo.bids[0].bidderAccountId.toString()).toBe(BOB);
  });

  it('rejects an unknown actor and unknown/malformed auction ids', async () => {
    const { service } = build();
    expect(await codeOf(() => service.acceptBid('64b000000000000000000aff', AUCTION, 100_000))).toBe(AuctionErrorCode.ACTOR_INVALID);
    expect(await codeOf(() => service.acceptBid(ALICE, '64b000000000000000000fff', 100_000))).toBe(AuctionErrorCode.NOT_FOUND);
    expect(await codeOf(() => service.acceptBid(ALICE, 'nope', 100_000))).toBe(AuctionErrorCode.NOT_FOUND);
  });
});

describe('AuctionBidAcceptanceService — auction state and the end boundary (MAZAD-027)', () => {
  it.each([AuctionStatus.SCHEDULED, AuctionStatus.ENDED_PENDING_CLOSE, AuctionStatus.ENDED_NO_BIDS, AuctionStatus.COMPLETED, AuctionStatus.CANCELLED])(
    'rejects a bid on a %s auction',
    async (status) => {
      const { service, mongo } = build();
      mongo.seedAuction({ status });
      expect(await codeOf(() => service.acceptBid(ALICE, AUCTION, 100_000))).toBe(BidErrorCode.AUCTION_NOT_ACTIVE);
      expect(mongo.bids).toHaveLength(0);
    },
  );

  it('accepts a bid strictly before currentEndAt (one millisecond before)', async () => {
    const { service, mongo } = build();
    mongo.clockNow = new Date(END.getTime() - 1);
    await expect(service.acceptBid(ALICE, AUCTION, 100_000)).resolves.toBeDefined();
  });

  it('REJECTS a bid at exactly currentEndAt (the equality boundary is closed)', async () => {
    const { service, mongo } = build();
    mongo.clockNow = END;
    expect(await codeOf(() => service.acceptBid(ALICE, AUCTION, 100_000))).toBe(BidErrorCode.AUCTION_ENDED);
    expect(mongo.bids).toHaveLength(0);
  });

  it('rejects a bid after currentEndAt', async () => {
    const { service, mongo } = build();
    mongo.clockNow = new Date(END.getTime() + 1);
    expect(await codeOf(() => service.acceptBid(ALICE, AUCTION, 100_000))).toBe(BidErrorCode.AUCTION_ENDED);
  });

  it('measures the boundary against the LIVE currentEndAt (after an extension), not scheduledEndAt', async () => {
    const { service, mongo } = build();
    mongo.seedAuction({ currentEndAt: new Date(END.getTime() + 5 * MIN) });
    mongo.clockNow = new Date(END.getTime() + MIN); // past scheduledEndAt, before currentEndAt
    await expect(service.acceptBid(ALICE, AUCTION, 100_000)).resolves.toBeDefined();
  });

  it('stamps acceptedAt from the server clock; nothing time-related is accepted from the caller', async () => {
    const { service, mongo } = build();
    const result = await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(result.bid.acceptedAt).toEqual(OPEN_NOW);
    expect(mongo.bids[0].acceptedAt).toEqual(OPEN_NOW);
    expect(AuctionBidAcceptanceService.prototype.acceptBid.length).toBeLessThanOrEqual(5); // idempotency key is the only addition
    expect(AuctionBidAcceptanceService.prototype.acceptBid.toString().split('{')[0]).not.toMatch(/time|endAt|sequence|acceptedAt/i);
  });
});

describe('AuctionBidAcceptanceService — anti-sniping inside the transaction (MAZAD-027)', () => {
  it('does not extend a bid placed before the final window', async () => {
    const { service, mongo } = build();
    const result = await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(result.auction).toMatchObject({ extended: false, currentEndAt: END, previousEndAt: END });
    expect(mongo.committedAuction().currentEndAt).toEqual(END);
  });

  it('extends by 5 minutes when the bid lands exactly 5 minutes before the end (boundary inclusive)', async () => {
    const { service, mongo } = build();
    mongo.clockNow = new Date(END.getTime() - 5 * MIN);
    const result = await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(result.auction.extended).toBe(true);
    expect(result.auction.currentEndAt).toEqual(new Date(END.getTime() + 5 * MIN));
    expect(mongo.committedAuction().currentEndAt).toEqual(new Date(END.getTime() + 5 * MIN));
  });

  it('does not extend one millisecond outside the window', async () => {
    const { service, mongo } = build();
    mongo.clockNow = new Date(END.getTime() - 5 * MIN - 1);
    expect((await service.acceptBid(ALICE, AUCTION, 100_000)).auction.extended).toBe(false);
  });

  it('returns the POST-extension authoritative end time, and previousEndAt for comparison', async () => {
    const { service, mongo } = build();
    mongo.clockNow = new Date(END.getTime() - MIN);
    const result = await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(result.auction.previousEndAt).toEqual(END);
    expect(result.auction.currentEndAt).toEqual(new Date(END.getTime() + 5 * MIN));
  });

  it('extends repeatedly with no cap, each time from the current end, and never shortens it', async () => {
    const { service, mongo } = build();
    let expectedEnd = END.getTime();
    let amount = 100_000;
    for (let i = 0; i < 6; i++) {
      mongo.clockNow = new Date(expectedEnd - MIN);
      const before = mongo.committedAuction().currentEndAt.getTime();
      const result = await service.acceptBid(i % 2 ? ALICE : BOB, AUCTION, amount);
      expectedEnd += 5 * MIN;
      expect(result.auction.currentEndAt.getTime()).toBe(expectedEnd);
      expect(result.auction.currentEndAt.getTime()).toBeGreaterThan(before);
      amount += 5_000;
    }
    expect(mongo.committedAuction().currentEndAt.getTime()).toBe(END.getTime() + 30 * MIN);
  });

  it('extends atomically with the Bid: a failure after the extension rolls the extension back too', async () => {
    const { service, mongo } = build();
    mongo.clockNow = new Date(END.getTime() - MIN);
    mongo.hooks.auditError = () => new Error('audit store down');
    await expect(service.acceptBid(ALICE, AUCTION, 100_000)).rejects.toThrow('audit store down');
    expect(mongo.committedAuction().currentEndAt).toEqual(END);
    expect(mongo.committedAuction().acceptedBidCount).toBe(0);
    expect(mongo.bids).toHaveLength(0);
  });

  it('leaves the immutable ruleSnapshot and scheduledEndAt untouched', async () => {
    const { service, mongo } = build();
    mongo.clockNow = new Date(END.getTime() - MIN);
    await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(mongo.committedAuction().scheduledEndAt).toEqual(END);
    expect(mongo.committedAuction().ruleSnapshot).toEqual({ antiSnipingWindowSeconds: 300, antiSnipingExtensionSeconds: 300 });
  });
});

describe('AuctionBidAcceptanceService — atomicity, sequence and audit (MAZAD-027)', () => {
  it('writes the Auction BEFORE reading the ledger for the sequence, and the counter matches the sequence', async () => {
    const { service, mongo, ledger } = build();
    const order: string[] = [];
    const originalWrite = mongo.auctionModel.findOneAndUpdate;
    mongo.auctionModel.findOneAndUpdate = ((...args: any[]) => { order.push('auction-write'); return (originalWrite as any)(...args); }) as any;
    const nextSequence = ledger.nextSequenceFor.bind(ledger);
    (ledger as any).nextSequenceFor = (...args: any[]) => { order.push('next-sequence'); return (nextSequence as any)(...args); };
    await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(order.indexOf('auction-write')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('auction-write')).toBeLessThan(order.indexOf('next-sequence'));
    expect(mongo.committedAuction().acceptedBidCount).toBe(1);
  });

  it('allocates a dense, gap-free 1..n sequence across bidders', async () => {
    const { service, mongo } = build();
    let amount = 100_000;
    for (const who of [ALICE, BOB, ALICE, CAROL, BOB]) { await service.acceptBid(who, AUCTION, amount); amount += 5_000; }
    expect(mongo.bids.map((b) => b.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(mongo.committedAuction().acceptedBidCount).toBe(5);
  });

  it('appends exactly one Bid per acceptance and writes exactly one transactional audit event', async () => {
    const { service, mongo } = build();
    const result = await service.acceptBid(ALICE, AUCTION, 100_000, '203.0.113.7');
    expect(mongo.bids).toHaveLength(1);
    expect(mongo.audits).toHaveLength(1);
    expect(mongo.audits[0]).toMatchObject({
      action: AuditAction.AUCTION_BID_ACCEPTED, actorUserId: ALICE, targetResourceId: AUCTION, ip: '203.0.113.7',
      metadata: expect.objectContaining({ bidId: result.bid.id, sequence: 1, amountMinor: 100_000, extended: false }),
    });
    expect(mongo.audit.logSystemAction).not.toHaveBeenCalled(); // no second, best-effort event for the extension path
  });

  it('writes no audit event (and no bid) for rejected attempts', async () => {
    const { service, mongo } = build();
    await service.acceptBid(ADVERTISER, AUCTION, 100_000).catch(() => undefined);
    await service.acceptBid(ALICE, AUCTION, 1).catch(() => undefined);
    mongo.clockNow = END;
    await service.acceptBid(ALICE, AUCTION, 100_000).catch(() => undefined);
    expect(mongo.audits).toHaveLength(0);
    expect(mongo.audit.logRequired).not.toHaveBeenCalled();
  });

  it('rolls back completely when the Bid insert fails: no Bid, no counter change, no audit', async () => {
    const { service, mongo } = build();
    mongo.hooks.bidInsertError = () => new Error('disk full');
    await expect(service.acceptBid(ALICE, AUCTION, 100_000)).rejects.toThrow('disk full');
    expect(mongo.bids).toHaveLength(0);
    expect(mongo.committedAuction().acceptedBidCount).toBe(0);
    expect(mongo.audits).toHaveLength(0);
  });

  it('returns the internal result with the next minimum and no bidder data beyond the server-derived id', async () => {
    const { service } = build();
    const result = await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(result).toMatchObject({
      bid: { sequence: 1, amountMinor: 100_000, currency: 'EGP', acceptedAt: OPEN_NOW },
      auction: { id: AUCTION, status: AuctionStatus.ACTIVE, acceptedBidCount: 1, extended: false },
      nextMinimumBidMinor: 105_000,
    });
  });
});

describe('AuctionBidAcceptanceService — concurrency and retries (MAZAD-027)', () => {
  it('serialises concurrent bidders: all-valid distinct amounts produce a dense sequence and correct minimums', async () => {
    const { service, mongo } = build();
    // Amounts far enough apart that any commit order is legal (each >= previous + step).
    const bids = [ALICE, BOB, CAROL, BROKER_OK, COMPANY].map((who, i) => service.acceptBid(who, AUCTION, 100_000 + i * 100_000));
    const settled = await Promise.allSettled(bids);
    // Some may lose to a higher earlier commit (BELOW_MINIMUM); whatever committed must obey the ledger rules.
    const accepted = mongo.bids;
    expect(accepted.map((b) => b.sequence)).toEqual(accepted.map((_, i) => i + 1));
    accepted.forEach((bid, i) => {
      const required = i === 0 ? 100_000 : accepted[i - 1].amountMinor + 5_000;
      expect(bid.amountMinor).toBeGreaterThanOrEqual(required);
    });
    expect(mongo.committedAuction().acceptedBidCount).toBe(accepted.length);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(accepted.length);
    for (const s of settled) if (s.status === 'rejected') expect((s.reason as any).getResponse().code).toBe(BidErrorCode.BELOW_MINIMUM);
  });

  it('two bidders at the SAME amount: exactly one wins, the loser is re-decided against the winner and rejected — no stale acceptance', async () => {
    const { service, mongo } = build();
    const [a, b] = await Promise.allSettled([service.acceptBid(ALICE, AUCTION, 150_000), service.acceptBid(BOB, AUCTION, 150_000)]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    const loser = (a.status === 'rejected' ? a : b) as PromiseRejectedResult;
    expect(loser.reason.getResponse()).toMatchObject({ code: BidErrorCode.BELOW_MINIMUM, details: { minimumBidMinor: 155_000 } });
    expect(mongo.bids).toHaveLength(1);
    expect(mongo.committedAuction().acceptedBidCount).toBe(1);
  });

  it('actually contends: a losing transaction is aborted and retried (more transactions than bids)', async () => {
    const { service, mongo } = build();
    await Promise.allSettled([service.acceptBid(ALICE, AUCTION, 150_000), service.acceptBid(BOB, AUCTION, 300_000)]);
    expect(mongo.transactionsStarted).toBeGreaterThan(2);
    expect(mongo.bids.map((b) => b.sequence)).toEqual([1, 2].slice(0, mongo.bids.length));
  });

  it('retries a duplicate (auctionId, sequence) conflict as a race — one Bid, never a validation error', async () => {
    const { service, mongo } = build();
    let failures = 1;
    mongo.hooks.bidInsertError = () => (failures-- > 0 ? dupKey() : undefined);
    const result = await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(result.bid.sequence).toBe(1);
    expect(mongo.bids).toHaveLength(1);
    expect(mongo.transactionsStarted).toBe(2);
    expect(mongo.committedAuction().acceptedBidCount).toBe(1); // the aborted attempt's increment did not leak
    expect(mongo.audits).toHaveLength(1);
  });

  it('retries a transient commit failure with a fresh transaction, still ending with exactly one Bid', async () => {
    const { service, mongo } = build();
    let failures = 1;
    mongo.hooks.commitError = () => (failures-- > 0 ? transient('commit aborted') : undefined);
    await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(mongo.bids).toHaveLength(1);
    expect(mongo.transactionsStarted).toBe(2);
  });

  it('on UnknownTransactionCommitResult re-issues ONLY the commit — the work is never re-run, so no second Bid', async () => {
    const { service, mongo } = build();
    let failures = 2;
    mongo.hooks.commitError = () => (failures-- > 0 ? Object.assign(new Error('unknown'), { hasErrorLabel: (l: string) => l === 'UnknownTransactionCommitResult' }) : undefined);
    await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(mongo.transactionsStarted).toBe(1);
    expect(mongo.bids).toHaveLength(1);
  });

  it('gives up after a bounded number of attempts with a stable retryable error and leaves nothing behind', async () => {
    const { service, mongo } = build();
    mongo.hooks.bidInsertError = () => dupKey();
    const error: any = await service.acceptBid(ALICE, AUCTION, 100_000).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse().code).toBe(BidErrorCode.RETRY_EXHAUSTED);
    expect(mongo.transactionsStarted).toBe(BID_ACCEPTANCE_MAX_ATTEMPTS);
    expect(mongo.bids).toHaveLength(0);
    expect(mongo.committedAuction().acceptedBidCount).toBe(0);
  });

  it('does not retry genuine business rejections (below minimum, ended, forbidden)', async () => {
    const { service, mongo } = build();
    await service.acceptBid(ALICE, AUCTION, 1).catch(() => undefined);
    expect(mongo.transactionsStarted).toBe(1);
    await service.acceptBid(ADVERTISER, AUCTION, 100_000).catch(() => undefined);
    expect(mongo.transactionsStarted).toBe(2);
  });

  it('does not leak raw driver errors as business codes: an unknown failure propagates unchanged and is not retried', async () => {
    const { service, mongo } = build();
    mongo.hooks.bidInsertError = () => new Error('MongoServerError: internal detail');
    await expect(service.acceptBid(ALICE, AUCTION, 100_000)).rejects.toThrow('internal detail');
    expect(mongo.transactionsStarted).toBe(1);
  });
});

describe('bid acceptance vs the lifecycle worker (MAZAD-027)', () => {
  const NEAR_END = new Date(END.getTime() - 1_000);
  const AFTER_END = new Date(END.getTime() + 1_000);

  it('A: a bid decided before the end and committed extends the auction, so a later worker pass does NOT expire it', async () => {
    const { service, lifecycle, mongo } = build();
    mongo.clockNow = NEAR_END;
    await service.acceptBid(ALICE, AUCTION, 100_000);
    mongo.clockNow = AFTER_END; // past the ORIGINAL end, inside the extended end
    await expect(lifecycle.expireDueAuctions()).resolves.toEqual({ endedNoBids: 0, endedPendingClose: 0 });
    expect(mongo.committedAuction().status).toBe(AuctionStatus.ACTIVE);
    // …and once the extended end passes, it ends WITH the accepted bid on the ledger.
    mongo.clockNow = new Date(END.getTime() + 5 * MIN);
    await expect(lifecycle.expireDueAuctions()).resolves.toEqual({ endedNoBids: 0, endedPendingClose: 1 });
  });

  it('B: a bid reaching acceptance at or after the end is rejected even if the worker has not run yet', async () => {
    const { service, mongo } = build();
    mongo.clockNow = END;
    expect(await codeOf(() => service.acceptBid(ALICE, AUCTION, 100_000))).toBe(BidErrorCode.AUCTION_ENDED);
    expect(mongo.bids).toHaveLength(0);
    expect(mongo.committedAuction().status).toBe(AuctionStatus.ACTIVE);
  });

  it('C/E: a worker evaluating expiry while a valid bid is mid-transaction waits for it and then finds the auction extended', async () => {
    const { service, lifecycle, mongo } = build();
    mongo.clockNow = NEAR_END;
    const reached = deferred();
    const gate = deferred();
    mongo.hooks.beforeBidInsert = async () => { mongo.hooks.beforeBidInsert = undefined; reached.resolve(); await gate.promise; };
    const bid = service.acceptBid(ALICE, AUCTION, 100_000);
    await reached.promise; // the bid has ALREADY written the Auction (lock held) and decided at NEAR_END
    mongo.clockNow = AFTER_END;
    let workerDone = false;
    const worker = lifecycle.expireDueAuctions().then((r) => { workerDone = true; return r; });
    await ticks(200);
    expect(workerDone).toBe(false); // blocked on the in-flight transaction's document, not racing past it
    gate.resolve();
    const [result, workerResult] = await Promise.all([bid, worker]);
    expect(result.auction.extended).toBe(true);
    expect(workerResult).toEqual({ endedNoBids: 0, endedPendingClose: 0 });
    expect(mongo.committedAuction()).toMatchObject({ status: AuctionStatus.ACTIVE, currentEndAt: new Date(END.getTime() + 5 * MIN) });
    expect(mongo.bids).toHaveLength(1);
    expect(mongo.bids[0].acceptedAt.getTime()).toBeLessThan(END.getTime());
  });

  it('worker commits first: a bid that decided earlier loses its write, retries, and is rejected — no bid at/after the end persists', async () => {
    const { service, lifecycle, mongo } = build();
    mongo.clockNow = NEAR_END;
    const paused = deferred();
    const release = deferred();
    mongo.hooks.beforeAuctionWrite = async () => { mongo.hooks.beforeAuctionWrite = undefined; paused.resolve(); await release.promise; };
    const bid = service.acceptBid(ALICE, AUCTION, 100_000).catch((e) => e);
    await paused.promise; // bid read ACTIVE at NEAR_END, has not written yet
    mongo.clockNow = AFTER_END;
    await expect(lifecycle.expireDueAuctions()).resolves.toEqual({ endedNoBids: 1, endedPendingClose: 0 });
    release.resolve();
    const outcome: any = await bid;
    expect(outcome.getResponse().code).toBe(BidErrorCode.AUCTION_NOT_ACTIVE);
    expect(mongo.bids).toHaveLength(0);
    expect(mongo.committedAuction().status).toBe(AuctionStatus.ENDED_NO_BIDS);
  });

  it('D: two bidders racing inside the final window both extend correctly; the end only moves forward and every persisted bid precedes the end at its own decision time', async () => {
    const { service, mongo } = build();
    mongo.clockNow = NEAR_END;
    await Promise.allSettled([service.acceptBid(ALICE, AUCTION, 150_000), service.acceptBid(BOB, AUCTION, 300_000)]);
    expect(mongo.bids.length).toBeGreaterThanOrEqual(1);
    for (const bid of mongo.bids) expect(bid.acceptedAt.getTime()).toBeLessThan(END.getTime());
    const end = mongo.committedAuction().currentEndAt.getTime();
    expect(end).toBeGreaterThanOrEqual(END.getTime() + 5 * MIN); // at least the first winner's extension; never shortened
    expect(mongo.committedAuction().acceptedBidCount).toBe(mongo.bids.length);
  });

  it('a worker pass with no bids in play stays idempotent and audits exactly once', async () => {
    const { lifecycle, mongo } = build();
    mongo.clockNow = AFTER_END;
    await lifecycle.expireDueAuctions();
    await lifecycle.expireDueAuctions();
    expect(mongo.audit.logSystemAction).toHaveBeenCalledTimes(1);
  });
});

describe('payment boundary and HTTP boundary (MAZAD-027)', () => {
  it('the default entitlement port FAILS CLOSED: with no payment source nobody can bid', async () => {
    const { service, mongo } = build('default');
    const error: any = await service.acceptBid(ALICE, AUCTION, 100_000).catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse().code).toBe(BidErrorCode.ENTITLEMENT_REQUIRED);
    expect(mongo.bids).toHaveLength(0);
    expect(mongo.committedAuction().acceptedBidCount).toBe(0);
  });

  it('consults the entitlement port with server-derived ids and the transaction session, before writing anything', async () => {
    const seen: any[] = [];
    const { service, mongo } = build({ assertEntitled: async (ctx) => { seen.push({ ...ctx, countAtCall: mongo.locks.size }); } });
    await service.acceptBid(BOB, AUCTION, 100_000);
    expect(seen).toEqual([expect.objectContaining({ auctionId: AUCTION, bidderAccountId: BOB, countAtCall: 0 })]);
    expect(seen[0].session).toBeDefined();
  });

  it('an entitlement rejection from a future payment implementation aborts cleanly', async () => {
    const denied = { assertEntitled: async () => { throw new ForbiddenException({ code: BidErrorCode.ENTITLEMENT_REQUIRED }); } };
    const { service, mongo } = build(denied);
    expect(await codeOf(() => service.acceptBid(ALICE, AUCTION, 100_000))).toBe(BidErrorCode.ENTITLEMENT_REQUIRED);
    expect(mongo.transactionsStarted).toBe(1);
  });

  it('is bound in the real module to the persistent server-confirmed entitlement port (MAZAD-028), no longer fail-closed', () => {
    expect(typeof AUCTION_BID_ENTITLEMENT_PORT).toBe('symbol');
    const providers: any[] = Reflect.getMetadata('providers', require('../src/auctions/auctions.module').AuctionsModule);
    const bound = providers.find((p) => p?.provide === AUCTION_BID_ENTITLEMENT_PORT);
    expect(bound.useExisting).toBe(PersistentBidEntitlementPort);
    expect(bound.useClass).toBeUndefined();
  });

  it('exposes no public bid route: no controller mentions bids and the auction route table is unchanged', () => {
    const paths = Object.getOwnPropertyNames(AuctionsController.prototype)
      .filter((n) => n !== 'constructor')
      .map((n) => Reflect.getMetadata('path', (AuctionsController.prototype as any)[n]));
    expect(paths).toEqual(['/', 'mine', 'mine/:auctionId', 'mine/:auctionId/cancel', '/', ':auctionId']);
    expect(JSON.stringify(paths)).not.toMatch(/bid/i);
    expect(Reflect.getMetadata('controllers', require('../src/bids/bids.module').BidsModule)).toBeUndefined();
  });
});


describe('AuctionBidAcceptanceService with the persistent entitlement port (MAZAD-028)', () => {
  /** Entitlement rows keyed (auction,bidder); records the session each lookup used. */
  function persistent(rows: Array<[string, string]>) {
    const lookups: any[] = [];
    const model: any = {
      exists: (filter: any) => ({
        session: (session: any) => ({
          exec: async () => {
            lookups.push({ filter, session });
            return rows.some(([a, b]) => a === String(filter.auctionId) && b === String(filter.bidderAccountId)) ? { _id: 'x' } : null;
          },
        }),
      }),
    };
    return { port: new PersistentBidEntitlementPort(model), lookups };
  }

  it('accepts a bid when a server-confirmed entitlement exists, looked up with the transaction session', async () => {
    const { port, lookups } = persistent([[AUCTION, ALICE]]);
    const { service, mongo } = build(port);
    const result = await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(result.bid.sequence).toBe(1);
    expect(mongo.bids).toHaveLength(1);
    expect(lookups).toHaveLength(1);
    expect(lookups[0].session.txn).toBeDefined();
    expect(String(lookups[0].filter.auctionId)).toBe(AUCTION);
    expect(String(lookups[0].filter.bidderAccountId)).toBe(ALICE);
  });

  it('missing entitlement still yields BID_ENTITLEMENT_REQUIRED and writes nothing', async () => {
    const { service, mongo } = build(persistent([]).port);
    expect(await codeOf(() => service.acceptBid(ALICE, AUCTION, 100_000))).toBe(BidErrorCode.ENTITLEMENT_REQUIRED);
    expect(mongo.bids).toHaveLength(0);
    expect(mongo.committedAuction().acceptedBidCount).toBe(0);
  });

  it("another bidder cannot use someone else's entitlement", async () => {
    const { service } = build(persistent([[AUCTION, ALICE]]).port);
    expect(await codeOf(() => service.acceptBid(BOB, AUCTION, 100_000))).toBe(BidErrorCode.ENTITLEMENT_REQUIRED);
  });

  it('an entitlement for a different auction does not count', async () => {
    const { service } = build(persistent([['64b000000000000000000f02', ALICE]]).port);
    expect(await codeOf(() => service.acceptBid(ALICE, AUCTION, 100_000))).toBe(BidErrorCode.ENTITLEMENT_REQUIRED);
  });

  it('an entitlement does not bypass any other rule: admin, self-bid, suspended, ended, inactive, minimum', async () => {
    const all: Array<[string, string]> = [ADMIN, SUPER, SUSPENDED, ADVERTISER, ALICE].map((b) => [AUCTION, b] as [string, string]);
    const { service, mongo } = build(persistent(all).port);
    for (const actor of [ADMIN, SUPER, SUSPENDED, ADVERTISER]) {
      await expect(service.acceptBid(actor, AUCTION, 100_000)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(await codeOf(() => service.acceptBid(ALICE, AUCTION, 99_999))).toBe(BidErrorCode.BELOW_MINIMUM);
    mongo.clockNow = END;
    expect(await codeOf(() => service.acceptBid(ALICE, AUCTION, 100_000))).toBe(BidErrorCode.AUCTION_ENDED);
    mongo.clockNow = OPEN_NOW;
    mongo.committedAuction().status = AuctionStatus.ENDED_PENDING_CLOSE;
    expect(await codeOf(() => service.acceptBid(ALICE, AUCTION, 100_000))).toBe(BidErrorCode.AUCTION_NOT_ACTIVE);
    expect(mongo.bids).toHaveLength(0);
  });
});


describe('AuctionBidAcceptanceService — request-level idempotency (MAZAD-029)', () => {
  const KEY = 'idem-key-0001';
  const bidOnce = (service: AuctionBidAcceptanceService, actor: string, amount: number, key = KEY, auction = AUCTION) =>
    service.acceptBid(actor, auction, amount, undefined, { key });

  it('same actor + auction + key + payload replays the ORIGINAL result and creates no second Bid', async () => {
    const { service, mongo } = build();
    const first = await bidOnce(service, ALICE, 100_000);
    expect(first.replayed).toBe(false);
    const second = await bidOnce(service, ALICE, 100_000);
    expect(second.replayed).toBe(true);
    expect(second.bid).toEqual(first.bid);
    expect(second.auction).toEqual(first.auction);
    expect(second.nextMinimumBidMinor).toBe(first.nextMinimumBidMinor);
    expect(mongo.bids).toHaveLength(1);
    expect(mongo.bidRequests).toHaveLength(1);
    expect(mongo.committedAuction().acceptedBidCount).toBe(1);
    expect(mongo.audits.filter((a) => a.action === AuditAction.AUCTION_BID_ACCEPTED)).toHaveLength(1);
    // MAZAD-036: a replay adds no second BID_ACCEPTED (and therefore no second OUTBID notification source).
    expect(mongo.outbox.events('BID_ACCEPTED')).toHaveLength(1);
  });

  it('a replay returns the original result even after the auction moved on (later bids, end, cancellation)', async () => {
    const { service, mongo } = build();
    const first = await bidOnce(service, ALICE, 100_000);
    await service.acceptBid(BOB, AUCTION, 105_000);
    mongo.committedAuction().status = AuctionStatus.CANCELLED;
    const replay = await bidOnce(service, ALICE, 100_000);
    expect(replay).toMatchObject({ replayed: true, bid: first.bid });
    expect(mongo.bids).toHaveLength(2);
  });

  it('same key with a different amount is a deterministic idempotency conflict and writes nothing', async () => {
    const { service, mongo } = build();
    await bidOnce(service, ALICE, 100_000);
    expect(await codeOf(() => bidOnce(service, ALICE, 200_000))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await codeOf(() => bidOnce(service, ALICE, 200_000))).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(mongo.bids).toHaveLength(1);
  });

  it('the same key is independent for another actor (no shared scope, no information leak)', async () => {
    const { service, mongo } = build();
    const a = await bidOnce(service, ALICE, 100_000);
    const b = await bidOnce(service, BOB, 105_000);
    expect([a.replayed, b.replayed]).toEqual([false, false]);
    expect(b.bid.sequence).toBe(2);
    expect(mongo.bids).toHaveLength(2);
  });

  it('the same key on a different auction does not collide', async () => {
    const OTHER = '64b000000000000000000f02';
    const { service, mongo } = build();
    mongo.seedAuction({ _id: oid(OTHER) });
    const a = await bidOnce(service, ALICE, 100_000, KEY, AUCTION);
    const b = await bidOnce(service, ALICE, 100_000, KEY, OTHER);
    expect([a.replayed, b.replayed]).toEqual([false, false]);
    expect(mongo.bids).toHaveLength(2);
  });

  it('a business rejection records nothing, so the same key can be retried and re-decided', async () => {
    const { service, mongo } = build();
    expect(await codeOf(() => bidOnce(service, ALICE, 99_999))).toBe(BidErrorCode.BELOW_MINIMUM);
    expect(mongo.bidRequests).toHaveLength(0);
    const ok = await bidOnce(service, ALICE, 99_999 + 1); // different payload, same key: no record exists, so no conflict
    expect(ok).toMatchObject({ replayed: false });
    expect(mongo.bids).toHaveLength(1);
  });

  it('entitlement failure records nothing; once entitled the same key proceeds', async () => {
    let entitled = false;
    const { service, mongo } = build({ assertEntitled: async () => { if (!entitled) throw new ForbiddenException({ code: BidErrorCode.ENTITLEMENT_REQUIRED }); } });
    expect(await codeOf(() => bidOnce(service, ALICE, 100_000))).toBe(BidErrorCode.ENTITLEMENT_REQUIRED);
    expect(mongo.bidRequests).toHaveLength(0);
    entitled = true;
    expect((await bidOnce(service, ALICE, 100_000)).replayed).toBe(false);
  });

  it('concurrent requests with the same key converge on ONE bid and one result', async () => {
    const { service, mongo } = build();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => bidOnce(service, ALICE, 100_000)));
    expect(mongo.bids).toHaveLength(1);
    expect(mongo.bidRequests).toHaveLength(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.bid.id)).size).toBe(1);
  });

  it('retry after a lost HTTP response (bid committed, result discarded) returns the original and places no second bid', async () => {
    const { service, mongo } = build();
    await bidOnce(service, ALICE, 100_000); // the client never sees this response
    const afterNetworkLoss = await bidOnce(service, ALICE, 100_000);
    expect(afterNetworkLoss).toMatchObject({ replayed: true });
    expect(afterNetworkLoss.bid).toMatchObject({ sequence: 1, amountMinor: 100_000, bidderAccountId: ALICE });
    expect(mongo.bids).toHaveLength(1);
  });

  it('a commit that fails (transient) leaves neither Bid nor request record; the retry then succeeds exactly once', async () => {
    const { service, mongo } = build();
    let fail = true;
    mongo.hooks.commitError = () => (fail ? ((fail = false), transient('commit failed')) : undefined);
    const result = await bidOnce(service, ALICE, 100_000);
    expect(result.replayed).toBe(false);
    expect(mongo.bids).toHaveLength(1);
    expect(mongo.bidRequests).toHaveLength(1);
  });

  it('the Bid and its request record are written in the same transaction (no bid without a record)', async () => {
    const { service, mongo } = build();
    mongo.hooks.auditError = () => new Error('audit down');
    await expect(bidOnce(service, ALICE, 100_000)).rejects.toThrow('audit down');
    expect(mongo.bids).toHaveLength(0);
    expect(mongo.bidRequests).toHaveLength(0);
  });

  it('idempotency is optional at the service level and never persists a record without a key', async () => {
    const { service, mongo } = build();
    await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(mongo.bidRequests).toHaveLength(0);
  });

  it('BID_RETRY_EXHAUSTED is a retryable conflict carrying retryAfterSeconds', async () => {
    const { service, mongo } = build();
    mongo.hooks.commitError = () => transient('always conflicts');
    const error: any = await bidOnce(service, ALICE, 100_000).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: BidErrorCode.RETRY_EXHAUSTED, retryAfterSeconds: 1, details: { retryable: true } });
    expect(mongo.bids).toHaveLength(0);
  });

  it('uses no process-local state: a second service instance over the same store still replays', async () => {
    const one = build();
    await bidOnce(one.service, ALICE, 100_000);
    const twin = Object.assign(Object.create(AuctionBidAcceptanceService.prototype), (one.service as any));
    expect((await bidOnce(twin, ALICE, 100_000)).replayed).toBe(true);
    expect(one.mongo.bids).toHaveLength(1);
  });
});

describe('BID_ACCEPTED domain event — transactional outbox (MAZAD-031)', () => {
  const KEY = 'idem-key-0031';
  const NEAR_END = new Date(END.getTime() - 1_000);
  const bidEvents = (mongo: FakeMongo) => mongo.outbox.events('BID_ACCEPTED');
  const versions = (mongo: FakeMongo) => mongo.outbox.events().map((e) => e.aggregateVersion).sort((a, b) => a - b);

  it('an accepted bid commits exactly ONE BID_ACCEPTED event holding the authoritative committed result', async () => {
    const { service, mongo } = build();
    const result = await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(bidEvents(mongo)).toHaveLength(1);
    expect(mongo.outbox.events()).toHaveLength(1);
    const [event] = bidEvents(mongo);
    expect(event).toMatchObject({
      type: 'BID_ACCEPTED', schemaVersion: 1, aggregateType: 'AUCTION', aggregateId: AUCTION, aggregateVersion: 1, audience: 'PUBLIC', occurredAt: OPEN_NOW,
      privateRouting: { bidderAccountId: ALICE },
      payload: {
        auctionId: AUCTION, sequence: 1, amountMinor: 100_000, currency: 'EGP', acceptedAt: OPEN_NOW.toISOString(), acceptedBidCount: 1,
        currentEndAt: END.toISOString(), previousEndAt: END.toISOString(), extended: false, nextMinimumBidMinor: 105_000,
      },
    });
    // The event is the committed fact: it equals the result, the Bid row and the Auction row.
    expect(event.payload.sequence).toBe(result.bid.sequence);
    expect(event.payload.currentEndAt).toBe(mongo.committedAuction().currentEndAt.toISOString());
    expect(event.payload.acceptedBidCount).toBe(mongo.committedAuction().acceptedBidCount);
    expect(event.payload.amountMinor).toBe(mongo.bids[0].amountMinor);
  });

  it('exposes no bidder identity in the payload — only in the separate private routing field', async () => {
    const { service, mongo } = build();
    await service.acceptBid(ALICE, AUCTION, 100_000);
    const [event] = bidEvents(mongo);
    expect(JSON.stringify(event.payload)).not.toContain(ALICE);
    expect(Object.keys(event.payload)).not.toEqual(expect.arrayContaining(['bidderAccountId', 'bidderAccountTypeSnapshot', 'bidId']));
    expect(event.privateRouting).toEqual({ bidderAccountId: ALICE });
  });

  it('successive bids each produce one event with dense, increasing versions and matching sequences', async () => {
    const { service, mongo } = build();
    await service.acceptBid(ALICE, AUCTION, 100_000);
    await service.acceptBid(BOB, AUCTION, 105_000);
    await service.acceptBid(ALICE, AUCTION, 110_000);
    expect(bidEvents(mongo).map((e) => [e.aggregateVersion, e.payload.sequence, e.payload.amountMinor])).toEqual([[1, 1, 100_000], [2, 2, 105_000], [3, 3, 110_000]]);
    expect(bidEvents(mongo).map((e) => e.payload.nextMinimumBidMinor)).toEqual([105_000, 110_000, 115_000]);
    expect(bidEvents(mongo).map((e) => e.privateRouting)).toEqual([
      { bidderAccountId: ALICE },
      { bidderAccountId: BOB, previousHighestBidderAccountId: ALICE },
      { bidderAccountId: ALICE, previousHighestBidderAccountId: BOB },
    ]);
  });

  it('does not add false outbid routing when the highest bidder raises their own bid', async () => {
    const { service, mongo } = build();
    await service.acceptBid(ALICE, AUCTION, 100_000);
    await service.acceptBid(ALICE, AUCTION, 105_000);
    expect(bidEvents(mongo)[1].privateRouting).toEqual({ bidderAccountId: ALICE });
  });

  it('anti-sniping data is authoritative: the extension is reported with the SAME end time the auction committed', async () => {
    const { service, mongo } = build();
    mongo.clockNow = NEAR_END;
    const result = await service.acceptBid(ALICE, AUCTION, 100_000);
    const extendedTo = new Date(END.getTime() + 5 * MIN);
    expect(result.auction.extended).toBe(true);
    const [bid] = bidEvents(mongo);
    expect(bid.payload).toMatchObject({ extended: true, previousEndAt: END.toISOString(), currentEndAt: extendedTo.toISOString() });
    expect(mongo.committedAuction().currentEndAt).toEqual(extendedTo);
    // …and the extension itself is its own event, in the same transaction, immediately before the bid it belongs to.
    const extension = mongo.outbox.events('AUCTION_END_EXTENDED');
    expect(extension).toHaveLength(1);
    expect(extension[0].payload).toMatchObject({ previousEndAt: END.toISOString(), currentEndAt: extendedTo.toISOString() });
    expect(mongo.outbox.events().map((e) => [e.aggregateVersion, e.type])).toEqual([[1, 'AUCTION_END_EXTENDED'], [2, 'BID_ACCEPTED']]);
  });

  it('a bid outside the window reports extended:false and emits no extension event', async () => {
    const { service, mongo } = build();
    await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(bidEvents(mongo)[0].payload.extended).toBe(false);
    expect(mongo.outbox.events('AUCTION_END_EXTENDED')).toHaveLength(0);
  });

  it('rejected bids leave no event: below minimum, ended, wrong status, forbidden bidder, invalid amount, missing entitlement', async () => {
    const attempt = async (setup: (m: FakeMongo) => void, run: (s: AuctionBidAcceptanceService) => Promise<unknown>, entitled: 'default' | undefined = undefined) => {
      const ctx = entitled ? build('default') : build();
      setup(ctx.mongo);
      await run(ctx.service).catch(() => undefined);
      expect(ctx.mongo.outbox.events()).toHaveLength(0);
      expect(ctx.mongo.outbox.insertAttempts).toBe(0);
      expect(ctx.mongo.bids).toHaveLength(0);
    };
    await attempt(() => undefined, (s) => s.acceptBid(ALICE, AUCTION, 1));                              // below the starting price
    await attempt((m) => { m.clockNow = END; }, (s) => s.acceptBid(ALICE, AUCTION, 100_000));           // at/after the end
    await attempt((m) => { m.committedAuction().status = AuctionStatus.ENDED_PENDING_CLOSE; }, (s) => s.acceptBid(ALICE, AUCTION, 100_000));
    await attempt(() => undefined, (s) => s.acceptBid(ADVERTISER, AUCTION, 100_000));                   // self-bid
    await attempt(() => undefined, (s) => s.acceptBid(SUSPENDED, AUCTION, 100_000));
    await attempt(() => undefined, (s) => s.acceptBid(ADMIN, AUCTION, 100_000));
    await attempt(() => undefined, (s) => s.acceptBid(ALICE, AUCTION, 1.5));                            // not an integer
    await attempt(() => undefined, (s) => s.acceptBid(ALICE, AUCTION, 100_000), 'default');             // fail-closed entitlement
  });

  it('a below-minimum bid after an accepted one still leaves exactly the first event', async () => {
    const { service, mongo } = build();
    await service.acceptBid(ALICE, AUCTION, 100_000);
    await service.acceptBid(BOB, AUCTION, 100_001).catch(() => undefined);
    expect(bidEvents(mongo)).toHaveLength(1);
  });

  it('an idempotent replay creates NO second event and performs no outbox write', async () => {
    const { service, mongo } = build();
    const first = await service.acceptBid(ALICE, AUCTION, 100_000, undefined, { key: KEY });
    const attempts = mongo.outbox.insertAttempts;
    const replay = await service.acceptBid(ALICE, AUCTION, 100_000, undefined, { key: KEY });
    await service.acceptBid(ALICE, AUCTION, 100_000, undefined, { key: KEY });
    expect(replay.replayed).toBe(true);
    expect(bidEvents(mongo)).toHaveLength(1);
    expect(mongo.outbox.insertAttempts).toBe(attempts);
    expect(bidEvents(mongo)[0].payload.sequence).toBe(first.bid.sequence);
  });

  it('a reused key with a different amount is a conflict and emits nothing new', async () => {
    const { service, mongo } = build();
    await service.acceptBid(ALICE, AUCTION, 100_000, undefined, { key: KEY });
    expect(await codeOf(() => service.acceptBid(ALICE, AUCTION, 200_000, undefined, { key: KEY }))).toBeDefined();
    expect(bidEvents(mongo)).toHaveLength(1);
  });

  it('a whole-transaction retry (lost commit) still leaves exactly one event', async () => {
    const { service, mongo } = build();
    mongo.hooks.commitError = () => { mongo.hooks.commitError = undefined; return transient('commit lost the race'); };
    await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(mongo.transactionsStarted).toBe(2);
    expect(bidEvents(mongo)).toHaveLength(1);
    expect(mongo.bids).toHaveLength(1);
  });

  it('a lost race on the outbox version index is retried like any write conflict', async () => {
    const { service, mongo } = build();
    let once = 1;
    mongo.outbox.insertError = () => (once-- > 0 ? outboxDuplicateVersion() : undefined);
    await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(mongo.transactionsStarted).toBe(2);
    expect(bidEvents(mongo)).toHaveLength(1);
  });

  it('an outbox failure aborts the bid: no Bid, no counter change, no request record, no audit row', async () => {
    const { service, mongo } = build();
    mongo.outbox.insertError = () => new Error('outbox unavailable');
    await expect(service.acceptBid(ALICE, AUCTION, 100_000, undefined, { key: KEY })).rejects.toThrow('outbox unavailable');
    expect(mongo.bids).toHaveLength(0);
    expect(mongo.committedAuction().acceptedBidCount).toBe(0);
    expect(mongo.bidRequests).toHaveLength(0);
    expect(mongo.audits).toHaveLength(0);
    expect(mongo.outbox.events()).toHaveLength(0);
    mongo.outbox.insertError = undefined; // the same key is usable again once the outbox recovers
    expect((await service.acceptBid(ALICE, AUCTION, 100_000, undefined, { key: KEY })).replayed).toBe(false);
    expect(bidEvents(mongo)).toHaveLength(1);
  });

  it('an audit failure aborts the bid AND discards the already-buffered extension/bid events (no phantom event)', async () => {
    const { service, mongo } = build();
    mongo.clockNow = NEAR_END; // so the extension event is buffered before the audit runs
    mongo.hooks.auditError = () => new Error('audit down');
    await expect(service.acceptBid(ALICE, AUCTION, 100_000)).rejects.toThrow('audit down');
    expect(mongo.outbox.events()).toHaveLength(0);
    expect(mongo.bids).toHaveLength(0);
    expect(mongo.committedAuction().currentEndAt).toEqual(END);
  });

  it('two bidders racing in the final window: every committed bid has exactly one event, versions stay dense and unique', async () => {
    const { service, mongo } = build();
    mongo.clockNow = NEAR_END;
    await Promise.allSettled([service.acceptBid(ALICE, AUCTION, 150_000), service.acceptBid(BOB, AUCTION, 300_000), service.acceptBid(CAROL, AUCTION, 500_000)]);
    expect(mongo.bids.length).toBeGreaterThanOrEqual(1);
    expect(bidEvents(mongo)).toHaveLength(mongo.bids.length);
    expect(bidEvents(mongo).map((e) => e.payload.sequence).sort()).toEqual(mongo.bids.map((b) => b.sequence).sort());
    const all = versions(mongo);
    expect(all).toEqual(all.map((_, i) => i + 1)); // 1..N with no gap and no duplicate across bid + extension events
  });

  it('changes no bid behaviour: the same acceptance result, Bid row and Auction counters as before the outbox', async () => {
    const { service, mongo } = build();
    const result = await service.acceptBid(ALICE, AUCTION, 100_000);
    expect(result).toMatchObject({ bid: { sequence: 1, amountMinor: 100_000, currency: 'EGP' }, auction: { acceptedBidCount: 1, extended: false }, nextMinimumBidMinor: 105_000, replayed: false });
    expect(mongo.bids).toHaveLength(1);
    expect(mongo.committedAuction().acceptedBidCount).toBe(1);
  });
});
