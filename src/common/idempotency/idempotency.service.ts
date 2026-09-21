import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { IdempotencyRecord, IdempotencyRecordDocument } from './idempotency-record.schema';

export enum IdempotencyErrorCode {
  KEY_INVALID = 'IDEMPOTENCY_KEY_INVALID',
  KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED',
  IN_PROGRESS = 'IDEMPOTENCY_IN_PROGRESS',
}

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const LEASE_MS = 5 * 60_000;
const RETENTION_MS = 24 * 60 * 60_000;
const RETRY_AFTER_SECONDS = 3;

/** Stable JSON: object keys are sorted so equal content always hashes equally. */
export function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const source = typeof (value as { toJSON?: unknown }).toJSON === 'function'
    ? (value as { toJSON: () => unknown }).toJSON()
    : value;
  if (source === null || typeof source !== 'object') return canonicalize(source);
  const entries = Object.entries(source as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
}

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/**
 * Makes a state-changing request safe to retry. A client sends the same
 * `Idempotency-Key` for every attempt at one logical operation; the operation
 * runs once and later attempts get the recorded result. Reusing a key with
 * different content is an error rather than a silent replay of something else.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @InjectModel(IdempotencyRecord.name) private readonly records: Model<IdempotencyRecordDocument>,
  ) {}

  async execute<T>(
    options: {
      scope: string;
      accountId: string;
      key: string | undefined;
      /** Digest of everything that defines this request. Evaluated only when a key is present. */
      fingerprint: () => string;
    },
    operation: () => Promise<T>,
  ): Promise<T> {
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
      if ((error as { code?: number })?.code !== 11000) throw error;
      const replay = await this.resolveExisting<T>(identity, fingerprint);
      if (replay.kind === 'replay') return replay.response;
      return this.run(identity, operation);
    }
    return this.run(identity, operation);
  }

  private async resolveExisting<T>(
    identity: { accountId: Types.ObjectId; scope: string; keyHash: string },
    fingerprint: string,
  ): Promise<{ kind: 'replay'; response: T } | { kind: 'run' }> {
    const existing = await this.records.findOne(identity).lean().exec();
    // The record expired or was released between the insert and this read.
    if (!existing) return { kind: 'run' };
    if (existing.fingerprint !== fingerprint) {
      throw new ConflictException({
        message: 'تم استخدام مفتاح منع التكرار مع بيانات مختلفة',
        code: IdempotencyErrorCode.KEY_REUSED,
      });
    }
    if (existing.status === 'completed') return { kind: 'replay', response: existing.response as T };

    const takeOver = await this.records.findOneAndUpdate(
      { ...identity, status: 'in_progress', leaseExpiresAt: { $lte: new Date() } },
      { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } },
    ).lean().exec();
    if (takeOver) return { kind: 'run' };
    throw new ConflictException({
      message: 'الطلب قيد المعالجة بالفعل، انتظر قليلًا ثم أعد المحاولة',
      code: IdempotencyErrorCode.IN_PROGRESS,
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    });
  }

  private async run<T>(
    identity: { accountId: Types.ObjectId; scope: string; keyHash: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      // A failed attempt must not block the retry the client is about to make.
      await this.records.deleteOne({ ...identity, status: 'in_progress' }).exec().catch(() => undefined);
      throw error;
    }
    try {
      // JSON round trip: the stored copy is exactly what a client would have received.
      await this.records.updateOne(
        identity,
        { $set: { status: 'completed', response: JSON.parse(JSON.stringify(result)) } },
      ).exec();
    } catch {
      // The operation already happened; a retry inside the lease is rejected
      // as in progress, and after it the client re-reads the state it created.
      this.logger.error(JSON.stringify({ event: 'idempotency_completion_failed', scope: identity.scope }));
    }
    return result;
  }
}
