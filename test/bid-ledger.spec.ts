import { Model, Types, model, models } from 'mongoose';
import { AuctionBidExistencePort, BidLedgerAuctionBidExistencePort } from '../src/auctions/auction-bid-existence.port';
import { AuctionsController } from '../src/auctions/auctions.controller';
import { AdminAuctionsController } from '../src/auctions/admin-auctions.controller';
import { toAnonymizedBid } from '../src/bids/bid-projections';
import { BidLedgerService } from '../src/bids/bid-ledger.service';
import { BidsModule } from '../src/bids/bids.module';
import { Bid, BidLedgerImmutableError, BidSchema } from '../src/bids/schemas/bid.schema';
import { BidErrorCode } from '../src/common/errors/bid-error-codes';
import { MONEY_MINOR_MAX } from '../src/common/money/money';
import { AccountType } from '../src/users/identity.types';

/**
 * MAZAD-026 — the immutable Bid ledger foundation. Covers the schema's
 * validation and immutability guards, its indexes, the read-only ledger
 * service (deterministic ordering, privacy, transaction-session support),
 * the Bid-backed existence port, and the absence of any HTTP bid surface.
 * Bid acceptance itself is MAZAD-027 and is deliberately not tested here.
 */

const AUCTION = '64b000000000000000000d01';
const OTHER_AUCTION = '64b000000000000000000d02';
const ALICE = '64b000000000000000000e01';
const BOB = '64b000000000000000000e02';
const T0 = new Date('2026-04-01T10:00:00Z');

const BidModel: Model<Bid> = (models.BidLedgerSpec as Model<Bid>) ?? model<Bid>('BidLedgerSpec', BidSchema);

function validBid(overrides: Record<string, unknown> = {}) {
  return {
    auctionId: new Types.ObjectId(AUCTION),
    bidderAccountId: new Types.ObjectId(ALICE),
    bidderAccountTypeSnapshot: AccountType.USER,
    sequence: 1,
    amountMinor: 150_000,
    currency: 'EGP',
    acceptedAt: T0,
    ...overrides,
  };
}

describe('Bid schema (MAZAD-026)', () => {
  it('accepts a complete bid and stamps createdAt but never updatedAt', () => {
    const doc = new BidModel(validBid());
    expect(doc.validateSync()).toBeUndefined();
    expect(BidSchema.get('timestamps')).toEqual({ createdAt: true, updatedAt: false });
    expect(BidSchema.get('versionKey')).toBe(false);
    expect(BidSchema.get('collection')).toBe('bids');
  });

  it.each(['auctionId', 'bidderAccountId', 'bidderAccountTypeSnapshot', 'sequence', 'amountMinor', 'acceptedAt'])('requires %s', (field) => {
    const doc = new BidModel(validBid({ [field]: undefined }));
    expect(doc.validateSync()?.errors[field]).toBeDefined();
  });

  it('defaults the currency to EGP and rejects any other', () => {
    expect(new BidModel(validBid({ currency: undefined })).currency).toBe('EGP');
    expect(new BidModel(validBid({ currency: 'USD' })).validateSync()?.errors.currency).toBeDefined();
  });

  it.each([
    ['zero', 0], ['negative', -5], ['fractional', 10.5], ['above the money ceiling', MONEY_MINOR_MAX + 1], ['NaN', Number.NaN],
  ])('rejects %s amountMinor', (_label, amountMinor) => {
    expect(new BidModel(validBid({ amountMinor })).validateSync()?.errors.amountMinor).toBeDefined();
  });

  it('accepts the maximum allowed amount', () => {
    expect(new BidModel(validBid({ amountMinor: MONEY_MINOR_MAX })).validateSync()).toBeUndefined();
  });

  it.each([['zero', 0], ['negative', -1], ['fractional', 1.5]])('rejects %s sequence', (_label, sequence) => {
    expect(new BidModel(validBid({ sequence })).validateSync()?.errors.sequence).toBeDefined();
  });

  it('rejects an unknown bidder account type', () => {
    expect(new BidModel(validBid({ bidderAccountTypeSnapshot: 'ROBOT' })).validateSync()?.errors.bidderAccountTypeSnapshot).toBeDefined();
  });

  it('carries no client-owned or mutable business state (no status, no withdrawn/deleted flag, no client timestamp field)', () => {
    const paths = Object.keys(BidSchema.paths).sort();
    expect(paths).toEqual(['_id', 'acceptedAt', 'amountMinor', 'auctionId', 'bidderAccountId', 'bidderAccountTypeSnapshot', 'createdAt', 'currency', 'sequence']);
  });

  it('allows repeated bids by the same bidder on one auction (distinct sequences)', () => {
    expect(new BidModel(validBid({ sequence: 1 })).validateSync()).toBeUndefined();
    expect(new BidModel(validBid({ sequence: 2, amountMinor: 160_000 })).validateSync()).toBeUndefined();
  });
});

describe('Bid ledger indexes (MAZAD-026)', () => {
  const indexes = BidSchema.indexes();
  const find = (name: string) => indexes.find(([, options]) => (options as any)?.name === name);

  it('has the unique per-auction sequence index that defines ledger order', () => {
    expect(find('bid_auction_sequence')).toEqual([{ auctionId: 1, sequence: 1 }, expect.objectContaining({ unique: true })]);
  });

  it('has bidder history and auction+bidder indexes, neither unique (repeat bids are legal)', () => {
    expect(find('bid_bidder_history')).toEqual([{ bidderAccountId: 1, createdAt: -1 }, expect.not.objectContaining({ unique: true })]);
    expect(find('bid_auction_bidder')).toEqual([{ auctionId: 1, bidderAccountId: 1, sequence: -1 }, expect.not.objectContaining({ unique: true })]);
  });

  it('is exactly three indexes (no speculative extras), only one unique', () => {
    expect(indexes).toHaveLength(3);
    expect(indexes.filter(([, options]) => (options as any)?.unique)).toHaveLength(1);
  });
});

describe('Bid ledger immutability (MAZAD-026)', () => {
  it.each(['auctionId', 'bidderAccountId', 'bidderAccountTypeSnapshot', 'sequence', 'amountMinor', 'currency', 'acceptedAt'])(
    'marks %s immutable',
    (field) => expect((BidSchema.path(field) as any).options.immutable).toBe(true),
  );

  const rejected = async (action: () => Promise<unknown>) => {
    const error = await action().then(() => undefined, (e) => e);
    expect(error).toBeInstanceOf(BidLedgerImmutableError);
    expect(error.code).toBe(BidErrorCode.LEDGER_IMMUTABLE);
  };

  it.each([
    ['updateOne', () => BidModel.updateOne({ sequence: 1 }, { amountMinor: 1 }).exec()],
    ['updateMany', () => BidModel.updateMany({}, { amountMinor: 1 }).exec()],
    ['replaceOne', () => BidModel.replaceOne({ sequence: 1 }, validBid() as any).exec()],
    ['findOneAndUpdate', () => BidModel.findOneAndUpdate({ sequence: 1 }, { amountMinor: 1 }).exec()],
    ['findByIdAndUpdate (edit amount)', () => BidModel.findByIdAndUpdate(new Types.ObjectId(), { amountMinor: 1 }).exec()],
    ['findOneAndUpdate (move to another auction)', () => BidModel.findOneAndUpdate({ sequence: 1 }, { auctionId: new Types.ObjectId(OTHER_AUCTION) }).exec()],
    ['findOneAndUpdate (change bidder)', () => BidModel.findOneAndUpdate({ sequence: 1 }, { bidderAccountId: new Types.ObjectId(BOB) }).exec()],
    ['findOneAndReplace', () => BidModel.findOneAndReplace({ sequence: 1 }, validBid() as any).exec()],
    ['deleteOne', () => BidModel.deleteOne({ sequence: 1 }).exec()],
    ['deleteMany', () => BidModel.deleteMany({}).exec()],
    ['findOneAndDelete', () => BidModel.findOneAndDelete({ sequence: 1 }).exec()],
    ['findByIdAndDelete', () => BidModel.findByIdAndDelete(new Types.ObjectId()).exec()],
    ['bulkWrite', () => BidModel.bulkWrite([{ deleteOne: { filter: { sequence: 1 } } }])],
  ])('rejects %s through Mongoose before any database call', async (_name, action) => {
    await rejected(action);
  });

  it('rejects mutating and re-saving an already persisted bid, and deleting it via the document', async () => {
    const persisted = BidModel.hydrate({ _id: new Types.ObjectId(), ...validBid() });
    persisted.amountMinor = 999_999; // immutable path: assignment is ignored by Mongoose…
    expect(persisted.amountMinor).toBe(150_000);
    await rejected(() => persisted.save()); // …and re-saving an existing bid is refused outright
    await rejected(() => persisted.deleteOne());
    await rejected(() => persisted.updateOne({ amountMinor: 1 }).exec());
  });

  it('exposes no edit/withdraw/delete API on the ledger service', () => {
    const methods = Object.getOwnPropertyNames(BidLedgerService.prototype).filter((name) => name !== 'constructor');
    expect(methods.sort()).toEqual(['countForAuction', 'getHighestForAuction', 'getLatestForAuction', 'hasAcceptedBids', 'listForAuction', 'listForBidder', 'nextSequenceFor']);
    for (const method of methods) expect(method).not.toMatch(/^(create|insert|append|add|place|update|edit|set|delete|remove|withdraw|cancel)/i);
  });
});

/** In-memory Bid model supporting exactly the query chains BidLedgerService issues. */
function fakeBidModel(rows: any[]) {
  const sessions: unknown[] = [];
  const queries: any[] = [];
  const eq = (a: any, b: any) => String(a) === String(b);
  const matches = (row: any, filter: any) =>
    Object.entries(filter).every(([key, expected]: [string, any]) => {
      if (expected && typeof expected === 'object' && !(expected instanceof Types.ObjectId) && '$gt' in expected) return row[key] > expected.$gt;
      return eq(row[key], expected);
    });
  const chain = (compute: () => any) => {
    const state: any = { sort: undefined, limit: undefined, skip: 0 };
    const api: any = {
      sort: (s: any) => { state.sort = s; return api; },
      limit: (n: number) => { state.limit = n; return api; },
      skip: (n: number) => { state.skip = n; return api; },
      session: (s: unknown) => { sessions.push(s); return api; },
      lean: () => api,
      exec: async () => compute().call(null, state),
    };
    return api;
  };
  const ordered = (list: any[], sort: any) =>
    !sort ? list : [...list].sort((a, b) => {
      for (const [key, dir] of Object.entries(sort) as [string, number][]) {
        if (a[key] < b[key]) return -dir;
        if (a[key] > b[key]) return dir;
      }
      return 0;
    });
  const model = {
    exists: jest.fn((filter: any) => { queries.push(['exists', filter]); return chain(() => () => (rows.some((r) => matches(r, filter)) ? { _id: 'x' } : null)); }),
    countDocuments: jest.fn((filter: any) => { queries.push(['count', filter]); return chain(() => () => rows.filter((r) => matches(r, filter)).length); }),
    find: jest.fn((filter: any) => { queries.push(['find', filter]); return chain(() => (s: any) => ordered(rows.filter((r) => matches(r, filter)), s.sort).slice(s.skip, s.limit ? s.skip + s.limit : undefined)); }),
    findOne: jest.fn((filter: any) => { queries.push(['findOne', filter]); return chain(() => (s: any) => ordered(rows.filter((r) => matches(r, filter)), s.sort)[0] ?? null); }),
  };
  return { model, sessions, queries };
}

function row(auction: string, sequence: number, bidder: string, amountMinor: number, extra: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    auctionId: new Types.ObjectId(auction),
    bidderAccountId: new Types.ObjectId(bidder),
    bidderAccountTypeSnapshot: AccountType.USER,
    sequence, amountMinor, currency: 'EGP',
    acceptedAt: new Date(T0.getTime() + sequence * 1000),
    createdAt: new Date(T0.getTime() + sequence * 1000),
    ...extra,
  };
}

function ledger(rows: any[]) {
  const store = fakeBidModel(rows);
  const service = Object.create(BidLedgerService.prototype) as any;
  Object.assign(service, { bids: store.model });
  return { service: service as BidLedgerService, ...store };
}

describe('BidLedgerService read primitives (MAZAD-026)', () => {
  // Inserted out of order on purpose: order must come from `sequence`, not storage order or time.
  const rows = [
    row(AUCTION, 3, ALICE, 170_000),
    row(AUCTION, 1, ALICE, 150_000),
    row(OTHER_AUCTION, 1, BOB, 900_000),
    row(AUCTION, 2, BOB, 160_000),
    row(AUCTION, 4, ALICE, 180_000),
  ];

  it('hasAcceptedBids: false with no bids, true with a persisted bid, scoped to the auction', async () => {
    expect(await ledger([]).service.hasAcceptedBids(AUCTION)).toBe(false);
    expect(await ledger(rows).service.hasAcceptedBids(AUCTION)).toBe(true);
    expect(await ledger([row(OTHER_AUCTION, 1, BOB, 5)]).service.hasAcceptedBids(AUCTION)).toBe(false);
  });

  it('never queries for a malformed auction id', async () => {
    const { service, model } = ledger(rows);
    expect(await service.hasAcceptedBids('nope')).toBe(false);
    expect(await service.countForAuction('nope')).toBe(0);
    expect(await service.listForAuction('nope')).toEqual([]);
    expect(await service.getLatestForAuction('nope')).toBeNull();
    expect(await service.getHighestForAuction('nope')).toBeNull();
    expect(await service.listForBidder('nope')).toEqual([]);
    expect(model.exists).not.toHaveBeenCalled();
    expect(model.find).not.toHaveBeenCalled();
    expect(model.findOne).not.toHaveBeenCalled();
    expect(model.countDocuments).not.toHaveBeenCalled();
  });

  it('lists an auction\'s history in deterministic sequence order, including repeat bids by one bidder', async () => {
    const { service } = ledger(rows);
    const history = await service.listForAuction(AUCTION);
    expect(history.map((b) => b.sequence)).toEqual([1, 2, 3, 4]);
    expect(history.map((b) => b.bidderAccountId.toString())).toEqual([ALICE, BOB, ALICE, ALICE]);
    expect(history.every((b) => b.auctionId.toString() === AUCTION)).toBe(true);
  });

  it('orders by sequence even when acceptedAt is identical or misleading', async () => {
    const same = new Date('2026-04-01T11:00:00Z');
    const { service } = ledger([row(AUCTION, 2, BOB, 2, { acceptedAt: same }), row(AUCTION, 1, ALICE, 1, { acceptedAt: same }), row(AUCTION, 3, ALICE, 3, { acceptedAt: new Date('2020-01-01') })]);
    expect((await service.listForAuction(AUCTION)).map((b) => b.sequence)).toEqual([1, 2, 3]);
  });

  it('supports stable cursor pagination and bounds the page size', async () => {
    const { service } = ledger(rows);
    expect((await service.listForAuction(AUCTION, { afterSequence: 2 })).map((b) => b.sequence)).toEqual([3, 4]);
    expect((await service.listForAuction(AUCTION, { limit: 2 })).map((b) => b.sequence)).toEqual([1, 2]);
    const many = ledger(Array.from({ length: 600 }, (_, i) => row(AUCTION, i + 1, ALICE, i + 1)));
    expect(await many.service.listForAuction(AUCTION, { limit: 100_000 })).toHaveLength(500);
    expect(await many.service.listForAuction(AUCTION)).toHaveLength(100);
    expect(await many.service.listForAuction(AUCTION, { limit: -4 })).toHaveLength(1);
  });

  it('returns the latest bid (highest sequence) and null for an empty auction', async () => {
    expect((await ledger(rows).service.getLatestForAuction(AUCTION))?.sequence).toBe(4);
    expect(await ledger([]).service.getLatestForAuction(AUCTION)).toBeNull();
  });

  it('returns the highest-amount bid, resolving a tie to the earliest sequence', async () => {
    expect((await ledger(rows).service.getHighestForAuction(AUCTION))?.amountMinor).toBe(180_000);
    const tie = ledger([row(AUCTION, 2, BOB, 500), row(AUCTION, 1, ALICE, 500), row(AUCTION, 3, ALICE, 400)]);
    expect((await tie.service.getHighestForAuction(AUCTION))?.sequence).toBe(1);
  });

  it('computes the next sequence: 1 for an empty auction, latest + 1 otherwise, per auction', async () => {
    expect(await ledger([]).service.nextSequenceFor(AUCTION)).toBe(1);
    expect(await ledger(rows).service.nextSequenceFor(AUCTION)).toBe(5);
    expect(await ledger(rows).service.nextSequenceFor(OTHER_AUCTION)).toBe(2);
  });

  it('counts bids per auction', async () => {
    expect(await ledger(rows).service.countForAuction(AUCTION)).toBe(4);
    expect(await ledger(rows).service.countForAuction(OTHER_AUCTION)).toBe(1);
  });

  it('threads a transaction session through every read so MAZAD-027 can use them in its transaction', async () => {
    const { service, sessions } = ledger(rows);
    const session = { id: 'txn' } as any;
    await service.hasAcceptedBids(AUCTION, { session });
    await service.countForAuction(AUCTION, { session });
    await service.listForAuction(AUCTION, { session });
    await service.getLatestForAuction(AUCTION, { session });
    await service.getHighestForAuction(AUCTION, { session });
    await service.nextSequenceFor(AUCTION, { session });
    expect(sessions.length).toBeGreaterThanOrEqual(6);
    expect(sessions.every((s) => s === session)).toBe(true);
  });

  it('lists a bidder\'s own bids newest first with bounded pagination', async () => {
    const { service } = ledger(rows);
    const mine = await service.listForBidder(ALICE);
    expect(mine.map((b) => b.sequence)).toEqual([4, 3, 1]);
    expect(await service.listForBidder(ALICE, { page: 2, limit: 2 })).toHaveLength(1);
    const many = ledger(Array.from({ length: 80 }, (_, i) => row(AUCTION, i + 1, ALICE, i + 1)));
    expect(await many.service.listForBidder(ALICE, { limit: 10_000 })).toHaveLength(50);
  });
});

describe('bidder privacy (MAZAD-026)', () => {
  const bid = row(AUCTION, 2, BOB, 160_000);

  it('the anonymised projection never contains bidder identity, account type or ids', () => {
    const view = toAnonymizedBid(bid);
    expect(Object.keys(view).sort()).toEqual(['acceptedAt', 'amountMinor', 'currency', 'isMine', 'sequence']);
    const json = JSON.stringify(view);
    for (const secret of [BOB, ALICE, AUCTION, 'bidderAccountId', 'bidderAccountTypeSnapshot', String(bid._id)]) expect(json).not.toContain(secret);
    expect(view.isMine).toBe(false);
  });

  it('tells only the bidder that a bid is theirs', () => {
    expect(toAnonymizedBid(bid, BOB).isMine).toBe(true);
    expect(toAnonymizedBid(bid, ALICE).isMine).toBe(false);
    expect(toAnonymizedBid(bid, undefined).isMine).toBe(false);
  });
});

describe('Bid-backed AuctionBidExistencePort (MAZAD-026)', () => {
  const port = (rows: any[]): AuctionBidExistencePort => new BidLedgerAuctionBidExistencePort(ledger(rows).service);

  it('reports no bids for an auction with an empty ledger', async () => {
    await expect(port([]).hasValidBids(AUCTION)).resolves.toBe(false);
  });

  it('reports bids once an accepted bid is persisted, and only for that auction', async () => {
    const p = port([row(AUCTION, 1, ALICE, 150_000)]);
    await expect(p.hasValidBids(AUCTION)).resolves.toBe(true);
    await expect(p.hasValidBids(OTHER_AUCTION)).resolves.toBe(false);
  });
});

describe('no bid HTTP surface (MAZAD-026)', () => {
  it('BidsModule registers no controller', () => {
    expect(Reflect.getMetadata('controllers', BidsModule)).toBeUndefined();
  });

  it('no auction controller route mentions bids, and the route set is unchanged from MAZAD-025', () => {
    const routes = (controller: any) =>
      Object.getOwnPropertyNames(controller.prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => [Reflect.getMetadata('method', controller.prototype[name]), Reflect.getMetadata('path', controller.prototype[name])]);
    const all = [...routes(AuctionsController), ...routes(AdminAuctionsController)];
    expect(JSON.stringify(all)).not.toMatch(/bid/i);
    expect(routes(AuctionsController)).toHaveLength(6);
    expect(routes(AdminAuctionsController)).toHaveLength(2);
  });
});
