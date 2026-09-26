import type { Db } from 'mongodb';
import { MigrationBlockedError, MigrationLockError, MigrationRunner } from '../src/migrations/framework/migration.runner';
import { MongoMigrationStore, type MigrationStore } from '../src/migrations/framework/migration.store';
import type { MigrationDefinition, MigrationLedgerRecord } from '../src/migrations/framework/migration.types';
import { CORE_MIGRATIONS, validateMigrationRegistry } from '../src/migrations/framework/core-migrations';
import { parseMigrationCliArgs } from '../src/migrations/cli';

class MemoryStore implements MigrationStore {
  record: MigrationLedgerRecord | null = null;
  lockOwner?: string;
  denyLock = false;
  async acquireLock(ownerId: string) { if (this.denyLock || this.lockOwner) return false; this.lockOwner = ownerId; return true; }
  async renewLock(ownerId: string) { return this.lockOwner === ownerId; }
  async releaseLock(ownerId: string) { if (this.lockOwner === ownerId) this.lockOwner = undefined; }
  async get(migrationId: string) { return this.record?.migrationId === migrationId ? this.record : null; }
  async isComplete(migrationId: string) { return this.record?.migrationId === migrationId && this.record.status === 'complete'; }
  async begin(definition: MigrationDefinition, runId: string) {
    const now = new Date();
    this.record = this.record ?? { migrationId: definition.id, version: definition.version, status: 'running', runId, batches: 0, scanned: 0, modified: 0, attempts: 0, startedAt: now, updatedAt: now };
    this.record = { ...this.record, status: 'running', runId, attempts: this.record.attempts + 1, updatedAt: now, failure: undefined };
    return this.record;
  }
  async checkpoint(_migrationId: string, _runId: string, checkpoint: string | undefined, scanned: number, modified: number) {
    if (!this.record) throw new Error('missing ledger');
    this.record = { ...this.record, checkpoint, batches: this.record.batches + 1, scanned: this.record.scanned + scanned, modified: this.record.modified + modified };
  }
  async complete() { if (this.record) this.record.status = 'complete'; }
  async fail(_migrationId: string, runId: string, phase: string, message: string) {
    if (this.record) { this.record.status = 'failed'; this.record.runId = runId; this.record.failure = { phase, message, at: new Date() }; }
  }
}

function definition(overrides: Partial<MigrationDefinition> = {}): MigrationDefinition {
  return {
    id: '011-test', version: 1, description: 'test',
    rollback: { kind: 'none', remediation: 'repair from report', restoreProcedure: 'restore verified snapshot' },
    preflight: jest.fn().mockResolvedValue({ eligible: 0, alreadyApplied: 0, blockers: [] }),
    migrateBatch: jest.fn().mockResolvedValue({ scanned: 0, modified: 0, done: true }),
    validate: jest.fn().mockResolvedValue({ valid: true, errors: [] }),
    ...overrides,
  };
}

describe('MAZAD-011 migration framework', () => {
  it('runs an empty database dry-run without writing a ledger or lock', async () => {
    const store = new MemoryStore();
    const report = await new MigrationRunner({} as Db, store, { runIdFactory: () => 'run-1' }).run(definition(), 'dry-run');
    expect(report.status).toBe('dry-run-complete');
    expect(store.record).toBeNull();
    expect(store.lockOwner).toBeUndefined();
  });

  it('runs representative bounded batches and records completion', async () => {
    const store = new MemoryStore();
    const migrateBatch = jest.fn().mockResolvedValueOnce({ scanned: 2, modified: 2, checkpoint: '2', done: false }).mockResolvedValueOnce({ scanned: 1, modified: 1, checkpoint: '3', done: true });
    const report = await new MigrationRunner({} as Db, store, { batchSize: 2, runIdFactory: () => 'run-1' }).run(definition({ migrateBatch }), 'apply');
    expect(report).toMatchObject({ status: 'complete', batches: 2, scanned: 3, modified: 3 });
    expect(store.record).toMatchObject({ status: 'complete', checkpoint: '3', batches: 2 });
  });

  it('resumes after interruption from the durable checkpoint', async () => {
    const store = new MemoryStore();
    const first = jest.fn().mockResolvedValueOnce({ scanned: 2, modified: 2, checkpoint: '2', done: false }).mockRejectedValueOnce(new Error('process interrupted'));
    await expect(new MigrationRunner({} as Db, store, { runIdFactory: () => 'run-1' }).run(definition({ migrateBatch: first }), 'apply')).rejects.toThrow('process interrupted');
    expect(store.record).toMatchObject({ status: 'failed', checkpoint: '2' });
    const resumedBatch = jest.fn().mockImplementation(async (context) => ({ scanned: 1, modified: 1, checkpoint: context.checkpoint === '2' ? '3' : 'wrong', done: true }));
    const report = await new MigrationRunner({} as Db, store, { runIdFactory: () => 'run-2' }).run(definition({ migrateBatch: resumedBatch }), 'apply');
    expect(report.resumedFromCheckpoint).toBe('2');
    expect(store.record).toMatchObject({ status: 'complete', checkpoint: '3', attempts: 2 });
  });

  it('rejects a concurrent runner holding the lock', async () => {
    const store = new MemoryStore(); store.denyLock = true;
    await expect(new MigrationRunner({} as Db, store).run(definition(), 'apply')).rejects.toBeInstanceOf(MigrationLockError);
  });

  it('skips a completed migration on rerun', async () => {
    const store = new MemoryStore();
    await new MigrationRunner({} as Db, store, { runIdFactory: () => 'run-1' }).run(definition(), 'apply');
    const second = definition();
    const report = await new MigrationRunner({} as Db, store, { runIdFactory: () => 'run-2' }).run(second, 'apply');
    expect(report.status).toBe('skipped-complete');
    expect(second.migrateBatch).not.toHaveBeenCalled();
  });

  it('blocks mutation of a version already recorded in the ledger', async () => {
    const store = new MemoryStore();
    await new MigrationRunner({} as Db, store).run(definition(), 'apply');
    await expect(new MigrationRunner({} as Db, store).run(definition({ version: 2 }), 'apply')).rejects.toThrow('published migrations are immutable');
  });

  it('blocks failed preflight and failed post-validation with a recorded phase', async () => {
    const preflightStore = new MemoryStore();
    await expect(new MigrationRunner({} as Db, preflightStore).run(definition({ preflight: jest.fn().mockResolvedValue({ eligible: 1, alreadyApplied: 0, blockers: [{ code: 'BAD_DATA', message: 'bad' }] }) }), 'apply')).rejects.toBeInstanceOf(MigrationBlockedError);
    expect(preflightStore.record?.failure?.phase).toBe('preflight');
    const validationStore = new MemoryStore();
    await expect(new MigrationRunner({} as Db, validationStore).run(definition({ validate: jest.fn().mockResolvedValue({ valid: false, errors: [{ code: 'MISMATCH', message: 'bad' }] }) }), 'apply')).rejects.toBeInstanceOf(MigrationBlockedError);
    expect(validationStore.record?.failure?.phase).toBe('validation');
  });

  it('requires every registered migration to declare rollback or remediation', () => {
    expect(() => validateMigrationRegistry()).not.toThrow();
    expect(CORE_MIGRATIONS.length).toBeGreaterThan(0);
    for (const migration of CORE_MIGRATIONS) {
      expect(migration.rollback.kind).toMatch(/automatic|none/);
      if (migration.rollback.kind === 'none') {
        expect(migration.rollback.remediation).toBeTruthy();
        expect(migration.rollback.restoreProcedure).toBeTruthy();
      }
    }
  });

  it('rejects duplicate or malformed registry entries', () => {
    const valid = definition({ id: '011-valid' });
    expect(() => validateMigrationRegistry([valid, valid])).toThrow('Duplicate migration id');
    expect(() => validateMigrationRegistry([definition({ id: 'not-versioned' })])).toThrow('Invalid versioned migration id');
  });

  it('parses safe CLI defaults and refuses ambiguous modes or unsafe batches', () => {
    expect(parseMigrationCliArgs([])).toMatchObject({ mode: 'dry-run', batchSize: 250 });
    expect(parseMigrationCliArgs(['--apply', '--migration=006-property-money-minor-units', '--batch-size=50'])).toMatchObject({ mode: 'apply', migrationId: '006-property-money-minor-units', batchSize: 50 });
    expect(() => parseMigrationCliArgs(['--apply', '--dry-run'])).toThrow();
    expect(() => parseMigrationCliArgs(['--batch-size=0'])).toThrow();
  });
});

/**
 * MongoDB refuses an update in which one path (or a parent/child of it) is set by
 * two operators, e.g. `attempts` in both $setOnInsert and $inc (code 40,
 * "Updating the path 'attempts' would create a conflict at 'attempts'"). Neither
 * the in-memory stores nor Mongoose's update casting enforce that, so the rule
 * is checked here on the exact update document the real store sends.
 */
function conflictingUpdatePaths(update: Record<string, Record<string, unknown>>): string[] {
  const owners = Object.entries(update).flatMap(([operator, fields]) => Object.keys(fields).map((path) => ({ operator, path })));
  return owners.flatMap((a, i) => owners.slice(i + 1)
    .filter((b) => a.operator !== b.operator && (a.path === b.path || a.path.startsWith(`${b.path}.`) || b.path.startsWith(`${a.path}.`)))
    .map((b) => `${a.operator}.${a.path} vs ${b.operator}.${b.path}`));
}

/** Records MongoMigrationStore's ledger writes and applies them with upsert semantics after the conflict check. */
function recordingLedgerDb() {
  const documents = new Map<string, Record<string, any>>();
  const updates: Array<Record<string, Record<string, unknown>>> = [];
  const ledger = {
    async updateOne(filter: { migrationId: string }, update: Record<string, Record<string, unknown>>, options?: { upsert?: boolean }) {
      updates.push(update);
      const conflicts = conflictingUpdatePaths(update);
      if (conflicts.length) throw Object.assign(new Error(`Updating the path would create a conflict: ${conflicts.join(', ')}`), { code: 40 });
      const existing = documents.get(filter.migrationId);
      if (!existing && !options?.upsert) return { matchedCount: 0 };
      const doc: Record<string, any> = existing ?? { ...filter, ...(update.$setOnInsert ?? {}) };
      Object.assign(doc, update.$set ?? {});
      for (const [path, by] of Object.entries(update.$inc ?? {})) doc[path] = (doc[path] ?? 0) + (by as number);
      for (const path of Object.keys(update.$unset ?? {})) delete doc[path];
      documents.set(filter.migrationId, doc);
      return { matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 };
    },
    async findOne(filter: { migrationId: string }) { return documents.get(filter.migrationId) ?? null; },
  };
  const db = { collection: (name: string) => (name === 'migration_ledger' ? ledger : {}) } as unknown as Db;
  return { db, updates, documents };
}

describe('MongoMigrationStore.begin ledger update (real-MongoDB update rules)', () => {
  const now = new Date('2026-09-26T12:00:00Z');

  it('sends an update with no path claimed by two operators: attempts only through $inc', async () => {
    const { db, updates } = recordingLedgerDb();
    await new MongoMigrationStore(db, () => now).begin(definition(), 'run-1');
    const [update] = updates;
    expect(conflictingUpdatePaths(update)).toEqual([]);
    expect(update.$setOnInsert).not.toHaveProperty('attempts');
    expect(update.$inc).toEqual({ attempts: 1 });
    expect(update.$setOnInsert).toEqual({ migrationId: '011-test', version: 1, checkpoint: undefined, batches: 0, scanned: 0, modified: 0, startedAt: now });
    expect(update.$set).toEqual({ status: 'running', runId: 'run-1', updatedAt: now });
    expect(update.$unset).toEqual({ failure: '' });
  });

  it('inserts the ledger with attempts 1 on the first begin and increments it on a retry', async () => {
    const { db, documents } = recordingLedgerDb();
    const store = new MongoMigrationStore(db, () => now);
    expect(await store.begin(definition(), 'run-1')).toMatchObject({ migrationId: '011-test', version: 1, status: 'running', runId: 'run-1', attempts: 1, batches: 0, scanned: 0, modified: 0, startedAt: now });
    documents.get('011-test')!.status = 'failed';
    documents.get('011-test')!.failure = { phase: 'apply', message: 'boom', at: now };
    const retried = await store.begin(definition(), 'run-2');
    expect(retried).toMatchObject({ status: 'running', runId: 'run-2', attempts: 2, startedAt: now });
    expect(retried).not.toHaveProperty('failure');
  });
});
