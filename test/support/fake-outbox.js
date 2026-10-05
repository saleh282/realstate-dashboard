'use strict';

const { Types } = require('mongoose');
const { OUTBOX_AGGREGATE_VERSION_INDEX } = require('../../src/domain/outbox/outbox.constants');
const { OutboxService } = require('../../src/services/outbox.service');
const tick = () => Promise.resolve();
/** MongoDB reports a write that collides with a document the transaction cannot see as a transient WriteConflict. */
const outboxWriteConflict = () =>
  Object.assign(
    new Error('WriteConflict: outbox aggregate version taken by a concurrent transaction'),
    { code: 112, hasErrorLabel: (label) => label === 'TransientTransactionError' },
  );
const outboxDuplicateVersion = () =>
  Object.assign(
    new Error(
      `E11000 duplicate key error collection: outbox_events index: ${OUTBOX_AGGREGATE_VERSION_INDEX} dup key`,
    ),
    {
      code: 11000,
      keyPattern: { aggregateType: 1, aggregateId: 1, aggregateVersion: 1 },
    },
  );
const comparable = (value) =>
  value instanceof Date
    ? value.getTime()
    : value instanceof Types.ObjectId
      ? value.toString()
      : value;
/** Dotted-path access, as MongoDB resolves `delivery.secondary.status` (absent intermediate objects read as undefined). */
const getPath = (doc, path) =>
  path
    .split('.')
    .reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), doc);
function setPath(doc, path, value) {
  const keys = path.split('.');
  let cursor = doc;
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] === null || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}
function unsetPath(doc, path) {
  const keys = path.split('.');
  let cursor = doc;
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] === null || typeof cursor[key] !== 'object') return;
    cursor = cursor[key];
  }
  delete cursor[keys[keys.length - 1]];
}
/** Deep copy that keeps Dates and ObjectIds (what a driver round-trip returns: a fresh object graph). */
function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Types.ObjectId) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  return value;
}
function matchesValue(actual, expected) {
  // `field: null` matches an absent field too — exactly how MongoDB treats it, and what "not yet touched by this consumer" relies on.
  if (expected === null) return actual === null || actual === undefined;
  if (
    expected &&
    typeof expected === 'object' &&
    !(expected instanceof Date) &&
    !(expected instanceof Types.ObjectId)
  ) {
    return Object.entries(expected).every(([op, operand]) => {
      switch (op) {
        case '$in':
          return operand.some((candidate) =>
            candidate === null
              ? actual === null || actual === undefined
              : comparable(candidate) === comparable(actual),
          );
        case '$ne':
          return comparable(actual) !== comparable(operand);
        case '$nin':
          return !operand.some((candidate) => comparable(candidate) === comparable(actual)); // absent fields are "not in"
        case '$lte':
          return actual !== undefined && comparable(actual) <= comparable(operand);
        case '$lt':
          return actual !== undefined && comparable(actual) < comparable(operand);
        case '$gte':
          return actual !== undefined && comparable(actual) >= comparable(operand);
        case '$gt':
          return actual !== undefined && comparable(actual) > comparable(operand);
        case '$exists':
          return operand ? actual !== undefined : actual === undefined;
        default:
          throw new Error(`fake outbox: unsupported operator ${op}`);
      }
    });
  }
  return actual !== undefined && comparable(actual) === comparable(expected);
}
function matches(doc, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some((branch) => matches(doc, branch));
    if (key === '$and') return expected.every((branch) => matches(doc, branch));
    return matchesValue(getPath(doc, key), expected);
  });
}
/** Absent/null sort lowest, as in MongoDB. */
const rank = (value) => (value === null || value === undefined ? [0, 0] : [1, comparable(value)]);
function sortRows(rows, sort) {
  if (!sort) return rows;
  return [...rows].sort((a, b) => {
    for (const [key, direction] of Object.entries(sort)) {
      const [ra, x] = rank(getPath(a, key));
      const [rb, y] = rank(getPath(b, key));
      if (ra !== rb) return (ra < rb ? -1 : 1) * direction;
      if (x < y) return -direction;
      if (x > y) return direction;
    }
    return 0;
  });
}
/** Applies $set / $unset / $inc IN PLACE (dotted paths create their intermediate objects, as MongoDB does). */
function applyUpdate(doc, update) {
  for (const [key, value] of Object.entries(update.$set ?? {})) setPath(doc, key, value);
  for (const key of Object.keys(update.$unset ?? {})) unsetPath(doc, key);
  for (const [key, value] of Object.entries(update.$inc ?? {}))
    setPath(doc, key, (getPath(doc, key) ?? 0) + value);
  return doc;
}
class FakeOutboxStore {
  constructor() {
    /** Committed rows. */
    this.rows = [];
    this.buffers = new Map();
    /** Every non-transactional update, in order (filter + update), for assertions. */
    this.updates = [];
    this.insertAttempts = 0;
    /** Every `collection.createIndex` call (spec + options), for assertions about per-consumer index creation. */
    this.createdIndexes = [];
    /** Every `aggregate()` call (pipeline + options), for assertions about the one read the secondary cutover makes. */
    this.aggregates = [];
    this.model = this.buildModel();
    this.service = new OutboxService(this.model);
  }
  /** Make a fake session's commit/abort/start drive this store. Call once per session, right after creating it. */
  attach(session) {
    const store = this;
    const start = session.startTransaction?.bind(session);
    const commit = session.commitTransaction?.bind(session);
    session.startTransaction = (...args) => {
      start?.(...args);
      store.buffers.set(session, { snapshot: [...store.rows], inserts: [] });
    };
    session.commitTransaction = async (...args) => {
      const buffer = store.buffers.get(session);
      if (buffer) {
        for (const row of buffer.inserts) {
          if (store.rows.some((existing) => store.sameVersion(existing, row)))
            throw outboxWriteConflict();
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
  sameVersion(a, b) {
    return (
      a.aggregateType === b.aggregateType &&
      a.aggregateId === b.aggregateId &&
      a.aggregateVersion === b.aggregateVersion
    );
  }
  /** Committed events, optionally filtered by type. */
  events(type) {
    return this.rows.filter((row) => (type ? row.type === type : true));
  }
  /** Rows a still-open transaction has buffered (not yet committed). */
  pendingInserts(session) {
    return this.buffers.get(session)?.inserts ?? [];
  }
  /** Inserts a committed event directly. Delivery state is only present if the test passes `delivery`. */
  seed(row) {
    const doc = {
      _id: new Types.ObjectId(),
      type: 'PROPERTY_APPROVED',
      schemaVersion: 1,
      occurredAt: new Date('2026-05-02T10:00:00Z'),
      audience: 'PUBLIC',
      payload: { n: row.aggregateVersion },
      createdAt: new Date('2026-05-02T10:00:00Z'),
      ...row,
    };
    this.rows.push(doc);
    return doc;
  }
  buildModel() {
    const store = this;
    return {
      create: async (docs, options) => {
        await tick();
        store.insertAttempts++;
        const injected = store.insertError?.();
        if (injected) throw injected;
        const buffer = store.buffers.get(options?.session);
        if (!buffer) throw new Error('fake outbox: insert outside an attached transaction');
        const out = [];
        for (const doc of docs) {
          const row = {
            _id: store.idFactory?.() ?? new Types.ObjectId(),
            createdAt: new Date(),
            ...doc,
          };
          // Visible to the snapshot ⇒ genuine duplicate key; committed after the snapshot ⇒ WriteConflict (as MongoDB reports it).
          if (
            [...buffer.snapshot, ...buffer.inserts].some((existing) =>
              store.sameVersion(existing, row),
            )
          )
            throw outboxDuplicateVersion();
          if (store.rows.some((existing) => store.sameVersion(existing, row)))
            throw outboxWriteConflict();
          buffer.inserts.push(row);
          out.push({ ...row, toObject: () => ({ ...row }) });
        }
        return out;
      },
      findOne: (filter) => {
        let sort;
        let session;
        const chain = {
          sort: (s) => {
            sort = s;
            return chain;
          },
          select: () => chain,
          lean: () => chain,
          session: (s) => {
            session = s;
            return chain;
          },
          exec: async () => {
            await tick();
            const buffer = session ? store.buffers.get(session) : undefined;
            const universe = buffer ? [...buffer.snapshot, ...buffer.inserts] : store.rows;
            const found = sortRows(
              universe.filter((row) => matches(row, filter)),
              sort,
            )[0];
            return found ? clone(found) : null;
          },
        };
        return chain;
      },
      find: (filter) => {
        let sort;
        let max = Infinity;
        const chain = {
          sort: (s) => {
            sort = s;
            return chain;
          },
          limit: (n) => {
            max = n;
            return chain;
          },
          lean: () => chain,
          exec: async () => {
            await tick();
            return sortRows(
              store.rows.filter((row) => matches(row, filter)),
              sort,
            )
              .slice(0, max)
              .map((row) => clone(row));
          },
        };
        return chain;
      },
      findOneAndUpdate: (filter, update, options = {}) => {
        const chain = {
          lean: () => chain,
          exec: async () => {
            await tick();
            const error = store.updateError?.(filter, update);
            if (error) throw error;
            const target = sortRows(
              store.rows.filter((row) => matches(row, filter)),
              options.sort,
            )[0];
            if (!target) return null;
            store.updates.push({ filter, update });
            const before = clone(target);
            applyUpdate(target, update);
            return options.new ? clone(target) : before;
          },
        };
        return chain;
      },
      updateOne: (filter, update) => ({
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
      /** Committed rows only (an open transaction's inserts are buffered elsewhere), exactly what a majority read sees. Supports the stages the secondary cutover uses. */
      aggregate: (pipeline) => {
        let options = {};
        const chain = {
          option: (o) => {
            options = { ...options, ...o };
            return chain;
          },
          exec: async () => {
            await tick();
            let rows = store.rows;
            for (const stage of pipeline) {
              if (stage.$match) rows = rows.filter((row) => matches(row, stage.$match));
              else if (stage.$sort) rows = sortRows(rows, stage.$sort);
              else if (stage.$limit !== undefined) rows = rows.slice(0, stage.$limit);
              else if (stage.$group) {
                const { _id: keySpec, ...accumulators } = stage.$group;
                const groups = new Map();
                for (const row of rows) {
                  const key = getPath(row, String(keySpec).slice(1));
                  if (groups.has(key)) continue; // `$first`: the first row of the group in the incoming (sorted) order
                  const out = { _id: key };
                  for (const [name, spec] of Object.entries(accumulators))
                    out[name] = getPath(row, String(spec.$first).slice(1));
                  groups.set(key, out);
                }
                rows = [...groups.values()];
              } else
                throw new Error(
                  `fake outbox: unsupported aggregate stage ${Object.keys(stage)[0]}`,
                );
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
        createIndex: async (spec, options) => {
          store.createdIndexes.push({ spec, options });
          return options?.name ?? 'index';
        },
      },
    };
  }
}

Object.assign(exports, { outboxWriteConflict, outboxDuplicateVersion, FakeOutboxStore });
