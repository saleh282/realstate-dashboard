'use strict';

const { Types } = require('mongoose');
const { SystemRole } = require('../../src/domain/auth/roles.enum');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
} = require('../../src/domain/users/identity.types');
const { FakeOutboxStore } = require('./fake-outbox');
/**
 * Shared in-memory MongoDB model for the MAZAD-028 payment suites: snapshot
 * reads per transaction, single-writer-per-document WriteConflict, commit-time
 * stale check, unique indexes, abort discarding buffered writes. A MODEL, not
 * MongoDB — real-Mongo qualification is still required.
 */
const oid = (hex) => new Types.ObjectId(hex);
const ADMIN_UNUSED = '';
void ADMIN_UNUSED;
const tick = () => Promise.resolve();
const transient = (m) =>
  Object.assign(new Error(m), {
    code: 112,
    hasErrorLabel: (l) => l === 'TransientTransactionError',
  });
const dupKey = (index) =>
  Object.assign(new Error(`E11000 duplicate key ${index}`), { code: 11000 });
const COLLS = ['users', 'requests', 'mmPayments'];
class FakeMongo {
  constructor() {
    this.data = { users: new Map(), requests: new Map(), mmPayments: new Map() };
    this.audits = [];
    this.locks = new Map();
    this.nextTxn = 1;
    this.clockNow = new Date('2026-05-02T10:00:00Z');
    /** MAZAD-031: the outbox collection model. Its rows follow every session's commit/abort (see `FakeOutboxStore`). */
    this.outbox = new FakeOutboxStore();
    this.connection = {
      startSession: async () => {
        const mongo = this;
        let txn;
        const session = {
          get txn() {
            return txn;
          },
          startTransaction() {
            txn = {
              id: mongo.nextTxn++,
              active: true,
              audits: [],
              snap: {},
              writes: {},
              inserts: {},
            };
            for (const c of COLLS) {
              txn.snap[c] = new Map(
                [...mongo.data[c]].map(([k, v]) => [k, { doc: { ...v.doc }, version: v.version }]),
              );
              txn.writes[c] = new Map();
              txn.inserts[c] = [];
            }
          },
          inTransaction: () => Boolean(txn?.active),
          async commitTransaction() {
            for (let i = 0; i < 3; i++) await tick();
            const t = txn;
            const fail = (e) => {
              mongo.release(t);
              t.active = false;
              throw e;
            };
            for (const c of COLLS)
              for (const id of t.writes[c].keys())
                if (mongo.data[c].get(id).version !== t.snap[c].get(id).version)
                  fail(transient('stale snapshot at commit'));
            for (const c of COLLS)
              for (const row of t.inserts[c]) {
                const v = mongo.uniqueViolation(c, row, mongo.rows(c));
                if (v) fail(dupKey(v));
              }
            for (const c of COLLS) {
              for (const [id, doc] of t.writes[c]) {
                const rec = mongo.data[c].get(id);
                rec.doc = doc;
                rec.version += 1;
              }
              for (const row of t.inserts[c])
                mongo.data[c].set(row._id.toString(), { doc: row, version: 1 });
            }
            mongo.audits.push(...t.audits);
            mongo.release(t);
            t.active = false;
          },
          async abortTransaction() {
            if (txn?.active) {
              mongo.release(txn);
              txn.active = false;
            }
          },
          async endSession() {
            if (txn?.active) {
              mongo.release(txn);
              txn.active = false;
            }
          },
          async withTransaction(fn) {
            this.startTransaction();
            await fn();
            await this.commitTransaction();
          },
        };
        mongo.outbox.attach(session);
        return session;
      },
    };
    this.auditSvc = {
      logRequired: jest.fn(async (options, session) => {
        await tick();
        session.txn.audits.push(options);
      }),
      logSystemRequired: jest.fn(async (options, session) => {
        await tick();
        session.txn.audits.push(options);
      }),
    };
  }
  seedUser(id, o = {}) {
    this.data.users.set(id, {
      doc: {
        _id: oid(id),
        systemRole: SystemRole.USER,
        accountType: AccountType.USER,
        accountStatus: AccountStatus.ACTIVE,
        brokerStatus: BrokerStatus.NOT_APPLIED,
        ...o,
      },
      version: 1,
    });
  }
  rows(name) {
    return [...this.data[name].values()].map((r) => r.doc);
  }
  release(t) {
    for (const [k, v] of this.locks) if (v === t.id) this.locks.delete(k);
  }
  uniqueViolation(name, row, others) {
    const same = (a, b, keys) => keys.every((k) => String(a[k]) === String(b[k]));
    if (
      name === 'mmPayments' &&
      row.isLive &&
      others.some((o) => o.isLive && same(o, row, ['requestId']))
    )
      return 'mm_payment_one_live_per_request';
    return undefined;
  }
  match(doc, filter) {
    return Object.entries(filter).every(([k, expected]) => {
      const actual = doc[k];
      if (
        expected &&
        typeof expected === 'object' &&
        !(expected instanceof Types.ObjectId) &&
        !(expected instanceof Date)
      ) {
        if ('$exists' in expected)
          return expected.$exists ? actual !== undefined : actual === undefined;
        if ('$in' in expected) return expected.$in.includes(actual);
        const ms = (v) => (v instanceof Date ? v.getTime() : v);
        if ('$lte' in expected) return actual !== undefined && ms(actual) <= ms(expected.$lte);
        if ('$lt' in expected) return actual !== undefined && ms(actual) < ms(expected.$lt);
        if ('$gte' in expected) return actual !== undefined && ms(actual) >= ms(expected.$gte);
        if ('$gt' in expected) return actual !== undefined && ms(actual) > ms(expected.$gt);
      }
      return actual !== undefined && String(actual) === String(expected);
    });
  }
  view(c, txn) {
    if (!txn) return this.rows(c);
    const out = new Map();
    for (const [k, v] of txn.snap[c]) out.set(k, txn.writes[c].get(k) ?? v.doc);
    return [...out.values(), ...txn.inserts[c]];
  }
  apply(doc, update) {
    const next = { ...doc };
    for (const [k, v] of Object.entries(update.$set ?? {})) next[k] = v;
    for (const k of Object.keys(update.$unset ?? {})) delete next[k];
    for (const [k, v] of Object.entries(update.$inc ?? {})) next[k] = (next[k] ?? 0) + v;
    return next;
  }
  write(c, filter, update, txn, sort) {
    const ordered = (rows) =>
      sort
        ? [...rows].sort((a, b) => {
            for (const [k, d] of Object.entries(sort)) {
              const x = a[k] instanceof Date ? a[k].getTime() : a[k];
              const y = b[k] instanceof Date ? b[k].getTime() : b[k];
              if (x < y) return -d;
              if (x > y) return d;
            }
            return 0;
          })
        : rows;
    if (txn) {
      const current = ordered(this.view(c, txn)).find((d) => this.match(d, filter));
      if (!current) return null;
      const id = current._id.toString();
      if (this.data[c].get(id).version !== txn.snap[c].get(id).version)
        throw transient('write conflict: changed since snapshot');
      const holder = this.locks.get(`${c}:${id}`);
      if (holder !== undefined && holder !== txn.id)
        throw transient('write conflict: locked by another transaction');
      const next = this.apply(current, update);
      txn.writes[c].set(id, next);
      this.locks.set(`${c}:${id}`, txn.id);
      return next;
    }
    const rec = ordered([...this.data[c].values()].map((r) => r.doc))
      .map((d) => this.data[c].get(d._id.toString()))
      .find((r) => this.match(r.doc, filter));
    if (!rec) return null;
    rec.doc = this.apply(rec.doc, update);
    rec.version += 1;
    return rec.doc;
  }
  model(c) {
    const read = (compute) => {
      let txn;
      let sortSpec;
      const chain = {
        session: (s) => {
          txn = s?.txn;
          return chain;
        },
        lean: () => chain,
        select: () => chain,
        sort: (spec) => {
          sortSpec = spec;
          return chain;
        },
        exec: async () => {
          await tick();
          const rows = this.view(c, txn);
          const ordered = sortSpec
            ? [...rows].sort((a, b) => {
                for (const [k, d] of Object.entries(sortSpec)) {
                  const x = a[k] instanceof Date ? a[k].getTime() : a[k];
                  const y = b[k] instanceof Date ? b[k].getTime() : b[k];
                  if (x < y) return -d;
                  if (x > y) return d;
                }
                return 0;
              })
            : rows;
          return compute(ordered);
        },
      };
      return chain;
    };
    return {
      findById: (id) => read((rows) => rows.find((d) => String(d._id) === String(id)) ?? null),
      findOne: (f) => read((rows) => rows.find((d) => this.match(d, f)) ?? null),
      exists: (f) => read((rows) => (rows.some((d) => this.match(d, f)) ? { _id: 'x' } : null)),
      create: async (docs, o) => {
        await tick();
        const txn = o.session.txn;
        const out = [];
        for (const d of docs) {
          const row = { _id: new Types.ObjectId(), createdAt: new Date(), ...d };
          const v = this.uniqueViolation(c, row, [...this.view(c, txn)]);
          if (v) throw dupKey(v);
          txn.inserts[c].push(row);
          out.push({ ...row, toObject: () => ({ ...row }) });
        }
        return out;
      },
      findOneAndUpdate: (f, u, o = {}) => {
        const chain = {
          lean: () => chain,
          exec: async () => {
            await tick();
            const r = this.write(c, f, u, o.session?.txn, o.sort);
            return r
              ? Object.defineProperty({ ...r }, 'toObject', {
                  value: () => ({ ...r }),
                  enumerable: false,
                })
              : null;
          },
        };
        return chain;
      },
      updateOne: (f, u, o = {}) => ({
        exec: async () => {
          await tick();
          const r = this.write(c, f, u, o.session?.txn);
          return { matchedCount: r ? 1 : 0, modifiedCount: r ? 1 : 0 };
        },
      }),
    };
  }
}

Object.assign(exports, { tick, transient, dupKey, FakeMongo });
