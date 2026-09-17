import mongoose from 'mongoose';
import { ConfigModule } from '@nestjs/config';
import { CORE_MIGRATIONS, validateMigrationRegistry } from './framework/core-migrations';
import { MongoMigrationStore } from './framework/migration.store';
import { MigrationRunner } from './framework/migration.runner';

type CliOptions = { mode: 'dry-run' | 'apply'; migrationId?: string; batchSize: number; list: boolean };

export function parseMigrationCliArgs(args: string[]): CliOptions {
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  if (apply && dryRun) throw new Error('Choose exactly one of --apply or --dry-run');
  const migrationFlag = args.find((arg) => arg.startsWith('--migration='));
  const batchFlag = args.find((arg) => arg.startsWith('--batch-size='));
  const batchSize = batchFlag ? Number(batchFlag.split('=')[1]) : 250;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error('--batch-size must be an integer between 1 and 10000');
  return { mode: apply ? 'apply' : 'dry-run', migrationId: migrationFlag?.split('=')[1], batchSize, list: args.includes('--list') };
}

export async function runMigrationCli(args: string[]): Promise<void> {
  const options = parseMigrationCliArgs(args);
  validateMigrationRegistry();
  if (options.list) {
    console.log(JSON.stringify({ migrations: CORE_MIGRATIONS.map(({ id, version, description, dependencies, rollback }) => ({ id, version, description, dependencies: dependencies ?? [], rollback })) }, null, 2));
    return;
  }
  ConfigModule.forRoot();
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  const selected = options.migrationId ? CORE_MIGRATIONS.filter((migration) => migration.id === options.migrationId) : CORE_MIGRATIONS;
  if (!selected.length) throw new Error(`Unknown migration: ${options.migrationId}`);
  await mongoose.connect(uri, { maxPoolSize: 5 });
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection has no database');
  const store = new MongoMigrationStore(db);
  if (options.mode === 'apply') await store.ensureIndexes();
  const runner = new MigrationRunner(db, store, { batchSize: options.batchSize });
  for (const migration of selected) {
    const report = await runner.run(migration, options.mode);
    console.log(JSON.stringify(report));
  }
}

if (require.main === module) {
  void runMigrationCli(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[REDACTED_MONGO_URI]') : 'Unknown migration error' }));
    process.exitCode = 1;
  }).finally(() => mongoose.disconnect().catch(() => undefined));
}
