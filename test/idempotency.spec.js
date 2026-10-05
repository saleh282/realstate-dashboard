'use strict';

const { Logger } = require('../src/common/logging/logger');
const { Types } = require('mongoose');
const {
  IdempotencyErrorCode,
  IdempotencyService,
  canonicalize,
} = require('../src/services/idempotency.service');
/** In-memory stand-in for the idempotency collection, including its unique index. */
function fakeRecords() {
  const rows = [];
  const same = (row, filter) =>
    ['accountId', 'scope', 'keyHash'].every(
      (field) => String(row[field]) === String(filter[field]),
    );
  const model = {
    rows,
    create: jest.fn(async (doc) => {
      if (rows.some((row) => same(row, doc)))
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      rows.push({ ...doc });
    }),
    findOne: jest.fn((filter) => ({
      lean: () => ({ exec: async () => rows.find((row) => same(row, filter)) ?? null }),
    })),
    findOneAndUpdate: jest.fn((filter, update) => ({
      lean: () => ({
        exec: async () => {
          const row = rows.find(
            (candidate) =>
              same(candidate, filter) &&
              candidate.status === filter.status &&
              candidate.leaseExpiresAt <= filter.leaseExpiresAt.$lte,
          );
          if (!row) return null;
          Object.assign(row, update.$set);
          return row;
        },
      }),
    })),
    updateOne: jest.fn((filter, update) => ({
      exec: async () => {
        const row = rows.find((candidate) => same(candidate, filter));
        if (row) Object.assign(row, update.$set);
      },
    })),
    deleteOne: jest.fn((filter) => ({
      exec: async () => {
        const index = rows.findIndex(
          (row) => same(row, filter) && (!filter.status || row.status === filter.status),
        );
        if (index >= 0) rows.splice(index, 1);
      },
    })),
  };
  return model;
}
const account = new Types.ObjectId().toString();
const key = 'flutter-1234567890-abcdef';
describe('IdempotencyService', () => {
  let records;
  let service;
  const run = (operation, overrides = {}) =>
    service.execute(
      {
        scope: 'property.create',
        accountId: account,
        key,
        fingerprint: () => 'fp-1',
        ...overrides,
      },
      operation,
    );
  beforeEach(() => {
    records = fakeRecords();
    service = new IdempotencyService(records);
  });
  it('runs an operation without a key exactly as before, touching no records', async () => {
    const operation = jest.fn().mockResolvedValue({ ok: true });
    await service.execute(
      { scope: 's', accountId: account, key: undefined, fingerprint: () => 'x' },
      operation,
    );
    await service.execute(
      { scope: 's', accountId: account, key: undefined, fingerprint: () => 'x' },
      operation,
    );
    expect(operation).toHaveBeenCalledTimes(2);
    expect(records.create).not.toHaveBeenCalled();
  });
  it('runs once and replays the recorded result for a retry with the same key and content', async () => {
    const operation = jest.fn().mockResolvedValue({
      message: 'saved',
      property: { id: 'p1', when: new Date('2026-01-01T00:00:00Z') },
    });
    const first = await run(operation);
    const second = await run(operation);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(second).toEqual({
      message: 'saved',
      property: { id: 'p1', when: '2026-01-01T00:00:00.000Z' },
    });
    expect(first.property.id).toBe(second.property.id);
    expect(records.rows).toHaveLength(1);
    expect(records.rows[0].status).toBe('completed');
  });
  it('stores only a hash of the key', async () => {
    await run(jest.fn().mockResolvedValue({}));
    expect(JSON.stringify(records.rows)).not.toContain(key);
    expect(records.rows[0].keyHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects the same key with different content instead of replaying something else', async () => {
    await run(jest.fn().mockResolvedValue({ id: 1 }));
    const operation = jest.fn();
    await expect(run(operation, { fingerprint: () => 'fp-2' })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: IdempotencyErrorCode.KEY_REUSED }),
    });
    expect(operation).not.toHaveBeenCalled();
  });
  it('turns away a duplicate that arrives while the first is still running, then replays once it finishes', async () => {
    let finish;
    const slow = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = run(slow);
    await new Promise((resolve) => setImmediate(resolve));
    const duplicate = jest.fn();
    await expect(run(duplicate)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({
        code: IdempotencyErrorCode.IN_PROGRESS,
        retryAfterSeconds: 3,
      }),
    });
    expect(duplicate).not.toHaveBeenCalled();
    finish({ id: 'created' });
    await expect(first).resolves.toEqual({ id: 'created' });
    await expect(run(duplicate)).resolves.toEqual({ id: 'created' });
    expect(duplicate).not.toHaveBeenCalled();
  });
  it('lets the client retry after a failed attempt, and records only the success', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new Error('cloudinary down'))
      .mockResolvedValueOnce({ id: 'p2' });
    await expect(run(operation)).rejects.toThrow('cloudinary down');
    expect(records.rows).toHaveLength(0);
    await expect(run(operation)).resolves.toEqual({ id: 'p2' });
    await expect(run(operation)).resolves.toEqual({ id: 'p2' });
    expect(operation).toHaveBeenCalledTimes(2);
  });
  it('takes over work whose first attempt died past its lease', async () => {
    void run(() => new Promise(() => undefined)); // never settles: the record stays in progress
    await new Promise((resolve) => setImmediate(resolve));
    expect(records.rows[0].status).toBe('in_progress');
    records.rows[0].leaseExpiresAt = new Date(Date.now() - 1_000);
    const operation = jest.fn().mockResolvedValue({ id: 'recovered' });
    await expect(run(operation)).resolves.toEqual({ id: 'recovered' });
    expect(operation).toHaveBeenCalledTimes(1);
  });
  it.each([
    'short',
    'has spaces in it!',
    'a'.repeat(129),
    'bad/slash/key1',
    '<script>alert(1)</script>',
  ])('rejects the malformed key %j', async (bad) => {
    const operation = jest.fn();
    await expect(run(operation, { key: bad })).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: IdempotencyErrorCode.KEY_INVALID }),
    });
    expect(operation).not.toHaveBeenCalled();
  });
  it('keeps accounts and scopes independent', async () => {
    const operation = jest.fn().mockResolvedValue({ n: 1 });
    await run(operation);
    await run(operation, { accountId: new Types.ObjectId().toString() });
    await run(operation, { scope: 'property.revision' });
    expect(operation).toHaveBeenCalledTimes(3);
  });
  it('still returns the result when recording completion fails, and reports it', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    records.updateOne.mockImplementationOnce(() => ({
      exec: async () => {
        throw new Error('db blip');
      },
    }));
    await expect(run(jest.fn().mockResolvedValue({ id: 'ok' }))).resolves.toEqual({ id: 'ok' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('idempotency_completion_failed'));
    error.mockRestore();
  });
  it('propagates unexpected database errors from reserving the key', async () => {
    records.create.mockRejectedValueOnce(new Error('connection lost'));
    await expect(run(jest.fn())).rejects.toThrow('connection lost');
  });
});
describe('canonicalize', () => {
  it('ignores key order and undefined values but respects array order', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [1, 2] } })).toBe(
      canonicalize({ a: { c: [1, 2], d: 2 }, b: 1, z: undefined }),
    );
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
  it('distinguishes different values and types', () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: '1' }));
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });
  it('handles class instances such as validated DTOs', () => {
    class Dto {
      constructor() {
        this.title = 't';
        this.area = 90;
      }
    }
    expect(canonicalize(new Dto())).toBe(canonicalize({ area: 90, title: 't' }));
  });
});
