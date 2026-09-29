import mongoose from 'mongoose';
import { ConfigModule } from '@nestjs/config';
import { runIntegrityChecks } from './integrity-checker';
import { guardAction } from '../config/deployment-environment';

async function main(): Promise<void> {
  ConfigModule.forRoot();
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');
  await mongoose.connect(uri, { maxPoolSize: 5 });
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection has no database');
  await guardAction('integrity:read', process.env, db);
  const report = await runIntegrityChecks(db);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok || (process.argv.includes('--fail-on-warning') && report.warningCount > 0)) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, '[REDACTED_MONGO_URI]') : 'Unknown integrity error' }));
    process.exitCode = 1;
  }).finally(() => mongoose.disconnect().catch(() => undefined));
}
