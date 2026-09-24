import { Types } from 'mongoose';
import { OUTBOX_AGGREGATE_VERSION_INDEX } from '../../src/outbox/outbox.constants';
import { OutboxService } from '../../src/outbox/outbox.service';

/**
 * In-memory MODEL of the `outbox_events` collection for the MAZAD-031 suites.
 *
 * Transactional side (`attach(session)`): rows inserted with a session are
 * buffered per transaction and reach the committed set only if that session's
 * commit succeeds; an abort, a failed commit or a retried attempt discards
 * them — exactly the "commit ⇒ event exists, abort ⇒ it never did" invariant.
 * Reads inside a transaction see the committed rows as of `startTransaction`
 * plus the transaction's own inserts (snapshot semantics). The unique
 * `(aggregateType, aggregateId, aggregateVersion)` index is checked on insert
 * and again at commit.
 *
 * Non-transactional side (find / findOne / findOneAndUpdate / updateOne on the
 * committed rows, with dotted paths such as `delivery.realtime.status`, `field: null`
 * matching an absent field, `$or`, `$in`, `$nin`, range operators, `$set`/`$unset`/`$inc`)
 * is what the dispatchers use. Every operation yields once
 * before it runs and then executes synchronously, so two dispatchers started
 * with Promise.all interleave at operation granularity and a conditional
 * update is atomic — the single-document guarantee MongoDB gives.
 *
 * A MODEL, not MongoDB: real-Mongo behaviour remains a release-qualification
 * item.
 */
type Buffer = { snapshot: any[]; inserts: any[] };

const tick = () => Promise.resolve();
/** MongoDB reports a write that collides with a document the transaction cannot see as a transient WriteConflict. */
export const outboxWriteConflict = () => Object.assign(new Error('WriteConflict: outbox aggregate version taken by a concurrent transaction'), { code: 112, hasErrorLabel: (label: string) => label === 'TransientTransactionError' });
export const outboxDuplicateVersion = () =>
  Object.assign(new Error(`E11000 duplicate key error collection: outbox_events index: ${OUTBOX_AGGREGATE_VERSION_INDEX} dup key`), {
    code: 11000,
    keyPattern: { aggregateType: 1, aggregateId: 1, aggregateVersion: 1 },
  });

const comparable = (value: any) => (value instanceof Date ? value.getTime() : value instanceof Types.ObjectId ? value.toString() : value);

/** Dotted-path access, as MongoDB resolves `delivery.realtime.status` (absent intermediate objects read as undefined). */
const getPath = (doc: any, path: string) => path.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), doc);
function setPath(doc: any, path: string, value: any) {
  const keys = path.split('.');
  let cursor = doc;
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] === null || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}
function unsetPath(doc: any, path: string) {
  const keys = path.split('.');
  let cursor = doc;
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] === null || typeof cursor[key] !== 'object') return;
    cursor = cursor[key];
  }
  delete cursor[keys[keys.length - 1]];
}
/** Deep copy that keeps Dates and ObjectIds (what a driver round-trip returns: a fresh object graph). */
function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as any;
  if (value instanceof Types.ObjectId) return value;
  if (Array.isArray(value)) return value.map(clone) as any;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as any;
  return value;
}

function matchesValue(actual: any, expected: any): boolean {
  // `field: null` matches an absent field too — exactly how MongoDB treats it, and what "not yet touched by this consumer" relies on.
  if (expected === null) return actual === null || actual === undefined;
  if (expected && typeof expected === 'object' && !(expected instanceof Date) && !(expected instanceof Types.ObjectId)) {
    return Object.entries(expected).every(([op, operand]: [string, any]) => {
      switch (op) {
        case '$in': return (operand as any[]).some((candidate) => (candidate === null ? actual === null || actual === undefined : comparable(candidate) === comparable(actual)));
        case '$ne': return comparable(actual) !== comparable(operand);
        case '$nin': return !(operand as any[]).some((candidate) => comparable(candidate) === comparable(actual)); // absent fields are "not in"
        case '$lte': return actual !== undefined && comparable(actual) <= comparable(operand);
        case '$lt': return actual !== undefined && comparable(actual) < comparable(operand);
        case '$gte': return actual !== undefined && comparable(actual) >= comparable(operand);
        case '$gt': return actual !== undefined && comparable(actual) > comparable(operand);
        case '$exists': return operand ? actual !== undefined : actual === undefined;
        default: throw new Error(`fake outbox: unsupported operator ${op}`);
      }
    });
  }
  return actual !== undefined && comparable(actual) === comparable(expected);
}
function matches(doc: any, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return (expected as any[]).some((branch) => matches(doc, branch));
    if (key === '$and') return (expected as any[]).every((branch) => matches(doc, branch));
    return matchesValue(getPath(doc, key), expected);
  });
}

/** Absent/null sort lowest, as in MongoDB. */
const rank = (value: any) => (value === null || value === undefined ? [0, 0] : [1, comparable(value)]);
function sortRows(rows: any[], sort?: Record<string, 1 | -1>): any[] {
  if (!sort) return rows;
  return [...rows].sort((a, b) => {
    for (const [key, direction] of Object.entries(sort)) {
      const [ra, x] = rank(getPath(a, key)); const [rb, y] = rank(getPath(b, key));
      if (ra !== rb) return (ra < rb ? -1 : 1) * direction;
      if (x < y) return -direction;
      if (x > y) return direction;
    }
    return 0;
  });
}

/** Applies $set / $unset / $inc IN PLACE (dotted paths create their intermediate objects, as MongoDB does). */
function applyUpdate(doc: any, update: any): any {
  for (const [key, value] of Object.entries(update.$set ?? {})) setPath(doc, key, value);
  for (const key of Object.keys(update.$unset ?? {})) unsetPath(doc, key);
  for (const [key, value] of Object.entries(update.$inc ?? {})) setPath(doc, key, (getPath(doc, key) ?? 0) + (value as number));
  return doc;
}

export class FakeOutboxStore {
  /** Committed rows. */
  rows: any[] = [];
  private buffers = new Map<object, Buffer>();
  /** Test hook: make the next transactional insert(s) fail. */
  insertError?: () => Error | undefined;
  /** Test hook: fail a non-transactional update (e.g. an acknowledgement write). */
  updateError?: (filter: any, update: any) => Error | undefined;
  /** Every non-transactional update, in order (filter + update), for assertions. */
  updates: Array<{ filter: any; update: any }> = [];
  insertAttempts = 0;
  /** Every `collection.createIndex` call (spec + options), for assertions about per-consumer index creation. */
  createdIndexes: Array<{ spec: any; options: any }> = [];
  /** Test hook: how new event ids are minted (default: a fresh ObjectId stamped with the real clock). Lets a test give an event a hostile id. */
  idFactory?: () => Types.ObjectId;
  /** Every `aggregate()` call (pipeline + options), for assertions about the one read the realtime cutover makes. */
  aggregates: Array<{ pipeline: any[]; options: any }> = [];
  /** Test hook: runs right AFTER an `aggregate()` result was taken — a commit here lands after the read but before whatever the caller does next. */
  afterAggregate?: () => Promise<void>;
  /** Optional shared ordering log (see the cutover specs). */
  trace?: string[];

  readonly model: any;
  readonly service: OutboxService;

  constructor() {
    this.model = this.buildModel();
    this.service = new OutboxService(this.model);
  }

  /** Make a fake session's commit/abort/start drive this store. Call once per session, right after creating it. */
  attach(session: any): any {
    const store = this;
    const start = session.startTransaction?.bind(session);
    const commit = session.commitTransaction?.bind(session);
    session.startTransaction = (...args: any[]) => {
      start?.(...args);
      store.buffers.set(session, { snapshot: [...store.rows], inserts: [] });
    };
    session.commitTransaction = async (...args: any[]) => {
      const buffer = store.buffers.get(session);
      if (buffer) {
        for (const row of buffer.inserts) {
          if (store.rows.some((existing) => store.sameVersion(existing, row))) throw outboxWriteConflict();
        }
      }
      await commit?.(...args);
      if (buffer) {
        store.rows.push(...buffer.inserts);
        buffer.inserts = [];
      }
    };
    return session;
  }

  private sameVersion(a: any, b: any) {
    return a.aggregateType === b.aggregateType && a.aggregateId === b.aggregateId && a.aggregateVersion === b.aggregateVersion;
  }

  /** Committed events, optionally filtered by type. */
  events(type?: string): any[] {
    return this.rows.filter((row) => (type ? row.type === type : true));
  }
  /** Rows a still-open transaction has buffered (not yet committed). */
  pendingInserts(session: object): any[] {
    return this.buffers.get(session)?.inserts ?? [];
  }

  /** Inserts a committed event directly. Delivery state is only present if the test passes `delivery`. */
  seed(row: Partial<any> & { aggregateType: string; aggregateId: string; aggregateVersion: number }): any {
    const doc = {
      _id: new Types.ObjectId(), type: 'BID_ACCEPTED', schemaVersion: 1, occurredAt: new Date('2026-05-02T10:00:00Z'), audience: 'PUBLIC', payload: { n: row.aggregateVersion },
      createdAt: new Date('2026-05-02T10:00:00Z'), ...row,
    };
    this.rows.push(doc);
    return doc;
  }

  private buildModel() {
    const store = this;
    return {
      create: async (docs: any[], options: any) => {
        await tick();
        store.insertAttempts++;
        const injected = store.insertError?.();
        if (injected) throw injected;
        const buffer = store.buffers.get(options?.session);
        if (!buffer) throw new Error('fake outbox: insert outside an attached transaction');
        const out = [];
        for (const doc of docs) {
          const row = { _id: store.idFactory?.() ?? new Types.ObjectId(), createdAt: new Date(), ...doc };
          // Visible to the snapshot ⇒ genuine duplicate key; committed after the snapshot ⇒ WriteConflict (as MongoDB reports it).
          if ([...buffer.snapshot, ...buffer.inserts].some((existing) => store.sameVersion(existing, row))) throw outboxDuplicateVersion();
          if (store.rows.some((existing) => store.sameVersion(existing, row))) throw outboxWriteConflict();
          buffer.inserts.push(row);
          out.push({ ...row, toObject: () => ({ ...row }) });
        }
        return out;
      },
      findOne: (filter: any) => {
        let sort: any; let session: any;
        const chain: any = {
          sort: (s: any) => { sort = s; return chain; }, select: () => chain, lean: () => chain, session: (s: any) => { session = s; return chain; },
          exec: async () => {
            await tick();
            const buffer = session ? store.buffers.get(session) : undefined;
            const universe = buffer ? [...buffer.snapshot, ...buffer.inserts] : store.rows;
            const found = sortRows(universe.filter((row) => matches(row, filter)), sort)[0];
            return found ? clone(found) : null;
          },
        };
        return chain;
      },
      find: (filter: any) => {
        let sort: any; let max = Infinity;
        const chain: any = {
          sort: (s: any) => { sort = s; return chain; }, limit: (n: number) => { max = n; return chain; }, lean: () => chain,
          exec: async () => { await tick(); return sortRows(store.rows.filter((row) => matches(row, filter)), sort).slice(0, max).map((row) => clone(row)); },
        };
        return chain;
      },
      findOneAndUpdate: (filter: any, update: any, options: any = {}) => {
        const chain: any = {
          lean: () => chain,
          exec: async () => {
            await tick();
            const error = store.updateError?.(filter, update);
            if (error) throw error;
            const target = sortRows(store.rows.filter((row) => matches(row, filter)), options.sort)[0];
            if (!target) return null;
            store.updates.push({ filter, update });
            const before = clone(target);
            applyUpdate(target, update);
            return options.new ? clone(target) : before;
          },
        };
        return chain;
      },
      updateOne: (filter: any, update: any) => ({
        exec: async () => {
          await tick();
          const error = store.updateError?.(filter, update);
          if (error) throw error;
          const target = store.rows.find((row) => matches(row, filter));
          if (!target) return { matchedCount: 0, modifiedCount: 0 };
          store.updates.push({ filter, update });
          applyUpdate(target, update);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      }),
      /** Committed rows only (an open transaction's inserts are buffered elsewhere), exactly what a majority read sees. Supports the stages the realtime cutover uses. */
      aggregate: (pipeline: any[]) => {
        let options: any = {};
        const chain: any = {
          option: (o: any) => { options = { ...options, ...o }; return chain; },
          exec: async () => {
            await tick();
            let rows: any[] = store.rows;
            for (const stage of pipeline) {
              if (stage.$match) rows = rows.filter((row) => matches(row, stage.$match));
              else if (stage.$sort) rows = sortRows(rows, stage.$sort);
              else if (stage.$limit !== undefined) rows = rows.slice(0, stage.$limit);
              else if (stage.$group) {
                const { _id: keySpec, ...accumulators } = stage.$group;
                const groups = new Map<any, any>();
                for (const row of rows) {
                  const key = getPath(row, String(keySpec).slice(1));
                  if (groups.has(key)) continue; // `$first`: the first row of the group in the incoming (sorted) order
                  const out: any = { _id: key };
                  for (const [name, spec] of Object.entries<any>(accumulators)) out[name] = getPath(row, String(spec.$first).slice(1));
                  groups.set(key, out);
                }
                rows = [...groups.values()];
              } else throw new Error(`fake outbox: unsupported aggregate stage ${Object.keys(stage)[0]}`);
            }
            const result = rows.map((row) => clone(row));
            store.aggregates.push({ pipeline, options });
            store.trace?.push('outbox.aggregate');
            if (store.afterAggregate) await store.afterAggregate();
            return result;
          },
        };
        return chain;
      },
      collection: {
        createIndex: async (spec: any, options: any) => { store.createdIndexes.push({ spec, options }); return options?.name ?? 'index'; },
      },
    };
  }
}
