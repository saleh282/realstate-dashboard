import { ConflictException } from '@nestjs/common';
import { ClientSession, Connection } from 'mongoose';
import { OUTBOX_AGGREGATE_VERSION_INDEX } from '../../outbox/outbox.constants';

/** Internal: this attempt decided from stale state and lost a race; a fresh attempt re-reads and decides again. */
export class TransactionAttemptConflict extends Error {}

export const TRANSACTION_MAX_ATTEMPTS = 8;
const RETRY_JITTER_MS = 8;
const COMMIT_MAX_ATTEMPTS = 5;

function hasLabel(error: unknown, label: string): boolean {
  return typeof (error as any)?.hasErrorLabel === 'function' && (error as any).hasErrorLabel(label);
}

/** Errors that prove the attempt did not commit and a fresh attempt may decide differently. */
function isRetryable(error: unknown, uniqueIndexNames: readonly string[]): boolean {
  const e = error as any;
  if (error instanceof TransactionAttemptConflict) return true;
  if (hasLabel(error, 'TransientTransactionError')) return true;
  if (e?.code === 112) return true; // WriteConflict
  if (e?.code === 11000) {
    // A duplicate on a known unique index is a lost race with a concurrent identical operation.
    // The outbox's per-aggregate version index qualifies for every transaction: it only collides when a
    // concurrent transaction on the same aggregate took the version, and a fresh attempt re-reads it.
    const text = `${e.message ?? ''} ${JSON.stringify(e.keyPattern ?? {})}`;
    return text.includes(OUTBOX_AGGREGATE_VERSION_INDEX) || uniqueIndexNames.some((name) => text.includes(name));
  }
  return false;
}

/**
 * Runs `work` in a fresh snapshot / majority-write transaction, retrying the
 * WHOLE transaction only when the attempt provably did not commit. An
 * UnknownTransactionCommitResult re-issues only the commit, never the work.
 * Same strategy as MAZAD-027's bid acceptance.
 */
export async function runTransactionWithRetry<T>(
  connection: Connection,
  work: (session: ClientSession) => Promise<T>,
  options: { uniqueIndexNames?: readonly string[]; retryExhausted: () => Error; maxAttempts?: number },
): Promise<T> {
  const unique = options.uniqueIndexNames ?? [];
  const max = options.maxAttempts ?? TRANSACTION_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= max; attempt++) {
    const session = await connection.startSession();
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      let result: T;
      try {
        result = await work(session);
      } catch (error) {
        await abortQuietly(session);
        if (isRetryable(error, unique)) { await pause(attempt); continue; }
        throw error;
      }
      try {
        await commit(session);
      } catch (error) {
        await abortQuietly(session);
        if (isRetryable(error, unique)) { await pause(attempt); continue; } // a failed commit provably did not commit
        throw error;
      }
      return result;
    } finally {
      await session.endSession();
    }
  }
  throw options.retryExhausted();
}

async function commit(session: ClientSession): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await session.commitTransaction();
      return;
    } catch (error) {
      if (hasLabel(error, 'UnknownTransactionCommitResult') && attempt < COMMIT_MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}

function pause(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * RETRY_JITTER_MS * attempt));
}

async function abortQuietly(session: ClientSession): Promise<void> {
  try {
    if (session.inTransaction()) await session.abortTransaction();
  } catch {
    /* the attempt already failed; the original error is what matters */
  }
}

export const retryConflict = (message: string, code: string) => () => new ConflictException({ message, code });
