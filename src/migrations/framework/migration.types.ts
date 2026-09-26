import type { Db } from 'mongodb';

export type MigrationMode = 'dry-run' | 'apply';
export type MigrationStatus = 'running' | 'complete' | 'failed';

export type MigrationPreflight = {
  eligible: number;
  alreadyApplied: number;
  blockers: Array<{ code: string; message: string; sampleIds?: string[] }>;
  summary?: Record<string, unknown>;
};

export type MigrationBatchResult = {
  scanned: number;
  modified: number;
  checkpoint?: string;
  done: boolean;
};

export type MigrationValidation = {
  valid: boolean;
  errors: Array<{ code: string; message: string }>;
  summary?: Record<string, unknown>;
};

export type MigrationContext = {
  db: Db;
  runId: string;
  batchSize: number;
  checkpoint?: string;
};

export type MigrationDefinition = {
  id: string;
  version: number;
  description: string;
  dependencies?: string[];
  /** Runs only when explicitly selected with `--migration=<id>`, never as part of a full apply. */
  manualOnly?: boolean;
  rollback:
    | { kind: 'automatic'; instructions: string }
    | { kind: 'none'; remediation: string; restoreProcedure: string };
  preflight(context: MigrationContext): Promise<MigrationPreflight>;
  migrateBatch(context: MigrationContext): Promise<MigrationBatchResult>;
  validate(context: MigrationContext): Promise<MigrationValidation>;
};

export type MigrationLedgerRecord = {
  migrationId: string;
  version: number;
  status: MigrationStatus;
  runId: string;
  checkpoint?: string;
  batches: number;
  scanned: number;
  modified: number;
  attempts: number;
  startedAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  failure?: { phase: string; message: string; at: Date };
};

export type MigrationRunReport = {
  migrationId: string;
  version: number;
  mode: MigrationMode;
  runId: string;
  status: 'dry-run-complete' | 'complete' | 'skipped-complete' | 'failed';
  preflight?: MigrationPreflight;
  validation?: MigrationValidation;
  batches: number;
  scanned: number;
  modified: number;
  resumedFromCheckpoint?: string;
};
