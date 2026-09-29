import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { operationalMetrics } from '../common/observability/operational-metrics';
import { resolveDeploymentEnv } from '../config/deployment-environment';
import { AUCTION_PAYMENT_PROVIDER_PORT, AuctionPaymentProviderPort } from '../payments/auction-payment-provider.port';

const DEFAULT_CLEANUP_ALERT_AGE_SECONDS = 3600;

export type OperationalStatus = {
  deploymentEnv: string | null;
  uptimeSeconds: number;
  payment: { provider: string; configured: boolean };
  database: 'up' | 'down';
  migrations: { failed: string[]; running: string[]; lockHeld: boolean; complete: number };
  evidenceCleanup: { pending: number; oldestPendingAgeSeconds: number | null };
  counters: Record<string, number>;
  /** Names of the areas that need an operator's attention (empty when everything is quiet). */
  attention: string[];
};

/**
 * Operator-facing diagnostics (Phase 13). It is deliberately NOT part of the
 * readiness probe: a failed migration, a stuck cleanup queue or a dead-lettered
 * outbox event must alert an operator, never pull healthy instances out of
 * rotation. Only cheap indexed reads: the migration ledger is tiny and the
 * cleanup queue is indexed by status.
 */
@Injectable()
export class OperationalStatusService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly config: ConfigService,
    @Inject(AUCTION_PAYMENT_PROVIDER_PORT) private readonly provider: AuctionPaymentProviderPort,
  ) {}

  async status(now = new Date()): Promise<OperationalStatus> {
    const db = this.connection.db;
    const resolved = resolveDeploymentEnv({ NODE_ENV: this.config.get('NODE_ENV'), DEPLOYMENT_ENV: this.config.get('DEPLOYMENT_ENV') });
    const attention: string[] = [];
    const base = {
      deploymentEnv: resolved.env ?? null,
      uptimeSeconds: Math.floor((Date.now() - operationalMetrics.startedAt) / 1000),
      payment: { provider: this.provider.providerKey, configured: this.provider.configured },
      counters: operationalMetrics.snapshot(),
    };
    if (!db) return { ...base, database: 'down', migrations: { failed: [], running: [], lockHeld: false, complete: 0 }, evidenceCleanup: { pending: 0, oldestPendingAgeSeconds: null }, attention: ['database'] };

    let database: 'up' | 'down' = 'up';
    let migrations: OperationalStatus['migrations'] = { failed: [], running: [], lockHeld: false, complete: 0 };
    let evidenceCleanup: OperationalStatus['evidenceCleanup'] = { pending: 0, oldestPendingAgeSeconds: null };
    try {
      const ledger = await db.collection('migration_ledger').find({}, { projection: { migrationId: 1, status: 1 } }).toArray();
      const lock = await db.collection('migration_locks').findOne({ _id: 'global' as never, expiresAt: { $gt: now } });
      migrations = {
        failed: ledger.filter((row) => row.status === 'failed').map((row) => String(row.migrationId)).sort(),
        running: ledger.filter((row) => row.status === 'running').map((row) => String(row.migrationId)).sort(),
        lockHeld: Boolean(lock),
        complete: ledger.filter((row) => row.status === 'complete').length,
      };
      const cleanup = db.collection('evidence_cleanup_tasks');
      const [pending, oldest] = await Promise.all([
        cleanup.countDocuments({ status: 'pending' }),
        cleanup.find({ status: 'pending' }, { projection: { createdAt: 1 } }).sort({ createdAt: 1 }).limit(1).toArray(),
      ]);
      evidenceCleanup = { pending, oldestPendingAgeSeconds: oldest[0]?.createdAt ? Math.max(0, Math.floor((now.getTime() - new Date(oldest[0].createdAt).getTime()) / 1000)) : null };
    } catch {
      database = 'down';
    }

    const alertAge = Number(this.config.get('CLEANUP_ALERT_AGE_SECONDS')) || DEFAULT_CLEANUP_ALERT_AGE_SECONDS;
    if (database === 'down') attention.push('database');
    if (migrations.failed.length) attention.push('migrations_failed');
    if (migrations.running.length && !migrations.lockHeld) attention.push('migrations_interrupted');
    if (evidenceCleanup.oldestPendingAgeSeconds !== null && evidenceCleanup.oldestPendingAgeSeconds > alertAge) attention.push('evidence_cleanup_stalled');
    if ((base.counters.outbox_dead_lettered ?? 0) > 0) attention.push('outbox_dead_lettered');
    if ((base.counters.auction_anchor_unresolved ?? 0) > 0) attention.push('auction_anchor_unresolved');
    return { ...base, database, migrations, evidenceCleanup, attention };
  }
}
