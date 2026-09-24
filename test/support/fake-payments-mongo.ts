import { Types } from 'mongoose';
import { AuctionStatus } from '../../src/auctions/auction.types';
import { SystemRole } from '../../src/auth/roles.enum';
import { AccountStatus, AccountType, BrokerStatus } from '../../src/users/identity.types';
import { FakeOutboxStore } from './fake-outbox';

/**
 * Shared in-memory MongoDB model for the MAZAD-028 payment suites: snapshot
 * reads per transaction, single-writer-per-document WriteConflict, commit-time
 * stale check, unique indexes, abort discarding buffered writes. A MODEL, not
 * MongoDB — real-Mongo qualification is still required.
 */
const oid = (hex: string) => new Types.ObjectId(hex);
const AUCTION = '64b000000000000000000f01';
const ADVERTISER = '64b000000000000000000a10';
const ADMIN_UNUSED = '';
void ADMIN_UNUSED;

export const tick = () => Promise.resolve();
export const transient = (m: string) => Object.assign(new Error(m), { code: 112, hasErrorLabel: (l: string) => l === 'TransientTransactionError' });
export const dupKey = (index: string) => Object.assign(new Error(`E11000 duplicate key ${index}`), { code: 11000 });

export type Rec = { doc: any; version: number };
type Txn = { id: number; active: boolean; snap: Record<string, Map<string, Rec>>; writes: Record<string, Map<string, any>>; inserts: Record<string, any[]>; audits: any[] };
const COLLS = ['auctions', 'users', 'payments', 'entitlements', 'requests', 'mmPayments'] as const;

export class FakeMongo {
  data: Record<string, Map<string, Rec>> = { auctions: new Map(), users: new Map(), payments: new Map(), entitlements: new Map(), requests: new Map(), mmPayments: new Map() };
  audits: any[] = [];
  locks = new Map<string, number>();
  nextTxn = 1;
  sessionsSeenByPort: any[] = [];
  auctionWrites = 0;
  clockNow = new Date('2026-05-02T10:00:00Z');
  /** MAZAD-031: the outbox collection model. Its rows follow every session's commit/abort (see `FakeOutboxStore`). */
  outbox = new FakeOutboxStore();

  seedAuction(overrides: Record<string, unknown> = {}) {
    const doc = { _id: oid(AUCTION), advertiserAccountId: oid(ADVERTISER), status: AuctionStatus.SCHEDULED, ...overrides };
    this.data.auctions.set(doc._id.toString(), { doc, version: 1 });
    return doc;
  }
  seedUser(id: string, o: Record<string, unknown> = {}) {
    this.data.users.set(id, { doc: { _id: oid(id), systemRole: SystemRole.USER, accountType: AccountType.USER, accountStatus: AccountStatus.ACTIVE, brokerStatus: BrokerStatus.NOT_APPLIED, ...o }, version: 1 });
  }
  rows(name: string) { return [...this.data[name].values()].map((r) => r.doc); }
  auction(id = AUCTION) { return this.data.auctions.get(id)!.doc; }

  private release(t: Txn) { for (const [k, v] of this.locks) if (v === t.id) this.locks.delete(k); }
  private uniqueViolation(name: string, row: any, others: any[]) {
    const same = (a: any, b: any, keys: string[]) => keys.every((k) => String(a[k]) === String(b[k]));
    if (name === 'entitlements') {
      if (others.some((o) => same(o, row, ['auctionId', 'bidderAccountId']))) return 'entitlement_auction_bidder';
      if (others.some((o) => same(o, row, ['paymentId']))) return 'entitlement_payment';
    }
    if (name === 'mmPayments' && row.isLive && others.some((o) => o.isLive && same(o, row, ['requestId']))) return 'mm_payment_one_live_per_request';
    if (name === 'payments' && row.isLive && others.some((o) => o.isLive && same(o, row, ['auctionId', 'bidderAccountId']))) return 'entry_payment_one_live_per_bidder_auction';
    return undefined;
  }

  connection = {
    startSession: async () => {
      const mongo = this;
      let txn: Txn | undefined;
      const session: any = {
        get txn() { return txn; },
        startTransaction() {
          txn = { id: mongo.nextTxn++, active: true, audits: [], snap: {}, writes: {}, inserts: {} };
          for (const c of COLLS) {
            txn.snap[c] = new Map([...mongo.data[c]].map(([k, v]) => [k, { doc: { ...v.doc }, version: v.version }]));
            txn.writes[c] = new Map(); txn.inserts[c] = [];
          }
        },
        inTransaction: () => Boolean(txn?.active),
        async commitTransaction() {
          for (let i = 0; i < 3; i++) await tick();
          const t = txn!;
          const fail = (e: Error) => { mongo.release(t); t.active = false; throw e; };
          for (const c of COLLS) for (const id of t.writes[c].keys()) if (mongo.data[c].get(id)!.version !== t.snap[c].get(id)!.version) fail(transient('stale snapshot at commit'));
          for (const c of COLLS) for (const row of t.inserts[c]) {
            const v = mongo.uniqueViolation(c, row, mongo.rows(c)); if (v) fail(dupKey(v));
          }
          for (const c of COLLS) {
            for (const [id, doc] of t.writes[c]) { const rec = mongo.data[c].get(id)!; rec.doc = doc; rec.version += 1; }
            for (const row of t.inserts[c]) mongo.data[c].set(row._id.toString(), { doc: row, version: 1 });
          }
          mongo.audits.push(...t.audits);
          mongo.release(t); t.active = false;
        },
        async abortTransaction() { if (txn?.active) { mongo.release(txn); txn.active = false; } },
        async endSession() { if (txn?.active) { mongo.release(txn); txn.active = false; } },
        async withTransaction(fn: () => Promise<void>) { this.startTransaction(); await fn(); await this.commitTransaction(); },
      };
      mongo.outbox.attach(session);
      return session;
    },
  };

  private match(doc: any, filter: any): boolean {
    return Object.entries(filter).every(([k, expected]: [string, any]) => {
      const actual = doc[k];
      if (expected && typeof expected === 'object' && !(expected instanceof Types.ObjectId) && !(expected instanceof Date)) {
        if ('$exists' in expected) return expected.$exists ? actual !== undefined : actual === undefined;
        if ('$in' in expected) return expected.$in.includes(actual);
        const ms = (v: any) => (v instanceof Date ? v.getTime() : v);
        if ('$lte' in expected) return actual !== undefined && ms(actual) <= ms(expected.$lte);
        if ('$lt' in expected) return actual !== undefined && ms(actual) < ms(expected.$lt);
        if ('$gte' in expected) return actual !== undefined && ms(actual) >= ms(expected.$gte);
        if ('$gt' in expected) return actual !== undefined && ms(actual) > ms(expected.$gt);
      }
      return actual !== undefined && String(actual) === String(expected);
    });
  }
  private view(c: string, txn: Txn | undefined) {
    if (!txn) return this.rows(c);
    const out = new Map<string, any>();
    for (const [k, v] of txn.snap[c]) out.set(k, txn.writes[c].get(k) ?? v.doc);
    return [...out.values(), ...txn.inserts[c]];
  }
  private apply(doc: any, update: any) {
    const next = { ...doc };
    for (const [k, v] of Object.entries(update.$set ?? {})) next[k] = v;
    for (const k of Object.keys(update.$unset ?? {})) delete next[k];
    for (const [k, v] of Object.entries(update.$inc ?? {})) next[k] = (next[k] ?? 0) + (v as number);
    return next;
  }
  private write(c: string, filter: any, update: any, txn: Txn | undefined, sort?: Record<string, 1 | -1>) {
    const ordered = (rows: any[]) => (sort ? [...rows].sort((a, b) => { for (const [k, d] of Object.entries(sort)) { const x = a[k] instanceof Date ? a[k].getTime() : a[k]; const y = b[k] instanceof Date ? b[k].getTime() : b[k]; if (x < y) return -d; if (x > y) return d; } return 0; }) : rows);
    if (c === 'auctions') this.auctionWrites++;
    if (txn) {
      const current = ordered(this.view(c, txn)).find((d) => this.match(d, filter));
      if (!current) return null;
      const id = current._id.toString();
      if (this.data[c].get(id)!.version !== txn.snap[c].get(id)!.version) throw transient('write conflict: changed since snapshot');
      const holder = this.locks.get(`${c}:${id}`);
      if (holder !== undefined && holder !== txn.id) throw transient('write conflict: locked by another transaction');
      const next = this.apply(current, update);
      txn.writes[c].set(id, next); this.locks.set(`${c}:${id}`, txn.id);
      return next;
    }
    const rec = ordered([...this.data[c].values()].map((r) => r.doc)).map((d) => this.data[c].get(d._id.toString())!).find((r) => this.match(r.doc, filter));
    if (!rec) return null;
    rec.doc = this.apply(rec.doc, update); rec.version += 1;
    return rec.doc;
  }

  model(c: (typeof COLLS)[number]) {
    const read = (compute: (rows: any[]) => any) => {
      let txn: Txn | undefined;
      let sortSpec: Record<string, 1 | -1> | undefined;
      const chain: any = {
        session: (s: any) => { txn = s?.txn; if (c === 'entitlements') this.sessionsSeenByPort.push(s); return chain; }, lean: () => chain, select: () => chain,
        sort: (spec: Record<string, 1 | -1>) => { sortSpec = spec; return chain; },
        exec: async () => {
          await tick();
          const rows = this.view(c, txn);
          const ordered = sortSpec ? [...rows].sort((a, b) => { for (const [k, d] of Object.entries(sortSpec!)) { const x = a[k] instanceof Date ? a[k].getTime() : a[k]; const y = b[k] instanceof Date ? b[k].getTime() : b[k]; if (x < y) return -d; if (x > y) return d; } return 0; }) : rows;
          return compute(ordered);
        },
      };
      return chain;
    };
    return {
      findById: (id: any) => read((rows) => rows.find((d) => String(d._id) === String(id)) ?? null),
      findOne: (f: any) => read((rows) => rows.find((d) => this.match(d, f)) ?? null),
      exists: (f: any) => read((rows) => (rows.some((d) => this.match(d, f)) ? { _id: 'x' } : null)),
      create: async (docs: any[], o: any) => {
        await tick();
        const txn: Txn = o.session.txn; const out: any[] = [];
        for (const d of docs) {
          const row = { _id: new Types.ObjectId(), createdAt: new Date(), ...d };
          const v = this.uniqueViolation(c, row, [...this.view(c, txn)]); if (v) throw dupKey(v);
          txn.inserts[c].push(row); out.push({ ...row, toObject: () => ({ ...row }) });
        }
        return out;
      },
      findOneAndUpdate: (f: any, u: any, o: any = {}) => { const chain: any = { lean: () => chain, exec: async () => { await tick(); const r = this.write(c, f, u, o.session?.txn, o.sort); return r ? Object.defineProperty({ ...r }, 'toObject', { value: () => ({ ...r }), enumerable: false }) : null; } }; return chain; },
      updateOne: (f: any, u: any, o: any = {}) => ({ exec: async () => { await tick(); const r = this.write(c, f, u, o.session?.txn); return { matchedCount: r ? 1 : 0, modifiedCount: r ? 1 : 0 }; } }),
    };
  }
  auditSvc = {
    logRequired: jest.fn(async (options: any, session: any) => { await tick(); session.txn.audits.push(options); }),
    logSystemRequired: jest.fn(async (options: any, session: any) => { await tick(); session.txn.audits.push(options); }),
  };
}

