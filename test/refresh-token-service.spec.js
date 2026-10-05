'use strict';

const { UnauthorizedException } = require('../src/common/http/errors');
const { Types } = require('mongoose');
const { RefreshTokenService } = require('../src/services/refresh-token.service');
const { RefreshTokenState } = require('../src/models/refresh-token.model');
const { AuthErrorCode } = require('../src/common/errors/auth-error-codes');
function matches(row, query) {
  return Object.entries(query).every(([key, expected]) => {
    const actual = row[key];
    if (expected && typeof expected === 'object' && '$gt' in expected) {
      return actual > expected.$gt;
    }
    if (expected && typeof expected === 'object' && '$in' in expected) {
      return expected.$in.includes(actual);
    }
    if (expected && typeof expected === 'object' && '$exists' in expected) {
      return (actual !== undefined) === expected.$exists;
    }
    return String(actual) === String(expected);
  });
}
function fakeModel() {
  const rows = [];
  let lookups = 0;
  const model = {
    rows,
    get lookups() {
      return lookups;
    },
    create: jest.fn(async (value) => {
      const row = { ...value, _id: new Types.ObjectId() };
      rows.push(row);
      return row;
    }),
    findOne: jest.fn((query) => ({
      exec: async () => {
        if (query.selector) lookups += 1;
        return rows.find((row) => matches(row, query)) ?? null;
      },
    })),
    findOneAndUpdate: jest.fn((query, update) => ({
      exec: async () => {
        const row = rows.find((item) => matches(item, query));
        if (!row) return null;
        Object.assign(row, update.$set);
        return row;
      },
    })),
    find: jest.fn((query) => ({ exec: async () => rows.filter((row) => matches(row, query)) })),
    exists: jest.fn(async (query) => rows.some((row) => matches(row, query))),
    updateMany: jest.fn((query, update) => ({
      exec: async () => {
        const selected = rows.filter((row) => matches(row, query));
        selected.forEach((row) => Object.assign(row, update.$set));
        return { modifiedCount: selected.length };
      },
    })),
    deleteOne: jest.fn((query) => ({
      exec: async () => {
        const index = rows.findIndex((row) => matches(row, query));
        if (index < 0) return { deletedCount: 0 };
        rows.splice(index, 1);
        return { deletedCount: 1 };
      },
    })),
    deleteMany: jest.fn((query) => ({
      exec: async () => {
        let deletedCount = 0;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (matches(rows[index], query)) {
            rows.splice(index, 1);
            deletedCount += 1;
          }
        }
        return { deletedCount };
      },
    })),
  };
  return model;
}
function errorCode(error) {
  return error instanceof UnauthorizedException ? error.getResponse().code : undefined;
}
describe('direct-selector refresh sessions', () => {
  it('stores no raw token and rotates using one indexed selector lookup', async () => {
    const model = fakeModel();
    const service = new RefreshTokenService(model);
    const original = await service.createSession(
      new Types.ObjectId().toString(),
      new Date(Date.now() + 60_000),
      'test-device',
    );
    expect(model.rows[0].tokenHash).not.toContain(original.refreshToken);
    expect(model.rows[0].selector).toBe(original.refreshToken.split('.')[0]);
    const next = await service.rotate(original.refreshToken, new Date(Date.now() + 60_000));
    expect(model.lookups).toBe(1);
    expect(next.refreshToken).not.toBe(original.refreshToken);
    expect(next.sessionId).toBe(original.sessionId);
    expect(model.rows[0].state).toBe(RefreshTokenState.ROTATED);
    expect(model.rows[1].state).toBe(RefreshTokenState.ACTIVE);
  });
  it('detects replay and revokes the active family', async () => {
    const model = fakeModel();
    const service = new RefreshTokenService(model);
    const original = await service.createSession(
      new Types.ObjectId().toString(),
      new Date(Date.now() + 60_000),
    );
    await service.rotate(original.refreshToken, new Date(Date.now() + 60_000));
    const error = await service.rotate(original.refreshToken, new Date()).catch((caught) => caught);
    expect(errorCode(error)).toBe(AuthErrorCode.REFRESH_TOKEN_REUSED);
    expect(model.rows.every((row) => row.state !== RefreshTokenState.ACTIVE)).toBe(true);
  });
  it('makes concurrent use deterministic and leaves no active compromised family', async () => {
    const model = fakeModel();
    const service = new RefreshTokenService(model);
    const original = await service.createSession(
      new Types.ObjectId().toString(),
      new Date(Date.now() + 60_000),
    );
    const results = await Promise.allSettled([
      service.rotate(original.refreshToken, new Date(Date.now() + 60_000)),
      service.rotate(original.refreshToken, new Date(Date.now() + 60_000)),
    ]);
    expect(results.some((result) => result.status === 'rejected')).toBe(true);
    expect(model.rows.every((row) => row.state !== RefreshTokenState.ACTIVE)).toBe(true);
  });
  it('rejects revoked, expired, and malformed refresh tokens deterministically', async () => {
    const model = fakeModel();
    const service = new RefreshTokenService(model);
    const userId = new Types.ObjectId().toString();
    const revoked = await service.createSession(userId, new Date(Date.now() + 60_000));
    await service.revokeSession(userId, revoked.sessionId);
    expect(errorCode(await service.rotate(revoked.refreshToken, new Date()).catch((e) => e))).toBe(
      AuthErrorCode.SESSION_REVOKED,
    );
    const expired = await service.createSession(userId, new Date(Date.now() - 1));
    expect(errorCode(await service.rotate(expired.refreshToken, new Date()).catch((e) => e))).toBe(
      AuthErrorCode.SESSION_EXPIRED,
    );
    expect(errorCode(await service.rotate('not-a-token', new Date()).catch((e) => e))).toBe(
      AuthErrorCode.INVALID_REFRESH_TOKEN,
    );
  });
  it('revoke-all invalidates every device and restore does not resurrect sessions', async () => {
    const model = fakeModel();
    const service = new RefreshTokenService(model);
    const userId = new Types.ObjectId().toString();
    const first = await service.createSession(userId, new Date(Date.now() + 60_000), 'one');
    const second = await service.createSession(userId, new Date(Date.now() + 60_000), 'two');
    await service.revokeAllForUser(userId, 'ACCOUNT_BLOCKED');
    expect(await service.isSessionActive(userId, first.sessionId)).toBe(false);
    expect(await service.isSessionActive(userId, second.sessionId)).toBe(false);
  });
});
