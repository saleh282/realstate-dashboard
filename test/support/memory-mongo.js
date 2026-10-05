'use strict';

const { ObjectId } = require('mongodb');
const { Types } = require('mongoose');
const idOf = (value) => (value === null || value === undefined ? value : String(value));
const same = (a, b) =>
  a instanceof ObjectId ||
  b instanceof ObjectId ||
  a instanceof Types.ObjectId ||
  b instanceof Types.ObjectId
    ? idOf(a) === idOf(b)
    : a === b;
function getPath(doc, path) {
  return path.split('.').reduce((value, key) => {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value) && !/^\d+$/.test(key))
      return value.map((item) => item?.[key]).filter((item) => item !== undefined);
    return value[key];
  }, doc);
}
const truthy = (value) =>
  !(value === false || value === null || value === undefined || value === 0);
function evaluate(expr, doc, vars = {}) {
  if (typeof expr === 'string' && expr.startsWith('$$')) return getPath(vars, expr.slice(2));
  if (typeof expr === 'string' && expr.startsWith('$')) return getPath(doc, expr.slice(1));
  if (Array.isArray(expr)) return expr.map((item) => evaluate(item, doc, vars));
  if (!expr || typeof expr !== 'object' || expr instanceof ObjectId || expr instanceof Date)
    return expr;
  const [op, raw] = Object.entries(expr)[0];
  const args = (Array.isArray(raw) ? raw : [raw]).map((item) => evaluate(item, doc, vars));
  switch (op) {
    case '$cond':
      return truthy(args[0]) ? args[1] : args[2];
    case '$isArray':
      return Array.isArray(args[0]);
    case '$ifNull':
      return args[0] === null || args[0] === undefined ? args[1] : args[0];
    case '$in':
      if (!Array.isArray(args[1])) throw new Error('$in needs an array');
      return args[1].some((item) => same(item, args[0]));
    case '$not':
      return !truthy(args[0]);
    case '$and':
      return args.every(truthy);
    case '$or':
      return args.some(truthy);
    case '$eq':
      return same(args[0], args[1]);
    case '$ne':
      return !same(args[0], args[1]);
    case '$lt':
      return args[0] < args[1];
    case '$arrayElemAt':
      return Array.isArray(args[0]) ? args[0][args[1]] : undefined;
    default:
      throw new Error(`unsupported expression ${op}`);
  }
}
function matches(doc, filter, vars = {}) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$expr') return truthy(evaluate(condition, doc, vars));
    if (key === '$and') return condition.every((sub) => matches(doc, sub, vars));
    if (key === '$or') return condition.some((sub) => matches(doc, sub, vars));
    const value = getPath(doc, key);
    const equals = (expected) =>
      expected === null
        ? value === null || value === undefined
        : Array.isArray(value)
          ? value.some((item) => same(item, expected)) || same(value, expected)
          : same(value, expected);
    if (
      condition &&
      typeof condition === 'object' &&
      !(condition instanceof ObjectId) &&
      !(condition instanceof Types.ObjectId) &&
      !Array.isArray(condition) &&
      !(condition instanceof Date)
    ) {
      return Object.entries(condition).every(([op, expected]) => {
        switch (op) {
          case '$exists':
            return (value !== undefined) === expected;
          case '$ne':
            return !equals(expected);
          case '$in':
            return expected.some((item) => equals(item));
          case '$nin':
            return !expected.some((item) => equals(item));
          case '$gt':
            return value !== undefined && idOf(value) > idOf(expected);
          case '$gte':
            return value !== undefined && value >= expected;
          case '$lte':
            return value !== undefined && value <= expected;
          case '$regex':
            return new RegExp(expected, condition.$options ?? '').test(String(value ?? ''));
          case '$options':
            return true;
          default:
            throw new Error(`unsupported operator ${op}`);
        }
      });
    }
    return equals(condition);
  });
}
function sortDocs(docs, spec) {
  return [...docs].sort((a, b) => {
    for (const [field, dir] of Object.entries(spec)) {
      const [av, bv] = [
        a[field] instanceof Date ? +a[field] : (idOf(a[field]) ?? a[field]),
        b[field] instanceof Date ? +b[field] : (idOf(b[field]) ?? b[field]),
      ];
      if (av === bv) continue;
      return (av > bv ? 1 : -1) * dir;
    }
    return 0;
  });
}
class MemoryDb {
  constructor() {
    this.data = new Map();
    this.indexes = new Map();
    this.writes = [];
  }
  seed(name, docs) {
    this.data.set(name, docs);
    return this;
  }
  docs(name) {
    if (!this.data.has(name)) this.data.set(name, []);
    return this.data.get(name);
  }
  aggregate(name, pipeline, vars = {}) {
    let docs = this.docs(name).map((doc) => ({ ...doc }));
    for (const stage of pipeline) {
      const [op, spec] = Object.entries(stage)[0];
      if (op === '$match') docs = docs.filter((doc) => matches(doc, spec, vars));
      else if (op === '$project') {
        const excluded = Object.values(spec).every((value) => value === 0);
        docs = docs.map((doc) =>
          excluded
            ? Object.fromEntries(Object.entries(doc).filter(([key]) => !(key in spec)))
            : Object.fromEntries([
                ['_id', doc._id],
                ...Object.entries(spec).map(([key, value]) => [
                  key,
                  value === 1 ? doc[key] : evaluate(value, doc, vars),
                ]),
              ]),
        );
      } else if (op === '$set')
        docs = docs.map((doc) => ({
          ...doc,
          ...Object.fromEntries(
            Object.entries(spec).map(([key, value]) => [key, evaluate(value, doc, vars)]),
          ),
        }));
      else if (op === '$unwind')
        docs = docs.flatMap((doc) =>
          (getPath(doc, spec.slice(1)) ?? []).map((item) => ({ ...doc, [spec.slice(1)]: item })),
        );
      else if (op === '$lookup')
        docs = docs.map((doc) => ({
          ...doc,
          [spec.as]: spec.pipeline
            ? this.aggregate(
                spec.from,
                spec.pipeline,
                Object.fromEntries(
                  Object.entries(spec.let ?? {}).map(([key, value]) => [
                    key,
                    evaluate(value, doc, vars),
                  ]),
                ),
              )
            : this.docs(spec.from).filter((target) =>
                same(getPath(target, spec.foreignField), getPath(doc, spec.localField)),
              ),
        }));
      else if (op === '$group')
        docs = [
          ...new Map(
            docs.map((doc) => [
              idOf(evaluate(spec._id, doc, vars)),
              { _id: evaluate(spec._id, doc, vars) },
            ]),
          ).values(),
        ];
      else if (op === '$count') docs = docs.length ? [{ [spec]: docs.length }] : [];
      else if (op === '$limit') docs = docs.slice(0, spec);
      else if (op === '$skip') docs = docs.slice(spec);
      else if (op === '$sort') docs = sortDocs(docs, spec);
      else if (op === '$facet')
        docs = [
          Object.fromEntries(
            Object.entries(spec).map(([key, sub]) => [key, this.aggregateDocs(docs, sub, vars)]),
          ),
        ];
      else throw new Error(`unsupported stage ${op}`);
    }
    return docs;
  }
  aggregateDocs(docs, pipeline, vars) {
    const scratch = `__facet_${Math.random()}`;
    this.data.set(scratch, docs);
    try {
      return this.aggregate(scratch, pipeline, vars);
    } finally {
      this.data.delete(scratch);
    }
  }
  collection(name) {
    const db = this;
    return {
      countDocuments: async (filter = {}) =>
        db.docs(name).filter((doc) => matches(doc, filter)).length,
      find: (filter = {}, options = {}) => {
        let docs = db.docs(name).filter((doc) => matches(doc, filter));
        const chain = {
          sort: (spec) => {
            docs = sortDocs(docs, spec);
            return chain;
          },
          limit: (n) => {
            docs = docs.slice(0, n);
            return chain;
          },
          toArray: async () =>
            docs.map((doc) =>
              options.projection
                ? Object.fromEntries(
                    Object.keys({ _id: 1, ...options.projection }).map((key) => [key, doc[key]]),
                  )
                : { ...doc },
            ),
        };
        return chain;
      },
      aggregate: (pipeline) => ({ toArray: async () => db.aggregate(name, pipeline) }),
      findOne: async (filter = {}) => {
        const found = db.docs(name).find((doc) => matches(doc, filter));
        return found ? { ...found } : null;
      },
      insertOne: async (document) => {
        db.writes.push({ collection: name, op: 'insertOne' });
        db.docs(name).push({ _id: new ObjectId(), ...document });
        return { insertedId: document._id };
      },
      updateOne: async (filter, update, options = {}) => {
        db.writes.push({ collection: name, op: 'updateOne' });
        const target = db.docs(name).find((doc) => matches(doc, filter));
        if (target) {
          const before = JSON.stringify(target);
          Object.assign(target, update.$set ?? {});
          return {
            matchedCount: 1,
            modifiedCount: JSON.stringify(target) === before ? 0 : 1,
            upsertedCount: 0,
          };
        }
        if (!options.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        const equality = Object.fromEntries(
          Object.entries(filter).filter(
            ([key, value]) =>
              !key.startsWith('$') &&
              (value === null || typeof value !== 'object' || value instanceof ObjectId),
          ),
        );
        db.docs(name).push({
          _id: new ObjectId(),
          ...equality,
          ...(update.$setOnInsert ?? {}),
          ...(update.$set ?? {}),
        });
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      },
      bulkWrite: async (operations) => {
        db.writes.push({ collection: name, op: 'bulkWrite' });
        let modifiedCount = 0;
        for (const { updateOne } of operations) {
          const target = db.docs(name).find((doc) => matches(doc, updateOne.filter));
          if (!target) continue;
          if (updateOne.update.$set) Object.assign(target, updateOne.update.$set);
          for (const key of Object.keys(updateOne.update.$unset ?? {})) delete target[key];
          modifiedCount++;
        }
        return { modifiedCount };
      },
      updateMany: async () => {
        db.writes.push({ collection: name, op: 'updateMany' });
        return { matchedCount: 0, modifiedCount: 0 };
      },
      indexes: async () => db.indexes.get(name) ?? [],
      createIndex: async (key, options = {}) => {
        db.writes.push({ collection: name, op: 'createIndex' });
        const indexName =
          options.name ??
          Object.entries(key)
            .map(([field, direction]) => `${field}_${direction}`)
            .join('_');
        const list = db.indexes.get(name) ?? [];
        const existing = list.find((index) => index.name === indexName);
        if (existing && JSON.stringify(existing.key) !== JSON.stringify(key))
          throw new Error('IndexOptionsConflict');
        if (!existing)
          list.push({
            name: indexName,
            key,
            ...(options.unique ? { unique: true } : {}),
            ...(options.partialFilterExpression
              ? { partialFilterExpression: options.partialFilterExpression }
              : {}),
          });
        db.indexes.set(name, list);
        return indexName;
      },
      dropIndex: async (indexName) => {
        db.writes.push({ collection: name, op: 'dropIndex' });
        db.indexes.set(
          name,
          (db.indexes.get(name) ?? []).filter((index) => index.name !== indexName),
        );
      },
    };
  }
}
class MemoryStore {
  constructor() {
    this.records = new Map();
  }
  async acquireLock(ownerId) {
    if (this.lockOwner) return false;
    this.lockOwner = ownerId;
    return true;
  }
  async renewLock(ownerId) {
    return this.lockOwner === ownerId;
  }
  async releaseLock(ownerId) {
    if (this.lockOwner === ownerId) this.lockOwner = undefined;
  }
  async get(id) {
    return this.records.get(id) ?? null;
  }
  async isComplete(id) {
    return this.records.get(id)?.status === 'complete';
  }
  async begin(definition, runId) {
    const now = new Date();
    const record = this.records.get(definition.id) ?? {
      migrationId: definition.id,
      version: definition.version,
      status: 'running',
      runId,
      batches: 0,
      scanned: 0,
      modified: 0,
      attempts: 0,
      startedAt: now,
      updatedAt: now,
    };
    const next = { ...record, status: 'running', runId, attempts: record.attempts + 1 };
    this.records.set(definition.id, next);
    return next;
  }
  async checkpoint(id, _runId, checkpoint, scanned, modified) {
    const record = this.records.get(id);
    this.records.set(id, {
      ...record,
      checkpoint,
      batches: record.batches + 1,
      scanned: record.scanned + scanned,
      modified: record.modified + modified,
    });
  }
  async complete(id) {
    this.records.get(id).status = 'complete';
  }
  async fail(id, runId, phase, message) {
    const record = this.records.get(id);
    if (record)
      this.records.set(id, {
        ...record,
        status: 'failed',
        runId,
        failure: { phase, message, at: new Date() },
      });
  }
  markComplete(id) {
    this.records.set(id, {
      migrationId: id,
      version: 1,
      status: 'complete',
      runId: 'seed',
      batches: 0,
      scanned: 0,
      modified: 0,
      attempts: 1,
      startedAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

Object.assign(exports, { idOf, same, getPath, evaluate, matches, sortDocs, MemoryDb, MemoryStore });
