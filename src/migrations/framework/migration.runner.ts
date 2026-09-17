import { randomUUID } from 'crypto';
import type { Db } from 'mongodb';
import type { MigrationStore } from './migration.store';
import type { MigrationDefinition, MigrationMode, MigrationRunReport } from './migration.types';

export class MigrationBlockedError extends Error {}
export class MigrationLockError extends Error {}

export class MigrationRunner {
  constructor(
    private readonly db: Db,
    private readonly store: MigrationStore,
    private readonly options: { batchSize?: number; leaseMs?: number; runIdFactory?: () => string } = {},
  ) {}

  async run(definition: MigrationDefinition, mode: MigrationMode): Promise<MigrationRunReport> {
    const runId = this.options.runIdFactory?.() ?? randomUUID();
    const batchSize = this.options.batchSize ?? 250;
    const leaseMs = this.options.leaseMs ?? 300_000;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      throw new RangeError('batchSize must be an integer between 1 and 10000');
    }

    const existing = await this.store.get(definition.id);
    if (existing && existing.version !== definition.version) {
      throw new MigrationBlockedError(`Migration ${definition.id} version changed from ${existing.version} to ${definition.version}; published migrations are immutable`);
    }
    if (existing?.status === 'complete') {
      return { migrationId: definition.id, version: definition.version, mode, runId, status: 'skipped-complete', batches: existing.batches, scanned: existing.scanned, modified: existing.modified };
    }

    const baseContext = { db: this.db, runId, batchSize, checkpoint: existing?.checkpoint };
    if (mode === 'dry-run') {
      const preflight = await definition.preflight(baseContext);
      if (preflight.blockers.length) throw new MigrationBlockedError(this.blockerMessage(definition.id, preflight.blockers));
      return { migrationId: definition.id, version: definition.version, mode, runId, status: 'dry-run-complete', preflight, batches: 0, scanned: 0, modified: 0, resumedFromCheckpoint: existing?.checkpoint };
    }

    const locked = await this.store.acquireLock(runId, leaseMs);
    if (!locked) throw new MigrationLockError('Another migration runner holds the global migration lock');
    let phase = 'dependencies';
    try {
      for (const dependency of definition.dependencies ?? []) {
        if (!(await this.store.isComplete(dependency))) throw new MigrationBlockedError(`Dependency ${dependency} is not complete`);
      }
      phase = 'ledger';
      const ledger = await this.store.begin(definition, runId);
      let checkpoint = ledger.checkpoint;
      phase = 'preflight';
      const preflight = await definition.preflight({ ...baseContext, checkpoint });
      if (preflight.blockers.length) throw new MigrationBlockedError(this.blockerMessage(definition.id, preflight.blockers));

      let batches = 0;
      let scanned = 0;
      let modified = 0;
      phase = 'apply';
      while (true) {
        const renewed = await this.store.renewLock(runId, leaseMs);
        if (!renewed) throw new MigrationLockError('Migration lock expired or ownership was lost');
        const batch = await definition.migrateBatch({ ...baseContext, checkpoint });
        if (!batch.done && (!batch.checkpoint || batch.checkpoint === checkpoint)) {
          throw new Error('Migration batch made no checkpoint progress');
        }
        if (!(await this.store.renewLock(runId, leaseMs))) {
          throw new MigrationLockError('Migration lock expired while a batch was running');
        }
        checkpoint = batch.checkpoint ?? checkpoint;
        await this.store.checkpoint(definition.id, runId, checkpoint, batch.scanned, batch.modified);
        batches++;
        scanned += batch.scanned;
        modified += batch.modified;
        if (batch.done) break;
      }

      phase = 'validation';
      if (!(await this.store.renewLock(runId, leaseMs))) {
        throw new MigrationLockError('Migration lock expired before validation');
      }
      const validation = await definition.validate({ ...baseContext, checkpoint });
      if (!validation.valid) throw new MigrationBlockedError(`Post-migration validation failed: ${validation.errors.map((error) => error.code).join(', ')}`);
      if (!(await this.store.renewLock(runId, leaseMs))) {
        throw new MigrationLockError('Migration lock expired during validation');
      }
      await this.store.complete(definition.id, runId);
      return { migrationId: definition.id, version: definition.version, mode, runId, status: 'complete', preflight, validation, batches, scanned, modified, resumedFromCheckpoint: ledger.checkpoint };
    } catch (error) {
      await this.store.fail(definition.id, runId, phase, this.safeError(error));
      throw error;
    } finally {
      await this.store.releaseLock(runId).catch(() => undefined);
    }
  }

  private blockerMessage(id: string, blockers: Array<{ code: string }>): string {
    return `Migration ${id} blocked by: ${blockers.map((blocker) => blocker.code).join(', ')}`;
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[REDACTED_MONGO_URI]') : 'Unknown migration error';
  }
}
