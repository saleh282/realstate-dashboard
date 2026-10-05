'use strict';

const { BadRequestException, ConflictException } = require('../common/http/errors');
const { Logger } = require('../common/logging/logger');
const { createHash } = require('node:crypto');
const { Types } = require('mongoose');
var IdempotencyErrorCode;
(function (IdempotencyErrorCode) {
  IdempotencyErrorCode['KEY_INVALID'] = 'IDEMPOTENCY_KEY_INVALID';
  IdempotencyErrorCode['KEY_REUSED'] = 'IDEMPOTENCY_KEY_REUSED';
  IdempotencyErrorCode['IN_PROGRESS'] = 'IDEMPOTENCY_IN_PROGRESS';
})(IdempotencyErrorCode || (IdempotencyErrorCode = {}));
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const LEASE_MS = 5 * 60_000;
const RETENTION_MS = 24 * 60 * 60_000;
const RETRY_AFTER_SECONDS = 3;
/** Stable JSON: object keys are sorted so equal content always hashes equally. */
function canonicalize(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const source = typeof value.toJSON === 'function' ? value.toJSON() : value;
  if (source === null || typeof source !== 'object') return canonicalize(source);
  const entries = Object.entries(source)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/**
 * Makes a state-changing request safe to retry. A client sends the same
 * `Idempotency-Key` for every attempt at one logical operation; the operation
 * runs once and later attempts get the recorded result. Reusing a key with
 * different content is an error rather than a silent replay of something else.
 */
class IdempotencyService {
  constructor(records) {
    this.records = records;
    this.logger = new Logger(IdempotencyService.name);
  }
  async execute(options, operation) {
    const { key } = options;
    // Without a key the endpoint keeps its original, non-idempotent behaviour.
    if (key === undefined || key === '') return operation();
    if (!KEY_PATTERN.test(key)) {
      throw new BadRequestException({
        message: 'مفتاح منع التكرار غير صالح',
        code: IdempotencyErrorCode.KEY_INVALID,
      });
    }
    const identity = {
      accountId: new Types.ObjectId(options.accountId),
      scope: options.scope,
      keyHash: sha256(key),
    };
    const fingerprint = options.fingerprint();
    const now = Date.now();
    try {
      await this.records.create({
        ...identity,
        fingerprint,
        status: 'in_progress',
        leaseExpiresAt: new Date(now + LEASE_MS),
        expiresAt: new Date(now + RETENTION_MS),
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const replay = await this.resolveExisting(identity, fingerprint);
      if (replay.kind === 'replay') return replay.response;
      return this.run(identity, operation);
    }
    return this.run(identity, operation);
  }
  async resolveExisting(identity, fingerprint) {
    const existing = await this.records.findOne(identity).lean().exec();
    // The record expired or was released between the insert and this read.
    if (!existing) return { kind: 'run' };
    if (existing.fingerprint !== fingerprint) {
      throw new ConflictException({
        message: 'تم استخدام مفتاح منع التكرار مع بيانات مختلفة',
        code: IdempotencyErrorCode.KEY_REUSED,
      });
    }
    if (existing.status === 'completed') return { kind: 'replay', response: existing.response };
    const takeOver = await this.records
      .findOneAndUpdate(
        { ...identity, status: 'in_progress', leaseExpiresAt: { $lte: new Date() } },
        { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } },
      )
      .lean()
      .exec();
    if (takeOver) return { kind: 'run' };
    throw new ConflictException({
      message: 'الطلب قيد المعالجة بالفعل، انتظر قليلًا ثم أعد المحاولة',
      code: IdempotencyErrorCode.IN_PROGRESS,
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    });
  }
  async run(identity, operation) {
    let result;
    try {
      result = await operation();
    } catch (error) {
      // A failed attempt must not block the retry the client is about to make.
      await this.records
        .deleteOne({ ...identity, status: 'in_progress' })
        .exec()
        .catch(() => undefined);
      throw error;
    }
    try {
      // JSON round trip: the stored copy is exactly what a client would have received.
      await this.records
        .updateOne(identity, {
          $set: { status: 'completed', response: JSON.parse(JSON.stringify(result)) },
        })
        .exec();
    } catch {
      // The operation already happened; a retry inside the lease is rejected
      // as in progress, and after it the client re-reads the state it created.
      this.logger.error(
        JSON.stringify({ event: 'idempotency_completion_failed', scope: identity.scope }),
      );
    }
    return result;
  }
}

Object.assign(exports, { IdempotencyErrorCode, canonicalize, sha256, IdempotencyService });
