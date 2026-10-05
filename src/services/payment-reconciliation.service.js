'use strict';

const { Logger } = require('../common/logging/logger');
const { PaymentErrorCode } = require('../common/errors/payment-error-codes');
const { operationalMetrics } = require('../common/observability/operational-metrics');
const { UNREFERENCED_ATTEMPT_GRACE_MS } = require('../domain/payments/payment-attempt-opening');
const {
  paymentAttemptTtlMs,
  reconciliationBackoffMs,
  reconciliationLeaseMs,
} = require('../domain/payments/payment-reconciliation.config');
const { EntryPaymentStatus } = require('../domain/payments/payment.types');
const FLAGGED_CODES = new Set([
  PaymentErrorCode.VERIFICATION_MISMATCH,
  PaymentErrorCode.CONFIRMED_AFTER_FAILURE,
  PaymentErrorCode.CONFIRMED_AFTER_EXPIRY,
]);
const emptyReconciliationSummary = () => ({
  claimed: 0,
  succeeded: 0,
  failed: 0,
  pending: 0,
  expired: 0,
  abandoned: 0,
  flagged: 0,
  error: 0,
  waiting: 0,
  skipped: 0,
});
/**
 * Reconciles INITIATED payment attempts of the supported purposes with the provider
 * (MAZAD-028). It decides nothing about money itself: every state change goes
 * through the purpose's own confirmation service, which asks the provider
 * server-to-server (`confirm`), or through that service's `expire` /
 * `failAbandoned` compare-and-set transitions.
 *
 * CLAIM / LEASE. A due attempt is claimed with ONE atomic write that pushes its
 * `nextVerifyAt` a lease into the future, so any number of worker instances
 * can run the same tick without two of them working the same attempt. If the
 * claimant crashes the lease simply lapses and the attempt is due again:
 * nothing is recorded before the confirmation transaction commits, so a
 * crash after "the provider said success" loses nothing — the next pass asks
 * again and applies it exactly once.
 *
 * EXPIRY. An attempt past the configured lifetime is verified one last time by
 * the same `confirm` call; only a provider answer of PENDING lets it expire. A
 * provider outage never expires anything.
 */
class PaymentReconciliationService {
  constructor(router, clock, config) {
    this.router = router;
    this.clock = clock;
    this.config = config;
    this.logger = new Logger(PaymentReconciliationService.name);
  }
  /** One bounded pass over every purpose: up to `batch` due attempts each, oldest due first. */
  async reconcileDue(batch) {
    const summary = emptyReconciliationSummary();
    for (const routed of this.router.purposes()) {
      const seen = new Set();
      for (let index = 0; index < batch; index++) {
        const attempt = await this.claim(routed.payments);
        if (!attempt) break;
        const id = attempt._id.toString();
        if (seen.has(id)) break; // a lease shorter than this pass: never spin on one attempt
        seen.add(id);
        summary.claimed += 1;
        const outcome = await this.reconcile(routed, attempt);
        summary[outcome] += 1;
        if (outcome === 'error')
          operationalMetrics.increment('payment_reconciliation_error', routed.purpose);
        if (outcome === 'expired') operationalMetrics.increment('payment_expired', routed.purpose);
        if (outcome === 'flagged')
          operationalMetrics.increment('payment_reconciliation_flagged', routed.purpose);
      }
    }
    return summary;
  }
  /** Atomically claims the oldest due unflagged INITIATED attempt by leasing its `nextVerifyAt`. */
  async claim(payments) {
    const now = this.clock.now();
    const lease = new Date(now.getTime() + reconciliationLeaseMs(this.env()));
    // Rows written before MAZAD-028 have no schedule yet: they are due. (Two indexed filters instead of one `$or`.)
    for (const due of [{ nextVerifyAt: { $lte: now } }, { nextVerifyAt: { $exists: false } }]) {
      const claimed = await payments
        .findOneAndUpdate(
          { status: EntryPaymentStatus.INITIATED, reconciliationFlag: { $exists: false }, ...due },
          { $set: { nextVerifyAt: lease }, $inc: { verifyAttempts: 1 } },
          { new: true, sort: { nextVerifyAt: 1, _id: 1 } },
        )
        .lean()
        .exec();
      if (claimed) return claimed;
    }
    return null;
  }
  async reconcile(routed, attempt) {
    const id = attempt._id.toString();
    const now = this.clock.now();
    const initiatedAt = new Date(attempt.initiatedAt).getTime();
    const age = now.getTime() - initiatedAt;
    try {
      if (!attempt.providerReference) {
        // Never opened with the provider. Young: an initiation may still be in flight. Old: abandoned, and no hand-off ever reached a client.
        if (age < UNREFERENCED_ATTEMPT_GRACE_MS) {
          await this.reschedule(
            routed.payments,
            attempt._id,
            new Date(initiatedAt + UNREFERENCED_ATTEMPT_GRACE_MS),
          );
          return 'waiting';
        }
        return (await routed.lifecycle.failAbandoned(id)) ? 'abandoned' : 'skipped';
      }
      let result;
      try {
        result = await routed.lifecycle.confirm(id); // the ONLY source of an outcome: the provider, asked server-to-server
      } catch (error) {
        const code = error?.getResponse?.()?.code;
        if (typeof code === 'string' && FLAGGED_CODES.has(code)) return 'flagged'; // parked for an operator; its flag keeps it out of the scan
        await this.reschedule(
          routed.payments,
          attempt._id,
          this.nextAttemptAt(attempt, now, initiatedAt),
        );
        this.report(routed.purpose, id, error);
        return 'error'; // provider outage or an unexpected state: retried with backoff, never expired
      }
      if (!result.pending)
        return result.status === EntryPaymentStatus.SUCCEEDED
          ? 'succeeded'
          : result.status === EntryPaymentStatus.FAILED
            ? 'failed'
            : 'skipped';
      const ttl = paymentAttemptTtlMs(this.env());
      // The `confirm` above WAS the final authoritative verification: the provider still says PENDING.
      if (ttl !== null && age >= ttl)
        return (await routed.lifecycle.expire(id)) ? 'expired' : 'skipped';
      await this.reschedule(
        routed.payments,
        attempt._id,
        this.nextAttemptAt(attempt, now, initiatedAt),
      );
      return 'pending';
    } catch (error) {
      this.report(routed.purpose, id, error);
      return 'error'; // the lease lapses and the attempt is retried
    }
  }
  /** Backoff by pass count, but never past the attempt's expiry instant (so expiry is not delayed by a long step). */
  nextAttemptAt(attempt, now, initiatedAt) {
    const steps = reconciliationBackoffMs(this.env());
    const step = steps[Math.min(Math.max((attempt.verifyAttempts ?? 1) - 1, 0), steps.length - 1)];
    const ttl = paymentAttemptTtlMs(this.env());
    const expiresAt = ttl === null ? Infinity : initiatedAt + ttl;
    return new Date(
      expiresAt > now.getTime() ? Math.min(now.getTime() + step, expiresAt) : now.getTime() + step,
    );
  }
  async reschedule(payments, id, at) {
    await payments
      .updateOne({ _id: id, status: EntryPaymentStatus.INITIATED }, { $set: { nextVerifyAt: at } })
      .exec();
  }
  report(purpose, paymentId, error) {
    // Identifiers and a stable code only: never a provider payload, reference or message.
    this.logger.warn(
      JSON.stringify({
        event: 'payment_reconciliation_retry',
        purpose,
        paymentId,
        code: error?.getResponse?.()?.code ?? null,
        errorName: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
  env() {
    return {
      NODE_ENV: this.config.get('NODE_ENV'),
      DEPLOYMENT_ENV: this.config.get('DEPLOYMENT_ENV'),
      PAYMENT_ATTEMPT_TTL_SECONDS: this.config.get('PAYMENT_ATTEMPT_TTL_SECONDS'),
      PAYMENT_RECONCILIATION_BACKOFF_SECONDS: this.config.get(
        'PAYMENT_RECONCILIATION_BACKOFF_SECONDS',
      ),
      PAYMENT_RECONCILIATION_LEASE_SECONDS: this.config.get('PAYMENT_RECONCILIATION_LEASE_SECONDS'),
    };
  }
}

Object.assign(exports, { emptyReconciliationSummary, PaymentReconciliationService });
