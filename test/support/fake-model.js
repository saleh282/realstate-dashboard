'use strict';

const { Types } = require('mongoose');

const plain = (value) =>
  value instanceof Types.ObjectId
    ? value.toString()
    : value instanceof Date
      ? value.getTime()
      : value;
const get = (doc, path) =>
  path
    .split('.')
    .reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), doc);
const clone = (value) => {
  if (value instanceof Types.ObjectId || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
};

function matches(doc, filter) {
  return Object.entries(filter).every(([path, expected]) => {
    const actual = plain(get(doc, path));
    const operators =
      expected &&
      typeof expected === 'object' &&
      !(expected instanceof Types.ObjectId) &&
      !(expected instanceof Date)
        ? expected
        : null;
    if (!operators) return actual === plain(expected);
    return Object.entries(operators).every(([operator, operand]) => {
      switch (operator) {
        case '$ne':
          return actual !== plain(operand);
        case '$in':
          return operand.map(plain).includes(actual);
        case '$gte':
          return actual !== undefined && actual >= plain(operand);
        case '$lte':
          return actual !== undefined && actual <= plain(operand);
        default:
          throw new Error(`fake model: unsupported operator ${operator}`);
      }
    });
  });
}

/** A chainable query that resolves to `run()`, like a Mongoose query. */
function query(run) {
  const state = { sort: null, skip: 0, limit: Infinity };
  const chain = {
    sort(spec) {
      state.sort = spec;
      return chain;
    },
    skip(count) {
      state.skip = count;
      return chain;
    },
    limit(count) {
      state.limit = count;
      return chain;
    },
    select: () => chain,
    lean: () => chain,
    session: () => chain,
    exec: async () => run(state),
    then: (resolve, reject) => chain.exec().then(resolve, reject),
  };
  return chain;
}

/**
 * The few Mongoose model operations the listings service uses, over an array.
 * It keeps equality, `$ne`, `$in` and range filters honest; anything else throws.
 */
class FakeModel {
  constructor(docs = []) {
    this.docs = docs.map(clone);
    this.aggregated = [];
    this.aggregateResult = [];
  }
  async create(input) {
    const doc = {
      _id: new Types.ObjectId(),
      createdAt: new Date(),
      updatedAt: new Date(),
      photos: [],
      ...clone(input),
    };
    this.docs.push(doc);
    return { ...doc, toObject: () => clone(doc) };
  }
  find(filter = {}) {
    return query(({ sort, skip, limit }) => {
      const found = this.docs.filter((doc) => matches(doc, filter));
      if (sort) {
        const keys = Object.entries(sort);
        found.sort((a, b) => {
          for (const [path, direction] of keys) {
            const left = plain(get(a, path)) ?? 0;
            const right = plain(get(b, path)) ?? 0;
            if (left !== right) return (left < right ? -1 : 1) * direction;
          }
          return 0;
        });
      }
      return found.slice(skip, skip + limit).map(clone);
    });
  }
  findOne(filter = {}) {
    return query(() => clone(this.docs.find((doc) => matches(doc, filter)) ?? null));
  }
  findById(id) {
    return this.findOne({ _id: id });
  }
  countDocuments(filter = {}) {
    return query(() => this.docs.filter((doc) => matches(doc, filter)).length);
  }
  findOneAndUpdate(filter, update, options = {}) {
    return query(() => {
      let doc = this.docs.find((item) => matches(item, filter));
      if (!doc && options.upsert) {
        doc = {
          _id: new Types.ObjectId(),
          createdAt: new Date(),
          ...clone(update.$setOnInsert ?? {}),
        };
        this.docs.push(doc);
      }
      if (!doc) return null;
      for (const [field, value] of Object.entries(update.$set ?? {})) doc[field] = clone(value);
      for (const field of Object.keys(update.$unset ?? {})) delete doc[field];
      for (const [field, by] of Object.entries(update.$inc ?? {}))
        doc[field] = (doc[field] ?? 0) + by;
      doc.updatedAt = new Date();
      return clone(doc);
    });
  }
  deleteOne(filter) {
    return query(() => {
      const index = this.docs.findIndex((doc) => matches(doc, filter));
      if (index < 0) return { deletedCount: 0 };
      this.docs.splice(index, 1);
      return { deletedCount: 1 };
    });
  }
  aggregate(pipeline) {
    this.aggregated.push(pipeline);
    return query(() => this.aggregateResult);
  }
}

/** A connection whose transactions simply run: enough for `runTransactionWithRetry`. */
function fakeConnection() {
  return {
    startSession: async () => {
      let open = false;
      return {
        startTransaction: () => (open = true),
        commitTransaction: async () => (open = false),
        abortTransaction: async () => (open = false),
        inTransaction: () => open,
        endSession: async () => {},
      };
    },
  };
}

module.exports = { FakeModel, fakeConnection };
