import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { operationalMetrics } from '../common/observability/operational-metrics';
import { resolveDeploymentEnv } from '../config/deployment-environment';
import { AUCTION_PAYMENT_PROVIDER_PORT, AuctionPaymentProviderPort } from '../payments/auction-payment-provider.port';

const DEFAULT_CLEANUP_ALERT_AGE_SECONDS = 3600;
const DEFAULT_PAYMENT_STALE_ALERT_SECONDS = 3600;
const PAYMENT_COLLECTIONS = ['auction_entry_payments', 'managed_marketing_payments'] as const;

export type PaymentOperationalCounts = {
  /** INITIATED attempts (awaiting the provider). */
  pending: number;
  /** INITIATED attempts whose next verification is already due (the worker should pick them up within a tick). */
  due: number;
  /** INITIATED attempts older than PAYMENT_STALE_ALERT_SECONDS: reconciliation is not keeping up, or expiry is not configured. */
  stale: number;
  expired: number;
  /** Attempts parked with any reconciliation flag. */
  flagged: number;
  /** Of those: the provider reported success after the attempt had expired locally. */
  confirmedAfterExpiry: number;
  /** Auction-entry payments confirmed after their auction could no longer be bid on. */
  lateConfirmed: number;
};

const NO_PAYMENTS: PaymentOperationalCounts = { pending: 0, due: 0, stale: 0, expired: 0, flagged: 0, confirmedAfterExpiry: 0, lateConfirmed: 0 };

export type OperationalStatus = {
  deploymentEnv: string | null;
  uptimeSeconds: number;
  payment: { provider: string; configured: boolean };
  database: 'up' | 'down';
  migrations: { failed: string[]; running: string[]; lockHeld: boolean; complete: number };
  evidenceCleanup: { pending: number; oldestPendingAgeSeconds: number | null };
  /** MAZAD-035: SCHEDULED auctions the activation gate refused to start (an Admin must decide, e.g. cancel). */
  auctions: { activationHeld: number };
  /**
   * MAZAD-028: payment attempts of BOTH purposes (counts only; no references, amounts or accounts).
   * `flagged` / `confirmedAfterExpiry` / `lateConfirmed` need an operator's manual review — no automatic refund exists.
   */
  payments: PaymentOperationalCounts;
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
    if (!db) return { ...base, database: 'down', migrations: { failed: [], running: [], lockHeld: false, complete: 0 }, evidenceCleanup: { pending: 0, oldestPendingAgeSeconds: null }, auctions: { activationHeld: 0 }, payments: { ...NO_PAYMENTS }, attention: ['database'] };

    let database: 'up' | 'down' = 'up';
    let migrations: OperationalStatus['migrations'] = { failed: [], running: [], lockHeld: false, complete: 0 };
    let evidenceCleanup: OperationalStatus['evidenceCleanup'] = { pending: 0, oldestPendingAgeSeconds: null };
    let auctions: OperationalStatus['auctions'] = { activationHeld: 0 };
    let payments: PaymentOperationalCounts = { ...NO_PAYMENTS };
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
      // Served by the (status, scheduledStartAt) index; held auctions are few by construction.
      auctions = { activationHeld: await db.collection('auctions').countDocuments({ status: 'scheduled', activationHold: { $exists: true } }) };
      payments = await this.paymentCounts(db, now);
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
    if (auctions.activationHeld > 0) attention.push('auction_activation_held');
    if (payments.flagged > 0) attention.push('payments_reconciliation_required');
    if (payments.lateConfirmed > 0) attention.push('payments_late_confirmed');
    if (payments.stale > 0) attention.push('payments_stale');
    return { ...base, database, migrations, evidenceCleanup, auctions, payments, attention };
  }

  /** Indexed counts only: (status, nextVerifyAt), (status, initiatedAt) and the partial flag / late-confirmation indexes. */
  private async paymentCounts(db: NonNullable<Connection['db']>, now: Date): Promise<PaymentOperationalCounts> {
    const staleSeconds = Number(this.config.get('PAYMENT_STALE_ALERT_SECONDS')) || DEFAULT_PAYMENT_STALE_ALERT_SECONDS;
    const staleBefore = new Date(now.getTime() - staleSeconds * 1000);
    const totals = { ...NO_PAYMENTS };
    for (const name of PAYMENT_COLLECTIONS) {
      const collection = db.collection(name);
      const [pending, due, stale, expired, flagged, confirmedAfterExpiry, lateConfirmed] = await Promise.all([
        collection.countDocuments({ status: 'INITIATED' }),
        collection.countDocuments({ status: 'INITIATED', nextVerifyAt: { $lte: now } }),
        collection.countDocuments({ status: 'INITIATED', initiatedAt: { $lte: staleBefore } }),
        collection.countDocuments({ status: 'EXPIRED' }),
        collection.countDocuments({ reconciliationFlag: { $exists: true } }),
        collection.countDocuments({ reconciliationFlag: 'CONFIRMED_AFTER_EXPIRY' }),
        collection.countDocuments({ lateConfirmation: true }),
      ]);
      totals.pending += pending; totals.due += due; totals.stale += stale; totals.expired += expired;
      totals.flagged += flagged; totals.confirmedAfterExpiry += confirmedAfterExpiry; totals.lateConfirmed += lateConfirmed;
    }
    return totals;
  }
}
