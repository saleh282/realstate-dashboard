import { InternalServerErrorException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AdminAuctionsController } from '../src/auctions/admin-auctions.controller';
import { AuctionFinalizationService } from '../src/auctions/auction-finalization.service';
import { AuctionFinalizationWorker } from '../src/auctions/auction-finalization.worker';
import { toAdminAuction, toOwnAuction, toPublicAuction } from '../src/auctions/auction-projections';
import { AUCTION_TRANSITIONS } from '../src/auctions/auction-transitions';
import { AuctionStatus } from '../src/auctions/auction.types';
import { AuctionsController } from '../src/auctions/auctions.controller';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';
import { BidLedgerService } from '../src/bids/bid-ledger.service';
import { AuctionErrorCode } from '../src/common/errors/auction-error-codes';
import { BidErrorCode } from '../src/common/errors/bid-error-codes';
import { AccountType } from '../src/users/identity.types';
import { FakeMongo, transient } from './support/fake-payments-mongo';

/**
 * MAZAD-030 — close & winner finalization, against the in-memory Mongo MODEL
 * (snapshot reads, single-writer-per-document WriteConflict, commit-time stale
 * check, abort discards writes). Real-Mongo concurrency is still a
 * release-qualification item.
 */
const oid = (hex: string) => new Types.ObjectId(hex);
const AUCTION = '64b000000000000000000f01';
const AUCTION_2 = '64b000000000000000000f02';
const AUCTION_3 = '64b000000000000000000f03';
const ALICE = '64b000000000000000000a11';
const BOB = '64b000000000000000000a12';
const CAROL = '64b000000000000000000a13';
const END = new Date('2026-05-08T10:00:00Z');
const NOW = new Date('2026-05-08T10:01:00Z');

type BidRow = { _id: Types.ObjectId; auctionId: Types.ObjectId; bidderAccountId: Types.ObjectId; bidderAccountTypeSnapshot: string; sequence: number; amountMinor: number; currency: string; acceptedAt: Date };
const bidRow = (auction: string, sequence: number, bidder: string, amountMinor: number, extra: Partial<BidRow> = {}): BidRow => ({
  _id: new Types.ObjectId(), auctionId: oid(auction), bidderAccountId: oid(bidder), bidderAccountTypeSnapshot: AccountType.BROKER, sequence, amountMinor, currency: 'EGP',
  acceptedAt: new Date(END.getTime() - (100 - sequence) * 1000), ...extra,
});

function build(seed: { auctions?: Array<{ id?: string; status?: AuctionStatus; counter?: number; currentEndAt?: Date; extra?: Record<string, unknown>; bids?: BidRow[] }> } = {}) {
  const mongo = new FakeMongo();
  const rows: BidRow[] = [];
  const specs = seed.auctions ?? [{ bids: [bidRow(AUCTION, 1, ALICE, 100_000)] }];
  for (const spec of specs) {
    const id = spec.id ?? AUCTION;
    const bids = spec.bids ?? [];
    rows.push(...bids);
    mongo.seedAuction({
      _id: oid(id), status: spec.status ?? AuctionStatus.ENDED_PENDING_CLOSE, acceptedBidCount: spec.counter ?? bids.length,
      startingPriceMinor: 100_000, minimumBidStepMinor: 5_000, currency: 'EGP', currentEndAt: spec.currentEndAt ?? END, ...spec.extra,
    });
  }
  const base = mongo.model('auctions');
  const auctionsModel: any = {
    ...base,
    find: (filter: any) => {
      let sort: any; let max = Infinity;
      const chain: any = {
        sort: (s: any) => { sort = s; return chain; }, limit: (n: number) => { max = n; return chain; }, select: () => chain, lean: () => chain,
        exec: async () => {
          const excluded = new Set((filter._id?.$nin ?? []).map(String));
          return mongo.rows('auctions').filter((d) => d.status === filter.status && !excluded.has(String(d._id)))
            .sort((a, b) => a.currentEndAt - b.currentEndAt || String(a._id).localeCompare(String(b._id))).slice(0, max).map((d) => ({ _id: d._id }));
        },
      };
      return chain;
    },
  };
  const bidsModel: any = {
    countDocuments: (f: any) => ({ session: () => ({ exec: async () => rows.filter((r) => String(r.auctionId) === String(f.auctionId)).length }) }),
    findOne: (f: any) => {
      let sort: any;
      const chain: any = {
        sort: (s: any) => { sort = s; return chain; }, session: () => chain, lean: () => chain,
        exec: async () => {
          const mine = rows.filter((r) => String(r.auctionId) === String(f.auctionId));
          const ordered = [...mine].sort((a: any, b: any) => { for (const [k, d] of Object.entries(sort ?? {}) as [string, number][]) { if (a[k] !== b[k]) return (a[k] < b[k] ? -1 : 1) * d; } return 0; });
          return ordered[0] ?? null;
        },
      };
      return chain;
    },
  };
  const ledger = new BidLedgerService(bidsModel);
  const clock = { now: jest.fn(() => NOW) };
  const service = new AuctionFinalizationService(auctionsModel, ledger, mongo.auditSvc as any, clock as any, mongo.connection as any);
  return { mongo, service, rows, clock };
}
const auction = (mongo: FakeMongo, id = AUCTION) => mongo.data.auctions.get(id)!.doc;
const finalizedAudits = (mongo: FakeMongo) => mongo.audits.filter((a) => a.action === AuditAction.AUCTION_FINALIZED);
const codeOf = async (action: () => Promise<unknown>) => { try { await action(); return undefined; } catch (e) { return (e as any).getResponse?.()?.code; } };

describe('winner determination and finalization (MAZAD-030)', () => {
  it('one accepted bid wins; ENDED_PENDING_CLOSE → COMPLETED with the winner persisted from that Bid', async () => {
    const bid = bidRow(AUCTION, 1, ALICE, 100_000);
    const { service, mongo } = build({ auctions: [{ bids: [bid] }] });
    const result = await service.finalize(AUCTION);
    expect(result).toMatchObject({ outcome: 'FINALIZED', winningBidSequence: 1, winningBidAmountMinor: 100_000, currency: 'EGP', finalizedAt: NOW });
    const doc = auction(mongo);
    expect(doc).toMatchObject({ status: AuctionStatus.COMPLETED, completedAt: NOW, winningBidSequence: 1, winningBidAmountMinor: 100_000, winnerAccountTypeSnapshot: AccountType.BROKER, winningBidAcceptedAt: bid.acceptedAt });
    expect(String(doc.winnerAccountId)).toBe(ALICE);
    expect(String(doc.winningBidId)).toBe(bid._id.toString());
  });

  it('multiple bids: the highest amount wins', async () => {
    const bids = [bidRow(AUCTION, 1, ALICE, 100_000), bidRow(AUCTION, 2, BOB, 105_000), bidRow(AUCTION, 3, CAROL, 250_000), bidRow(AUCTION, 4, ALICE, 255_000)];
    const { service, mongo } = build({ auctions: [{ bids }] });
    await service.finalize(AUCTION);
    expect(String(auction(mongo).winnerAccountId)).toBe(ALICE);
    expect(auction(mongo)).toMatchObject({ winningBidSequence: 4, winningBidAmountMinor: 255_000 });
    expect(String(auction(mongo).winningBidId)).toBe(bids[3]._id.toString());
  });

  it('equal amounts (only constructible at storage level) resolve to the EARLIEST sequence', async () => {
    const bids = [bidRow(AUCTION, 1, ALICE, 100_000), bidRow(AUCTION, 2, BOB, 200_000), bidRow(AUCTION, 3, CAROL, 200_000)];
    const { service, mongo } = build({ auctions: [{ bids }] });
    await service.finalize(AUCTION);
    expect(String(auction(mongo).winnerAccountId)).toBe(BOB);
    expect(auction(mongo).winningBidSequence).toBe(2);
  });

  it('completedAt comes from the server clock, not any caller value', async () => {
    const { service, mongo, clock } = build();
    const later = new Date('2026-06-01T00:00:00Z');
    clock.now.mockReturnValue(later);
    expect(service.finalize.length).toBe(1); // (auctionId) — no winner/time parameter exists
    await service.finalize(AUCTION);
    expect(auction(mongo).completedAt).toEqual(later);
  });

  it('never changes accepted Bid rows', async () => {
    const bids = [bidRow(AUCTION, 1, ALICE, 100_000), bidRow(AUCTION, 2, BOB, 105_000)];
    const { service, rows } = build({ auctions: [{ bids }] });
    const before = JSON.stringify(rows);
    await service.finalize(AUCTION);
    await service.finalize(AUCTION);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('winner amount/currency are copied straight from the winning Bid (integer minor units)', async () => {
    const { service, mongo } = build({ auctions: [{ bids: [bidRow(AUCTION, 1, ALICE, 123_457)] }] });
    await service.finalize(AUCTION);
    expect(Number.isSafeInteger(auction(mongo).winningBidAmountMinor)).toBe(true);
    expect(auction(mongo).winningBidAmountMinor).toBe(123_457);
  });

  it('persists a non-PII snapshot only: no email/phone/name/profile fields on the auction', async () => {
    const { service, mongo } = build();
    const before = new Set(Object.keys(auction(mongo)));
    await service.finalize(AUCTION);
    const added = Object.keys(auction(mongo)).filter((k) => !before.has(k)).sort();
    expect(added).toEqual(['completedAt', 'winnerAccountId', 'winnerAccountTypeSnapshot', 'winningBidAcceptedAt', 'winningBidAmountMinor', 'winningBidId', 'winningBidSequence']);
    expect(JSON.stringify(auction(mongo))).not.toMatch(/email|phone|fullName|firstName|lastName|name/i);
  });
});

describe('idempotency and concurrency (MAZAD-030)', () => {
  it('repeated close converges: same result, no second write, no second audit', async () => {
    const { service, mongo } = build();
    const first = await service.finalize(AUCTION);
    const versionAfterFirst = mongo.data.auctions.get(AUCTION)!.version;
    const second = await service.finalize(AUCTION);
    expect(second).toEqual({ ...first, outcome: 'ALREADY_FINALIZED' });
    expect(mongo.data.auctions.get(AUCTION)!.version).toBe(versionAfterFirst);
    expect(finalizedAudits(mongo)).toHaveLength(1);
  });

  it('concurrent finalizers converge on ONE winner, one FINALIZED, one audit', async () => {
    const bids = [bidRow(AUCTION, 1, ALICE, 100_000), bidRow(AUCTION, 2, BOB, 105_000)];
    const { service, mongo } = build({ auctions: [{ bids }] });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => service.finalize(AUCTION)));
    expect(results.filter((r) => r.outcome === 'FINALIZED')).toHaveLength(1);
    expect(new Set(results.map((r) => `${r.winningBidSequence}:${r.winningBidAmountMinor}:${+r.finalizedAt}`)).size).toBe(1);
    expect(finalizedAudits(mongo)).toHaveLength(1);
    expect(String(auction(mongo).winnerAccountId)).toBe(BOB);
  });

  it('a later/stale finalizer can never overwrite a persisted winner, even if the ledger is later tampered with', async () => {
    const { service, mongo, rows, clock } = build();
    await service.finalize(AUCTION);
    const winner = { ...auction(mongo) };
    rows.push(bidRow(AUCTION, 2, BOB, 900_000)); // a higher row appearing after finalization
    mongo.data.auctions.get(AUCTION)!.doc.acceptedBidCount = 2;
    clock.now.mockReturnValue(new Date('2027-01-01T00:00:00Z'));
    const again = await service.finalize(AUCTION);
    expect(again).toMatchObject({ outcome: 'ALREADY_FINALIZED', winningBidSequence: 1, winningBidAmountMinor: 100_000 });
    expect(auction(mongo)).toMatchObject({ winningBidId: winner.winningBidId, completedAt: winner.completedAt, winningBidAmountMinor: 100_000 });
  });

  it('the conditional write refuses an already-finalized document (guards a stale finalizer at the database level)', async () => {
    const { mongo } = build();
    auction(mongo).status = AuctionStatus.COMPLETED; auction(mongo).winningBidId = new Types.ObjectId();
    const s = await mongo.connection.startSession(); s.startTransaction();
    const stale = await mongo.model('auctions').findOneAndUpdate(
      { _id: oid(AUCTION), status: AuctionStatus.ENDED_PENDING_CLOSE, winningBidId: { $exists: false } },
      { $set: { status: AuctionStatus.COMPLETED, winningBidId: new Types.ObjectId() } }, { session: s } as any,
    ).exec();
    expect(stale).toBeNull();
  });

  it('retries a transient commit failure and still finalizes exactly once', async () => {
    const { service, mongo } = build();
    let fail = true;
    const original = mongo.connection.startSession;
    mongo.connection.startSession = async () => {
      const session: any = await original();
      const commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => { if (fail) { fail = false; throw transient('commit failed'); } return commit(); };
      return session;
    };
    const result = await service.finalize(AUCTION);
    expect(result.outcome).toBe('FINALIZED');
    expect(finalizedAudits(mongo)).toHaveLength(1);
    expect(auction(mongo).status).toBe(AuctionStatus.COMPLETED);
  });

  it('an audit failure aborts the whole finalization (no winner, still ENDED_PENDING_CLOSE), and a retry then succeeds', async () => {
    const { service, mongo } = build();
    mongo.auditSvc.logSystemRequired.mockRejectedValueOnce(new Error('audit down'));
    await expect(service.finalize(AUCTION)).rejects.toThrow('audit down');
    expect(auction(mongo)).toMatchObject({ status: AuctionStatus.ENDED_PENDING_CLOSE });
    expect(auction(mongo).winningBidId).toBeUndefined();
    expect((await service.finalize(AUCTION)).outcome).toBe('FINALIZED');
    expect(finalizedAudits(mongo)).toHaveLength(1);
  });

  it('COMPLETED is terminal in the state machine: nothing transitions out of it', () => {
    expect(AUCTION_TRANSITIONS[AuctionStatus.COMPLETED].size).toBe(0);
    expect([...AUCTION_TRANSITIONS[AuctionStatus.ENDED_PENDING_CLOSE]]).toEqual([AuctionStatus.COMPLETED]);
  });
});

describe('lifecycle boundaries: only ENDED_PENDING_CLOSE closes (MAZAD-030)', () => {
  it.each([AuctionStatus.ACTIVE, AuctionStatus.SCHEDULED, AuctionStatus.ENDED_NO_BIDS, AuctionStatus.CANCELLED])(
    'a %s auction is never finalized, gets no winner and keeps its bids', async (status) => {
      const bids = [bidRow(AUCTION, 1, ALICE, 100_000)];
      const { service, mongo, rows } = build({ auctions: [{ status, bids }] });
      const before = JSON.stringify(rows);
      expect(await codeOf(() => service.finalize(AUCTION))).toBe(AuctionErrorCode.TRANSITION_INVALID);
      expect(auction(mongo).status).toBe(status);
      expect(auction(mongo).winningBidId).toBeUndefined();
      expect(auction(mongo).winnerAccountId).toBeUndefined();
      expect(JSON.stringify(rows)).toBe(before);
      expect(finalizedAudits(mongo)).toHaveLength(0);
    });

  it('an unknown or malformed auction id is a 404', async () => {
    const { service } = build();
    expect(await codeOf(() => service.finalize('nope'))).toBe(AuctionErrorCode.NOT_FOUND);
    expect(await codeOf(() => service.finalize(new Types.ObjectId().toString()))).toBe(AuctionErrorCode.NOT_FOUND);
  });
});

describe('ledger consistency fails CLOSED (MAZAD-030)', () => {
  const stays = (mongo: FakeMongo) => {
    expect(auction(mongo).status).toBe(AuctionStatus.ENDED_PENDING_CLOSE);
    expect(auction(mongo).winningBidId).toBeUndefined();
    expect(finalizedAudits(mongo)).toHaveLength(0);
  };

  it('ENDED_PENDING_CLOSE with zero Bid rows is an inconsistency, NOT silently ENDED_NO_BIDS', async () => {
    const { service, mongo } = build({ auctions: [{ bids: [], counter: 0 }] });
    const error: any = await service.finalize(AUCTION).catch((e) => e);
    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect(error.getResponse().code).toBe(BidErrorCode.LEDGER_INCONSISTENT);
    stays(mongo);
  });

  it.each([[5], [0], [1]])('acceptedBidCount %p disagreeing with 2 ledger rows blocks finalization', async (counter) => {
    const bids = [bidRow(AUCTION, 1, ALICE, 100_000), bidRow(AUCTION, 2, BOB, 105_000)];
    const { service, mongo } = build({ auctions: [{ bids, counter }] });
    expect(await codeOf(() => service.finalize(AUCTION))).toBe(BidErrorCode.LEDGER_INCONSISTENT);
    stays(mongo);
  });

  it('non-dense sequences (a gap) block finalization', async () => {
    const bids = [bidRow(AUCTION, 1, ALICE, 100_000), bidRow(AUCTION, 3, BOB, 105_000)];
    const { service, mongo } = build({ auctions: [{ bids, counter: 2 }] });
    expect(await codeOf(() => service.finalize(AUCTION))).toBe(BidErrorCode.LEDGER_INCONSISTENT);
    stays(mongo);
  });

  it('a winning bid whose currency disagrees with the auction blocks finalization', async () => {
    const { service, mongo } = build({ auctions: [{ bids: [bidRow(AUCTION, 1, ALICE, 100_000, { currency: 'USD' })] }] });
    expect(await codeOf(() => service.finalize(AUCTION))).toBe(BidErrorCode.LEDGER_INCONSISTENT);
    stays(mongo);
  });

  it('a winning amount below the starting price blocks finalization', async () => {
    const { service, mongo } = build({ auctions: [{ bids: [bidRow(AUCTION, 1, ALICE, 50_000)] }] });
    expect(await codeOf(() => service.finalize(AUCTION))).toBe(BidErrorCode.LEDGER_INCONSISTENT);
    stays(mongo);
  });
});

describe('finalization worker pass (MAZAD-030)', () => {
  const three = () => build({
    auctions: [
      { id: AUCTION, currentEndAt: new Date(END.getTime() + 2 * 60_000), bids: [bidRow(AUCTION, 1, ALICE, 100_000)] },
      { id: AUCTION_2, currentEndAt: END, bids: [bidRow(AUCTION_2, 1, BOB, 110_000)] },
      { id: AUCTION_3, currentEndAt: new Date(END.getTime() + 60_000), bids: [bidRow(AUCTION_3, 1, CAROL, 120_000)] },
    ],
  });

  it('finalizes only ENDED_PENDING_CLOSE auctions, oldest end first, bounded by the batch size', async () => {
    const { service, mongo } = three();
    mongo.seedAuction({ _id: oid('64b000000000000000000f09'), status: AuctionStatus.ACTIVE, currentEndAt: new Date(END.getTime() - 1), acceptedBidCount: 0, startingPriceMinor: 1, currency: 'EGP' });
    const first = await service.finalizeDueAuctions(2);
    expect(first).toMatchObject({ finalized: 2, failed: 0 });
    expect(auction(mongo, AUCTION_2).status).toBe(AuctionStatus.COMPLETED); // earliest currentEndAt
    expect(auction(mongo, AUCTION_3).status).toBe(AuctionStatus.COMPLETED);
    expect(auction(mongo, AUCTION).status).toBe(AuctionStatus.ENDED_PENDING_CLOSE); // beyond the batch
    expect(mongo.data.auctions.get('64b000000000000000000f09')!.doc.status).toBe(AuctionStatus.ACTIVE); // never touched
    const second = await service.finalizeDueAuctions(2);
    expect(second.finalized).toBe(1);
    expect(auction(mongo, AUCTION).status).toBe(AuctionStatus.COMPLETED);
  });

  it('a repeated pass is a safe no-op', async () => {
    const { service, mongo } = three();
    await service.finalizeDueAuctions();
    expect(await service.finalizeDueAuctions()).toEqual({ finalized: 0, alreadyFinalized: 0, failed: 0, skippedInBackoff: 0 });
    expect(finalizedAudits(mongo)).toHaveLength(3);
  });

  it('one failing auction does not stop the rest, and is not retried every tick (backoff, no starvation)', async () => {
    const { service, mongo, rows } = three();
    rows.push(bidRow(AUCTION_2, 9, ALICE, 500_000)); // corrupt AUCTION_2 (count 2 vs counter 1, gap)
    const first = await service.finalizeDueAuctions();
    expect(first).toMatchObject({ finalized: 2, failed: 1 });
    expect(auction(mongo, AUCTION_2).status).toBe(AuctionStatus.ENDED_PENDING_CLOSE);
    const second = await service.finalizeDueAuctions();
    expect(second).toMatchObject({ finalized: 0, failed: 0, skippedInBackoff: 1 });
  });

  it('two overlapping passes converge: every auction has exactly one winner and one audit', async () => {
    const { service, mongo } = three();
    const [a, b] = await Promise.all([service.finalizeDueAuctions(), service.finalizeDueAuctions()]);
    expect(a.finalized + b.finalized).toBe(3);
    expect(finalizedAudits(mongo)).toHaveLength(3);
    for (const id of [AUCTION, AUCTION_2, AUCTION_3]) expect(auction(mongo, id).status).toBe(AuctionStatus.COMPLETED);
  });

  describe('AuctionFinalizationWorker', () => {
    const cfg = (values: Record<string, string> = {}) => ({ get: (k: string) => values[k] }) as any;
    it('is disabled under NODE_ENV=test by default and configurable like the lifecycle worker', () => {
      const svc = { finalizeDueAuctions: jest.fn().mockResolvedValue({ finalized: 0, alreadyFinalized: 0, failed: 0, skippedInBackoff: 0 }) } as any;
      expect(new AuctionFinalizationWorker(svc, cfg({ NODE_ENV: 'test' })).enabled).toBe(false);
      expect(new AuctionFinalizationWorker(svc, cfg({ NODE_ENV: 'production' })).enabled).toBe(true);
      expect(new AuctionFinalizationWorker(svc, cfg({ AUCTION_FINALIZATION_WORKER_ENABLED: 'false', NODE_ENV: 'production' })).enabled).toBe(false);
      expect(new AuctionFinalizationWorker(svc, cfg({ AUCTION_FINALIZATION_INTERVAL_SECONDS: '1' })).intervalMs).toBe(5_000);
      expect(new AuctionFinalizationWorker(svc, cfg({ AUCTION_FINALIZATION_INTERVAL_SECONDS: '60' })).intervalMs).toBe(60_000);
    });
    it('clamps the batch size, runs the service, and never overlaps itself', async () => {
      let release!: () => void;
      const svc = { finalizeDueAuctions: jest.fn(() => new Promise((resolve) => { release = () => resolve({ finalized: 1, alreadyFinalized: 0, failed: 0, skippedInBackoff: 0 }); })) } as any;
      const worker = new AuctionFinalizationWorker(svc, cfg({ AUCTION_FINALIZATION_BATCH_SIZE: '99999' }));
      const running = worker.runOnce();
      expect(await worker.runOnce()).toBeNull(); // re-entrancy guard (a convenience; correctness is in the DB transaction)
      release();
      expect(await running).toMatchObject({ finalized: 1 });
      expect(svc.finalizeDueAuctions).toHaveBeenCalledWith(200);
      expect(worker.lastSummary).toMatchObject({ finalized: 1 });
    });
    it('a failed pass is logged (no PII) and does not throw', async () => {
      const svc = { finalizeDueAuctions: jest.fn().mockRejectedValue(new Error('boom')) } as any;
      const worker = new AuctionFinalizationWorker(svc, cfg());
      expect(await worker.runOnce()).toBeNull();
    });
  });
});

describe('projections and privacy (MAZAD-030)', () => {
  const completed = {
    _id: oid(AUCTION), propertyId: oid('64b000000000000000000b01'), propertyRevisionId: oid('64b000000000000000000b02'), advertiserAccountId: oid('64b000000000000000000a10'),
    advertiserAccountTypeSnapshot: 'user', createdByActorId: oid('64b000000000000000000a10'), status: AuctionStatus.COMPLETED, startingPriceMinor: 100_000, minimumBidStepMinor: 5_000,
    currency: 'EGP', scheduledStartAt: END, scheduledEndAt: END, currentEndAt: END, ruleSnapshot: {}, createdAt: END, updatedAt: END,
    completedAt: NOW, winnerAccountId: oid(BOB), winnerAccountTypeSnapshot: 'broker', winningBidId: oid('64b000000000000000000d01'), winningBidSequence: 4, winningBidAmountMinor: 255_000, winningBidAcceptedAt: END,
  };

  it('the public projection carries the outcome (amount, sequence, currency, time) but NEVER the winner identity', () => {
    const view: any = toPublicAuction(completed, {});
    expect(view.result).toEqual({ winningBidAmountMinor: 255_000, winningBidSequence: 4, currency: 'EGP', finalizedAt: NOW });
    const text = JSON.stringify(view);
    expect(text).not.toMatch(new RegExp(`${BOB}|winnerAccount|winningBidId|d01|broker|accountType`, 'i'));
  });

  it('the own (seller) projection shows the outcome but not the winner identity, and offers no way to choose one', () => {
    const view: any = toOwnAuction(completed, null);
    expect(view.result).toMatchObject({ winningBidAmountMinor: 255_000, winningBidSequence: 4 });
    expect(JSON.stringify(view)).not.toMatch(new RegExp(`${BOB}|winnerAccount|winningBidId`, 'i'));
  });

  it('only the read-only staff projection references the winner (account id, bid id, type snapshot) — still no profile data', () => {
    const view: any = toAdminAuction(completed);
    expect(view.winner).toEqual({ accountId: BOB, accountTypeSnapshot: 'broker', bidId: '64b000000000000000000d01', acceptedAt: END });
    expect(JSON.stringify(view)).not.toMatch(/email|phone|name/i);
  });

  it('non-COMPLETED auctions expose no result/winner at all', () => {
    for (const status of [AuctionStatus.ACTIVE, AuctionStatus.ENDED_PENDING_CLOSE, AuctionStatus.ENDED_NO_BIDS, AuctionStatus.CANCELLED]) {
      const doc = { ...completed, status };
      expect((toPublicAuction(doc, {}) as any).result).toBeUndefined();
      expect((toAdminAuction(doc) as any).winner).toBeUndefined();
    }
  });

  it('the audit event carries ids/amounts only — no bidder data', async () => {
    const { service, mongo } = build();
    await service.finalize(AUCTION);
    const [event] = finalizedAudits(mongo);
    expect(Object.keys(event.metadata).sort()).toEqual(['acceptedBidCount', 'currency', 'finalizedAt', 'winningBidAmountMinor', 'winningBidId', 'winningBidSequence']);
    expect(JSON.stringify(event)).not.toContain(ALICE);
  });

  it('there is no HTTP surface to finalize, select or override a winner (seller or admin)', () => {
    for (const controller of [AuctionsController, AdminAuctionsController]) {
      const names = Object.getOwnPropertyNames(controller.prototype).filter((n) => n !== 'constructor');
      expect(names.filter((n) => /final|close|winner|complete|select|override/i.test(n))).toEqual([]);
    }
    const admin = Object.getOwnPropertyNames(AdminAuctionsController.prototype).filter((n) => n !== 'constructor');
    for (const n of admin) expect(Reflect.getMetadata('method', (AdminAuctionsController.prototype as any)[n])).toBe(0); // RequestMethod.GET
  });

  it('the finalization code is bid-read-only and adds no payment, outbox, realtime or promotion behaviour', () => {
    const fs = require('node:fs'); const path = require('node:path');
    const text = ['auction-finalization.service.ts', 'auction-finalization.worker.ts'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'auctions', f), 'utf8')).join('\n');
    expect(text).not.toMatch(/ledger\.(create|append)|bids\.(create|update|delete|insert)|Model<Bid/);
    expect(text).not.toMatch(/from '\.\.\/payments|@nestjs\/websockets|@Sse|outbox|EventEmitter/i);
  });
});
