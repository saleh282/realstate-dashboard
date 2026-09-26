import type { Collection, Db } from 'mongodb';
import type { MigrationDefinition, MigrationLedgerRecord } from './migration.types';

export interface MigrationStore {
  acquireLock(ownerId: string, leaseMs: number): Promise<boolean>;
  renewLock(ownerId: string, leaseMs: number): Promise<boolean>;
  releaseLock(ownerId: string): Promise<void>;
  get(migrationId: string): Promise<MigrationLedgerRecord | null>;
  isComplete(migrationId: string): Promise<boolean>;
  begin(definition: MigrationDefinition, runId: string): Promise<MigrationLedgerRecord>;
  checkpoint(migrationId: string, runId: string, checkpoint: string | undefined, scanned: number, modified: number): Promise<void>;
  complete(migrationId: string, runId: string): Promise<void>;
  fail(migrationId: string, runId: string, phase: string, message: string): Promise<void>;
}

export class MongoMigrationStore implements MigrationStore {
  private readonly ledgers: Collection<any>;
  private readonly locks: Collection<any>;

  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {
    this.ledgers = db.collection('migration_ledger');
    this.locks = db.collection('migration_locks');
  }

  async ensureIndexes(): Promise<void> {
    await this.ledgers.createIndex({ migrationId: 1 }, { unique: true, name: 'migration_id_unique' });
    await this.ledgers.createIndex({ status: 1, updatedAt: -1 }, { name: 'migration_status_updated' });
    await this.locks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'migration_lock_ttl' });
  }

  async acquireLock(ownerId: string, leaseMs: number): Promise<boolean> {
    const now = this.now();
    try {
      const result = await this.locks.findOneAndUpdate(
        { _id: 'global', $or: [{ ownerId }, { expiresAt: { $lte: now } }] },
        { $set: { ownerId, acquiredAt: now, expiresAt: new Date(now.getTime() + leaseMs) } },
        { upsert: true, returnDocument: 'after' },
      );
      return result?.ownerId === ownerId;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  }

  async renewLock(ownerId: string, leaseMs: number): Promise<boolean> {
    const now = this.now();
    const result = await this.locks.updateOne(
      { _id: 'global', ownerId, expiresAt: { $gt: now } },
      { $set: { expiresAt: new Date(now.getTime() + leaseMs) } },
    );
    return result.modifiedCount === 1;
  }

  async releaseLock(ownerId: string): Promise<void> {
    await this.locks.deleteOne({ _id: 'global', ownerId });
  }

  async get(migrationId: string): Promise<MigrationLedgerRecord | null> {
    return this.ledgers.findOne({ migrationId }) as Promise<MigrationLedgerRecord | null>;
  }

  async isComplete(migrationId: string): Promise<boolean> {
    return Boolean(await this.ledgers.findOne({ migrationId, status: 'complete' }, { projection: { _id: 1 } }));
  }

  async begin(definition: MigrationDefinition, runId: string): Promise<MigrationLedgerRecord> {
    const now = this.now();
    await this.ledgers.updateOne(
      { migrationId: definition.id },
      {
        $setOnInsert: {
          migrationId: definition.id,
          version: definition.version,
          checkpoint: undefined,
          batches: 0,
          scanned: 0,
          modified: 0,
          startedAt: now,
        },
        // `attempts` must not also appear in $setOnInsert: MongoDB rejects the
        // update (code 40, path conflict). An upsert's $inc starts it at 1.
        $set: { status: 'running', runId, updatedAt: now },
        $inc: { attempts: 1 },
        $unset: { failure: '' },
      },
      { upsert: true },
    );
    const record = await this.get(definition.id);
    if (!record) throw new Error(`Migration ledger was not created for ${definition.id}`);
    if (record.version !== definition.version) throw new Error(`Migration version mismatch for ${definition.id}`);
    return record;
  }

  async checkpoint(migrationId: string, runId: string, checkpoint: string | undefined, scanned: number, modified: number): Promise<void> {
    const update = await this.ledgers.updateOne(
      { migrationId, runId, status: 'running' },
      {
        ...(checkpoint ? { $set: { checkpoint, updatedAt: this.now() } } : { $set: { updatedAt: this.now() } }),
        $inc: { batches: 1, scanned, modified },
      },
    );
    if (update.matchedCount !== 1) throw new Error(`Lost migration ledger ownership for ${migrationId}`);
  }

  async complete(migrationId: string, runId: string): Promise<void> {
    const now = this.now();
    const update = await this.ledgers.updateOne(
      { migrationId, runId, status: 'running' },
      { $set: { status: 'complete', completedAt: now, updatedAt: now }, $unset: { failure: '' } },
    );
    if (update.matchedCount !== 1) throw new Error(`Could not complete migration ${migrationId}`);
  }

  async fail(migrationId: string, runId: string, phase: string, message: string): Promise<void> {
    await this.ledgers.updateOne(
      { migrationId, runId, status: 'running' },
      { $set: { status: 'failed', runId, updatedAt: this.now(), failure: { phase, message: message.slice(0, 500), at: this.now() } } },
    );
  }
}
