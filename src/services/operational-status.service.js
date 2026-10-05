'use strict';

const { operationalMetrics } = require('../common/observability/operational-metrics');
const { resolveDeploymentEnv } = require('../config/deployment-environment');
const DEFAULT_CLEANUP_ALERT_AGE_SECONDS = 3600;
const DEFAULT_PAYMENT_STALE_ALERT_SECONDS = 3600;
const PAYMENT_COLLECTIONS = ['managed_marketing_payments'];
const NO_PAYMENTS = {
  pending: 0,
  due: 0,
  stale: 0,
  expired: 0,
  flagged: 0,
  confirmedAfterExpiry: 0,
};
/**
 * Operator-facing diagnostics (Phase 13). It is deliberately NOT part of the
 * readiness probe: a failed migration, a stuck cleanup queue or a dead-lettered
 * outbox event must alert an operator, never pull healthy instances out of
 * rotation. Only cheap indexed reads: the migration ledger is tiny and the
 * cleanup queue is indexed by status.
 */
class OperationalStatusService {
  constructor(connection, config, provider) {
    this.connection = connection;
    this.config = config;
    this.provider = provider;
  }
  async status(now = new Date()) {
    const db = this.connection.db;
    const resolved = resolveDeploymentEnv({
      NODE_ENV: this.config.get('NODE_ENV'),
      DEPLOYMENT_ENV: this.config.get('DEPLOYMENT_ENV'),
    });
    const attention = [];
    const base = {
      deploymentEnv: resolved.env ?? null,
      uptimeSeconds: Math.floor((Date.now() - operationalMetrics.startedAt) / 1000),
      payment: { provider: this.provider.providerKey, configured: this.provider.configured },
      counters: operationalMetrics.snapshot(),
    };
    if (!db)
      return {
        ...base,
        database: 'down',
        migrations: { failed: [], running: [], lockHeld: false, complete: 0 },
        evidenceCleanup: { pending: 0, oldestPendingAgeSeconds: null },
        payments: { ...NO_PAYMENTS },
        attention: ['database'],
      };
    let database = 'up';
    let migrations = { failed: [], running: [], lockHeld: false, complete: 0 };
    let evidenceCleanup = { pending: 0, oldestPendingAgeSeconds: null };
    let payments = { ...NO_PAYMENTS };
    try {
      const ledger = await db
        .collection('migration_ledger')
        .find({}, { projection: { migrationId: 1, status: 1 } })
        .toArray();
      const lock = await db
        .collection('migration_locks')
        .findOne({ _id: 'global', expiresAt: { $gt: now } });
      migrations = {
        failed: ledger
          .filter((row) => row.status === 'failed')
          .map((row) => String(row.migrationId))
          .sort(),
        running: ledger
          .filter((row) => row.status === 'running')
          .map((row) => String(row.migrationId))
          .sort(),
        lockHeld: Boolean(lock),
        complete: ledger.filter((row) => row.status === 'complete').length,
      };
      const cleanup = db.collection('evidence_cleanup_tasks');
      const [pending, oldest] = await Promise.all([
        cleanup.countDocuments({ status: 'pending' }),
        cleanup
          .find({ status: 'pending' }, { projection: { createdAt: 1 } })
          .sort({ createdAt: 1 })
          .limit(1)
          .toArray(),
      ]);
      evidenceCleanup = {
        pending,
        oldestPendingAgeSeconds: oldest[0]?.createdAt
          ? Math.max(
              0,
              Math.floor((now.getTime() - new Date(oldest[0].createdAt).getTime()) / 1000),
            )
          : null,
      };
      payments = await this.paymentCounts(db, now);
    } catch {
      database = 'down';
    }
    const alertAge =
      Number(this.config.get('CLEANUP_ALERT_AGE_SECONDS')) || DEFAULT_CLEANUP_ALERT_AGE_SECONDS;
    if (database === 'down') attention.push('database');
    if (migrations.failed.length) attention.push('migrations_failed');
    if (migrations.running.length && !migrations.lockHeld) attention.push('migrations_interrupted');
    if (
      evidenceCleanup.oldestPendingAgeSeconds !== null &&
      evidenceCleanup.oldestPendingAgeSeconds > alertAge
    )
      attention.push('evidence_cleanup_stalled');
    if ((base.counters.outbox_dead_lettered ?? 0) > 0) attention.push('outbox_dead_lettered');
    if (payments.flagged > 0) attention.push('payments_reconciliation_required');
    if (payments.stale > 0) attention.push('payments_stale');
    return { ...base, database, migrations, evidenceCleanup, payments, attention };
  }
  /** Indexed counts only: (status, nextVerifyAt), (status, initiatedAt) and the partial flag indexes. */
  async paymentCounts(db, now) {
    const staleSeconds =
      Number(this.config.get('PAYMENT_STALE_ALERT_SECONDS')) || DEFAULT_PAYMENT_STALE_ALERT_SECONDS;
    const staleBefore = new Date(now.getTime() - staleSeconds * 1000);
    const totals = { ...NO_PAYMENTS };
    for (const name of PAYMENT_COLLECTIONS) {
      const collection = db.collection(name);
      const [pending, due, stale, expired, flagged, confirmedAfterExpiry] = await Promise.all([
        collection.countDocuments({ status: 'INITIATED' }),
        collection.countDocuments({ status: 'INITIATED', nextVerifyAt: { $lte: now } }),
        collection.countDocuments({ status: 'INITIATED', initiatedAt: { $lte: staleBefore } }),
        collection.countDocuments({ status: 'EXPIRED' }),
        collection.countDocuments({ reconciliationFlag: { $exists: true } }),
        collection.countDocuments({ reconciliationFlag: 'CONFIRMED_AFTER_EXPIRY' }),
      ]);
      totals.pending += pending;
      totals.due += due;
      totals.stale += stale;
      totals.expired += expired;
      totals.flagged += flagged;
      totals.confirmedAfterExpiry += confirmedAfterExpiry;
    }
    return totals;
  }
}

Object.assign(exports, { OperationalStatusService });
