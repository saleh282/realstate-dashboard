import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AuctionBiddingReadService } from '../src/auctions/auction-bidding-read.service';
import { AuctionsQueryService } from '../src/auctions/auctions-query.service';
import { AuctionStatus } from '../src/auctions/auction.types';
import { computeNextMinimumBidMinor } from '../src/bids/bid-pricing';
import { AuctionErrorCode } from '../src/common/errors/auction-error-codes';
import { BidErrorCode } from '../src/common/errors/bid-error-codes';
import { MONEY_MINOR_MAX } from '../src/common/money/money';

/**
 * MAZAD-029 — authoritative current bid state and the anonymised public
 * history, over an in-memory ledger. Visibility is the real
 * `AuctionsQueryService.getPubliclyVisible` gate (with a stubbed property
 * lookup), so hiding rules are exercised, not re-implemented.
 */
const oid = (hex: string) => new Types.ObjectId(hex);
const AUCTION = '64b000000000000000000f01';
const ALICE = '64b000000000000000000a11';
const BOB = '64b000000000000000000a12';
const NOW = new Date('2026-05-02T10:00:00Z');
const END = new Date('2026-05-08T10:00:00Z');

function build(options: { bids?: Array<{ bidder: string; amount: number }>; auction?: Record<string, unknown>; propertyVisible?: boolean } = {}) {
  const ledgerRows = (options.bids ?? []).map((b, i) => ({ auctionId: oid(AUCTION), bidderAccountId: oid(b.bidder), bidderAccountTypeSnapshot: 'broker', sequence: i + 1, amountMinor: b.amount, currency: 'EGP', acceptedAt: new Date(NOW.getTime() + i * 1000) }));
  const auctionDoc: any = {
    _id: oid(AUCTION), propertyId: oid('64b000000000000000000b01'), propertyRevisionId: oid('64b000000000000000000b02'), advertiserAccountId: oid('64b000000000000000000a10'),
    status: AuctionStatus.ACTIVE, startingPriceMinor: 100_000, minimumBidStepMinor: 5_000, currency: 'EGP', currentEndAt: END,
    acceptedBidCount: ledgerRows.length, ...options.auction,
  };
  const reads = { auctionFinds: 0, ledgerCalls: [] as any[] };
  const auctions = { findById: () => ({ lean: () => ({ exec: async () => { reads.auctionFinds++; return auctionDoc; } }) }) };
  const ledger: any = {
    countForAuction: async () => ledgerRows.length,
    getLatestForAuction: async () => ledgerRows[ledgerRows.length - 1] ?? null,
    getHighestForAuction: async () => [...ledgerRows].sort((a, b) => b.amountMinor - a.amountMinor || a.sequence - b.sequence)[0] ?? null,
    listForAuction: async (_id: string, o: any = {}) => { reads.ledgerCalls.push(o); return ledgerRows.filter((r) => o.afterSequence === undefined || r.sequence > o.afterSequence).slice(0, o.limit ?? 100); },
  };
  const properties = { getAnchoredPublicProjections: async () => new Map(options.propertyVisible === false ? [] : [[`${auctionDoc.propertyId}:${auctionDoc.propertyRevisionId}`, { id: 'p' }]]) };
  const clock = { now: () => NOW };
  const queries = new AuctionsQueryService(auctions as any, properties as any, clock as any);
  const service = new AuctionBiddingReadService(auctions as any, ledger, queries, clock as any);
  return { service, auctionDoc, ledgerRows, reads, ledger };
}
const codeOf = async (action: () => Promise<unknown>) => { try { await action(); return undefined; } catch (e) { return (e as any).getResponse?.()?.code; } };

describe('current bid state (MAZAD-029)', () => {
  it('no bids: no current bid (the starting price is not a bid); next minimum = starting price', async () => {
    const { service } = build();
    const { bidding, serverTime } = await service.getPublicBidState(AUCTION);
    expect(bidding).toMatchObject({ hasBids: false, acceptedBidCount: 0, currentBidMinor: null, nextMinimumBidMinor: 100_000, startingPriceMinor: 100_000, currency: 'EGP', currentEndAt: END });
    expect(serverTime).toEqual(NOW);
  });

  it('one bid: current = that bid; next minimum = bid + step', async () => {
    const { service } = build({ bids: [{ bidder: ALICE, amount: 100_000 }] });
    expect((await service.getPublicBidState(AUCTION)).bidding).toMatchObject({ hasBids: true, acceptedBidCount: 1, currentBidMinor: 100_000, nextMinimumBidMinor: 105_000 });
  });

  it('many bids: current = highest accepted; count matches; next minimum from the highest', async () => {
    const { service } = build({ bids: [{ bidder: ALICE, amount: 100_000 }, { bidder: BOB, amount: 105_000 }, { bidder: ALICE, amount: 250_000 }] });
    expect((await service.getPublicBidState(AUCTION)).bidding).toMatchObject({ acceptedBidCount: 3, currentBidMinor: 250_000, nextMinimumBidMinor: 255_000 });
  });

  it('near the money ceiling: next minimum is null (unrepresentable), never an overflowed number', async () => {
    const { service } = build({ bids: [{ bidder: ALICE, amount: MONEY_MINOR_MAX - 1_000 }], auction: { minimumBidStepMinor: 5_000 } });
    expect((await service.getPublicBidState(AUCTION)).bidding).toMatchObject({ currentBidMinor: MONEY_MINOR_MAX - 1_000, nextMinimumBidMinor: null });
    expect(computeNextMinimumBidMinor(1, 5, MONEY_MINOR_MAX - 5)).toBe(MONEY_MINOR_MAX);
    expect(computeNextMinimumBidMinor(1, 5, MONEY_MINOR_MAX - 4)).toBeNull();
  });

  it('reports the live authoritative currentEndAt (anti-sniping-extended) and status', async () => {
    const extended = new Date(END.getTime() + 5 * 60_000);
    const { service } = build({ auction: { currentEndAt: extended } });
    expect((await service.getPublicBidState(AUCTION)).bidding).toMatchObject({ currentEndAt: extended, status: AuctionStatus.ACTIVE });
  });

  it('a counter/ledger disagreement is reported as BID_LEDGER_INCONSISTENT (500), never a wrong price', async () => {
    const { service } = build({ bids: [{ bidder: ALICE, amount: 100_000 }], auction: { acceptedBidCount: 5 } });
    const error: any = await service.getPublicBidState(AUCTION).catch((e) => e);
    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect(error.getResponse().code).toBe(BidErrorCode.LEDGER_INCONSISTENT);
  });

  it('a ledger with rows but a zero counter is also inconsistent', async () => {
    const { service } = build({ bids: [{ bidder: ALICE, amount: 100_000 }], auction: { acceptedBidCount: 0 } });
    expect(await codeOf(() => service.getPublicBidState(AUCTION))).toBe(BidErrorCode.LEDGER_INCONSISTENT);
  });

  it('a transient mismatch (a bid landing between the reads) is re-read and resolves without an error', async () => {
    const ctx = build({ bids: [{ bidder: ALICE, amount: 100_000 }] });
    let first = true;
    const original = ctx.auctionDoc.acceptedBidCount;
    (ctx.service as any).auctions = { findById: () => ({ lean: () => ({ exec: async () => { const doc = { ...ctx.auctionDoc, acceptedBidCount: first ? original + 1 : original }; first = false; return doc; } }) }) };
    expect((await ctx.service.getPublicBidState(AUCTION)).bidding.acceptedBidCount).toBe(1);
  });

  it('a pre-existing auction without the counter field reads as zero bids', async () => {
    const { service } = build({ auction: { acceptedBidCount: undefined } });
    expect((await service.getPublicBidState(AUCTION)).bidding.acceptedBidCount).toBe(0);
  });

  it('exposes only safe entry-fee information: required + amount when configured, a not-configured marker otherwise', async () => {
    const configured = build({ auction: { entryFee: { amountMinor: 25_000, currency: 'EGP', configuredByActorId: oid(ALICE), configuredAt: NOW } } });
    const { bidding } = await configured.service.getPublicBidState(AUCTION);
    expect(bidding.entryFee).toEqual({ required: true, configured: true, free: false, amountMinor: 25_000, currency: 'EGP' });
    // MAZAD-035: an explicit 0 is a configured FREE auction, not a required payment and not "not configured".
    const free = build({ auction: { entryFee: { amountMinor: 0, currency: 'EGP', configuredByActorId: oid(ALICE), configuredAt: NOW } } });
    expect((await free.service.getPublicBidState(AUCTION)).bidding.entryFee).toEqual({ required: false, configured: true, free: true, amountMinor: 0, currency: 'EGP' });
    expect(JSON.stringify(bidding)).not.toContain(ALICE);
    expect((await build().service.getPublicBidState(AUCTION)).bidding.entryFee).toEqual({ required: false, configured: false, free: false });
  });

  it('never emits bidder identity, payment or provider data', async () => {
    const { service } = build({ bids: [{ bidder: ALICE, amount: 100_000 }] });
    const text = JSON.stringify(await service.getPublicBidState(AUCTION));
    expect(text).not.toMatch(new RegExp(`${ALICE}|bidderAccount|provider|payment|entitlement`, 'i'));
  });
});

describe('public bid history (MAZAD-029)', () => {
  const bids = [
    { bidder: ALICE, amount: 100_000 }, { bidder: BOB, amount: 105_000 }, { bidder: ALICE, amount: 110_000 },
    { bidder: BOB, amount: 115_000 }, { bidder: ALICE, amount: 120_000 },
  ];

  it('returns only the whitelisted anonymised fields, in ledger order', async () => {
    const { service } = build({ bids });
    const { items } = await service.getPublicBidHistory(AUCTION);
    expect(items.map((i) => i.sequence)).toEqual([1, 2, 3, 4, 5]);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(['acceptedAt', 'amountMinor', 'currency', 'isMine', 'sequence']);
    const text = JSON.stringify(items);
    expect(text).not.toMatch(new RegExp(`${ALICE}|${BOB}|bidderAccount|accountType|broker`, 'i'));
  });

  it('guests get isMine:false on every row (no identity inference possible)', async () => {
    const { service } = build({ bids });
    expect((await service.getPublicBidHistory(AUCTION)).items.every((i) => i.isMine === false)).toBe(true);
  });

  it('an authenticated viewer sees isMine true ONLY on their own rows; others stay anonymous', async () => {
    const { service } = build({ bids });
    const { items } = await service.getPublicBidHistory(AUCTION, {}, ALICE);
    expect(items.map((i) => i.isMine)).toEqual([true, false, true, false, true]);
    const bobView = await service.getPublicBidHistory(AUCTION, {}, BOB);
    expect(bobView.items.map((i) => i.isMine)).toEqual([false, true, false, true, false]);
    expect(JSON.stringify(items)).not.toContain(BOB);
  });

  it('a viewer with no bids (e.g. an admin) sees no row as theirs', async () => {
    const { service } = build({ bids });
    expect((await service.getPublicBidHistory(AUCTION, {}, '64b000000000000000000a99')).items.some((i) => i.isMine)).toBe(false);
  });

  it('paginates deterministically by sequence cursor, with a bounded limit', async () => {
    const { service, reads } = build({ bids });
    const p1 = await service.getPublicBidHistory(AUCTION, { limit: 2 });
    expect(p1.items.map((i) => i.sequence)).toEqual([1, 2]);
    expect(p1.pagination).toEqual({ limit: 2, hasMore: true, nextAfterSequence: 2 });
    const p2 = await service.getPublicBidHistory(AUCTION, { limit: 2, afterSequence: p1.pagination.nextAfterSequence! });
    expect(p2.items.map((i) => i.sequence)).toEqual([3, 4]);
    const p3 = await service.getPublicBidHistory(AUCTION, { limit: 2, afterSequence: p2.pagination.nextAfterSequence! });
    expect(p3.items.map((i) => i.sequence)).toEqual([5]);
    expect(p3.pagination).toEqual({ limit: 2, hasMore: false, nextAfterSequence: null });
    expect(reads.ledgerCalls.every((c) => c.limit <= 101)).toBe(true);
  });

  it('clamps the page size (default 50, max 100) — the ledger is never returned unbounded', async () => {
    const { service, reads } = build({ bids });
    await service.getPublicBidHistory(AUCTION);
    await service.getPublicBidHistory(AUCTION, { limit: 100_000 });
    await service.getPublicBidHistory(AUCTION, { limit: 0 });
    expect(reads.ledgerCalls.map((c) => c.limit)).toEqual([51, 101, 2]);
  });

  it('an empty history is an empty page', async () => {
    const { service } = build();
    expect(await service.getPublicBidHistory(AUCTION)).toMatchObject({ items: [], pagination: { hasMore: false, nextAfterSequence: null } });
  });
});

describe('auction visibility is enforced for bid reads (MAZAD-029)', () => {
  it.each([AuctionStatus.CANCELLED, AuctionStatus.COMPLETED, AuctionStatus.ENDED_NO_BIDS])('a %s auction is hidden from both endpoints, and the ledger is never queried', async (status) => {
    const ctx = build({ bids: [{ bidder: ALICE, amount: 100_000 }], auction: { status } });
    expect(await codeOf(() => ctx.service.getPublicBidState(AUCTION))).toBe(AuctionErrorCode.PUBLIC_UNAVAILABLE);
    expect(await codeOf(() => ctx.service.getPublicBidHistory(AUCTION))).toBe(AuctionErrorCode.PUBLIC_UNAVAILABLE);
    expect(ctx.reads.ledgerCalls).toHaveLength(0);
  });

  it('an auction whose property stopped being public is hidden, matching GET /auctions/:id', async () => {
    const ctx = build({ bids: [{ bidder: ALICE, amount: 100_000 }], propertyVisible: false });
    expect(await codeOf(() => ctx.service.getPublicBidState(AUCTION))).toBe(AuctionErrorCode.PUBLIC_UNAVAILABLE);
    expect(await codeOf(() => ctx.service.getPublicBidHistory(AUCTION))).toBe(AuctionErrorCode.PUBLIC_UNAVAILABLE);
  });

  it('SCHEDULED and ENDED_PENDING_CLOSE auctions remain visible (same set as the public API)', async () => {
    for (const status of [AuctionStatus.SCHEDULED, AuctionStatus.ACTIVE, AuctionStatus.ENDED_PENDING_CLOSE]) {
      const { service } = build({ auction: { status } });
      await expect(service.getPublicBidState(AUCTION)).resolves.toBeDefined();
    }
  });

  it('an unknown auction is a 404 and a malformed id never queries', async () => {
    const ctx = build();
    ctx.auctionDoc.__missing = true;
    const missing = new AuctionBiddingReadService({ findById: () => ({ lean: () => ({ exec: async () => null }) }) } as any, ctx.ledger, new AuctionsQueryService({ findById: () => ({ lean: () => ({ exec: async () => null }) }) } as any, {} as any, { now: () => NOW } as any), { now: () => NOW } as any);
    await expect(missing.getPublicBidState(AUCTION)).rejects.toBeInstanceOf(NotFoundException);
    expect(await codeOf(() => ctx.service.getPublicBidHistory('nope'))).toBe(AuctionErrorCode.ID_INVALID);
  });

  it('the read service is read-only: it has no write path and the module adds no winner/close/realtime surface', () => {
    const fs = require('node:fs'); const path = require('node:path');
    const text = ['auction-bidding-read.service.ts', 'auction-bids.controller.ts'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'auctions', f), 'utf8')).join('\n');
    expect(text).not.toMatch(/\.(create|updateOne|findOneAndUpdate|deleteOne|insertMany|bulkWrite)\(/);
    expect(text).not.toMatch(/WebSocket|EventSource|@Sse|winner|finalize|outbox/i);
  });
});
