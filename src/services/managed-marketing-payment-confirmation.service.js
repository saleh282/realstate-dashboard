'use strict';

const {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} = require('../common/http/errors');
const { Types } = require('mongoose');
const { AuditAction } = require('../models/audit-log.model');
const { PaymentErrorCode } = require('../common/errors/payment-error-codes');
const {
  TransactionAttemptConflict,
  retryConflict,
  runTransactionWithRetry,
} = require('../common/mongo/transaction-runner');
const { managedMarketingPaymentConfirmedEvent } = require('../domain/outbox/outbox-events');
const {
  ManagedMarketingPaymentStatus,
  ManagedMarketingRequestStatus,
} = require('../domain/managed-marketing/managed-marketing.types');
const { MM_PAYMENT_UNIQUE_INDEXES } = require('./managed-marketing-payment.service');
const { decideOutcome } = require('../domain/payments/payment-verification');
const {
  EntryPaymentStatus,
  PaymentPurpose,
  PaymentReconciliationFlag,
} = require('../domain/payments/payment.types');
/**
 * The ONLY path that turns a managed-marketing request PAID (MAZAD-028).
 * Server-side verification: no outcome is accepted
 * from the caller; the provider port is asked server-to-server, and the
 * verified answer is compared (shared `decideOutcome`) with the amount and
 * currency copied from the request's immutable package snapshot.
 *
 * Business effect, all in ONE transaction and only on verified success:
 *   payment INITIATED→SUCCEEDED  +  request {APPROVED, PENDING} → {PAID, SUCCEEDED, paidAt, paidPaymentId}
 * Nothing else: no schedule/SLA dates, no inspection/photography states, no other workflow changes. Any disagreement or ambiguity parks the request in
 * `RECONCILIATION_REQUIRED` (operator action), granting nothing.
 *
 * Expiry (`expire`) moves the attempt INITIATED → EXPIRED and the request
 * back to `paymentStatus: FAILED` — the existing "payable and cancellable
 * again" state — so a new attempt can be initiated.
 */
class ManagedMarketingPaymentConfirmationService {
  constructor(requests, payments, audit, clock, provider, connection, outbox) {
    this.requests = requests;
    this.payments = payments;
    this.audit = audit;
    this.clock = clock;
    this.provider = provider;
    this.connection = connection;
    this.outbox = outbox;
    this.purpose = PaymentPurpose.MANAGED_MARKETING;
  }
  async confirm(paymentId) {
    if (!Types.ObjectId.isValid(paymentId)) throw this.notFound();
    const payment = await this.payments.findById(paymentId).lean().exec();
    if (!payment) throw this.notFound();
    if (payment.status === EntryPaymentStatus.SUCCEEDED) return this.apply(paymentId, undefined); // replay: no provider call
    if (!payment.providerReference && payment.status !== EntryPaymentStatus.INITIATED) {
      // A terminal attempt that never reached the provider (failed while opening): nothing can be asked, nothing changes.
      return {
        paymentId,
        requestId: payment.requestId.toString(),
        status: payment.status,
        alreadyProcessed: true,
        pending: false,
        requestPaid: false,
      };
    }
    if (!payment.providerReference) {
      throw new ConflictException({
        message: 'عملية الدفع لم تُفتح لدى مزود الدفع بعد',
        code: PaymentErrorCode.STATE_INCONSISTENT,
      });
    }
    const outcome = await this.provider.verify(payment.providerReference);
    return this.apply(paymentId, outcome);
  }
  notFound() {
    return new NotFoundException({
      message: 'عملية الدفع غير موجودة',
      code: PaymentErrorCode.NOT_FOUND,
    });
  }
  async apply(paymentId, outcome) {
    const { result, rejection } = await runTransactionWithRetry(
      this.connection,
      (session) => this.applyWithinTransaction(session, paymentId, outcome),
      {
        uniqueIndexNames: MM_PAYMENT_UNIQUE_INDEXES,
        retryExhausted: retryConflict(
          'تأكيد الدفع قيد المعالجة؛ أعد المحاولة',
          PaymentErrorCode.RETRY_EXHAUSTED,
        ),
      },
    );
    if (rejection)
      throw new ConflictException({ message: rejection.message, code: rejection.code });
    return result;
  }
  async applyWithinTransaction(session, paymentId, outcome) {
    const now = this.clock.now();
    const payment = await this.payments.findById(paymentId).session(session).lean().exec();
    if (!payment) throw this.notFound();
    const requestId = payment.requestId.toString();
    const done = (status, extra = {}) => ({
      result: {
        paymentId,
        requestId,
        status,
        alreadyProcessed: false,
        pending: false,
        requestPaid: false,
        ...extra,
      },
    });
    if (payment.status === EntryPaymentStatus.SUCCEEDED) {
      // Idempotent replay. The request must already be PAID by this very payment; anything else is corruption, never silently "fixed".
      const request = await this.requests
        .findById(payment.requestId)
        .session(session)
        .lean()
        .exec();
      if (
        !request ||
        request.status !== ManagedMarketingRequestStatus.PAID ||
        String(request.paidPaymentId) !== paymentId
      ) {
        throw new InternalServerErrorException({
          message: 'تعذر تأكيد الدفع',
          code: PaymentErrorCode.STATE_INCONSISTENT,
        });
      }
      return done(EntryPaymentStatus.SUCCEEDED, { alreadyProcessed: true, requestPaid: true });
    }
    if (!outcome)
      throw new TransactionAttemptConflict('payment state changed since the provider was asked');
    if (payment.status === EntryPaymentStatus.FAILED) {
      if (outcome.status !== 'SUCCEEDED')
        return done(EntryPaymentStatus.FAILED, { alreadyProcessed: true });
      return this.flag(
        session,
        payment,
        PaymentReconciliationFlag.CONFIRMED_AFTER_FAILURE,
        PaymentErrorCode.CONFIRMED_AFTER_FAILURE,
        'تم تأكيد دفعة مسجلة كفاشلة وتحتاج مراجعة يدوية',
        outcome,
        now,
      );
    }
    if (payment.status === EntryPaymentStatus.EXPIRED) {
      // The attempt expired locally; a success now is the provider's truth arriving late. It is recorded, never applied.
      if (outcome.status !== 'SUCCEEDED')
        return done(EntryPaymentStatus.EXPIRED, { alreadyProcessed: true });
      return this.flag(
        session,
        payment,
        PaymentReconciliationFlag.CONFIRMED_AFTER_EXPIRY,
        PaymentErrorCode.CONFIRMED_AFTER_EXPIRY,
        'تم تأكيد دفعة انتهت مهلتها وتحتاج مراجعة يدوية',
        outcome,
        now,
      );
    }
    const decision = decideOutcome(payment, outcome);
    if (decision.kind === 'MISMATCH') {
      return this.flag(
        session,
        payment,
        decision.flag,
        PaymentErrorCode.VERIFICATION_MISMATCH,
        'بيانات الدفع لا تطابق السجل',
        outcome,
        now,
      );
    }
    if (decision.kind === 'PENDING') return done(EntryPaymentStatus.INITIATED, { pending: true });
    if (decision.kind === 'FAILED') {
      const failed = await this.payments
        .findOneAndUpdate(
          { _id: payment._id, status: EntryPaymentStatus.INITIATED },
          {
            $set: {
              status: EntryPaymentStatus.FAILED,
              failedAt: now,
              failureCode: (outcome.failureCode ?? 'PROVIDER_REPORTED_FAILURE').slice(0, 100),
              lastVerifiedAt: now,
            },
            $unset: { isLive: '' },
          },
          { new: true, session },
        )
        .lean()
        .exec();
      if (!failed)
        throw new TransactionAttemptConflict('payment changed under a failure confirmation');
      // Back to a payable AND cancellable state (FAILED), never PAID.
      await this.requests
        .findOneAndUpdate(
          { _id: payment.requestId, paymentStatus: ManagedMarketingPaymentStatus.PENDING },
          { $set: { paymentStatus: ManagedMarketingPaymentStatus.FAILED } },
          { new: true, session },
        )
        .lean()
        .exec();
      await this.audit.logSystemRequired(
        {
          action: AuditAction.MANAGED_MARKETING_PAYMENT_FAILED,
          targetResourceId: requestId,
          targetUserId: payment.advertiserAccountId.toString(),
          reason: 'managed-marketing payment failed',
          metadata: { paymentId, provider: payment.provider, failureCode: outcome.failureCode },
        },
        session,
      );
      return done(EntryPaymentStatus.FAILED);
    }
    // Verified SUCCESS. The payment write comes first (concurrent confirmations collide on it).
    const confirmed = await this.payments
      .findOneAndUpdate(
        { _id: payment._id, status: EntryPaymentStatus.INITIATED },
        {
          $set: {
            status: EntryPaymentStatus.SUCCEEDED,
            confirmedAt: now,
            lastVerifiedAt: now,
            ...(outcome.providerEventId
              ? { providerEventId: outcome.providerEventId.slice(0, 200) }
              : {}),
          },
        },
        { new: true, session },
      )
      .lean()
      .exec();
    if (!confirmed)
      throw new TransactionAttemptConflict('payment changed under a success confirmation');
    const paid = await this.requests
      .findOneAndUpdate(
        {
          _id: payment.requestId,
          status: ManagedMarketingRequestStatus.APPROVED,
          paymentStatus: ManagedMarketingPaymentStatus.PENDING,
        },
        {
          $set: {
            status: ManagedMarketingRequestStatus.PAID,
            paymentStatus: ManagedMarketingPaymentStatus.SUCCEEDED,
            paidAt: now,
            paidPaymentId: payment._id,
          },
        },
        { new: true, session },
      )
      .lean()
      .exec();
    if (!paid) {
      // Not the expected APPROVED/PENDING request: do not force it. Abort (payment stays INITIATED) for the operator.
      throw new InternalServerErrorException({
        message: 'تعذر تأكيد الدفع',
        code: PaymentErrorCode.STATE_INCONSISTENT,
      });
    }
    await this.audit.logSystemRequired(
      {
        action: AuditAction.MANAGED_MARKETING_PAYMENT_CONFIRMED,
        targetResourceId: requestId,
        targetUserId: payment.advertiserAccountId.toString(),
        reason: 'managed-marketing payment confirmed',
        metadata: {
          paymentId,
          provider: payment.provider,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          providerEventId: outcome.providerEventId,
        },
      },
      session,
    );
    // MAZAD-031: emitted ONLY on this verified-success transition (payment SUCCEEDED + request PAID, one
    // transaction). Replay, PENDING, FAILED and RECONCILIATION_REQUIRED paths return before this line. It is a
    // MANAGED_MARKETING event on the request aggregate: it records the verified payment and PAID transition.
    await this.outbox.recordRequired(
      managedMarketingPaymentConfirmedEvent({
        requestId,
        paymentId: confirmed._id.toString(),
        occurredAt: now,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        advertiserAccountId: payment.advertiserAccountId.toString(),
      }),
      session,
    );
    return done(EntryPaymentStatus.SUCCEEDED, { requestPaid: true });
  }
  /**
   * The worker's INITIATED → EXPIRED transition, with the request returned to a payable AND cancellable state
   * (`paymentStatus: FAILED`), atomically. Called only after a final provider verification still answered PENDING.
   */
  async expire(paymentId) {
    return this.close(
      paymentId,
      { reconciliationFlag: { $exists: false } },
      { status: EntryPaymentStatus.EXPIRED },
      'expiredAt',
      AuditAction.MANAGED_MARKETING_PAYMENT_EXPIRED,
      'managed-marketing payment expired',
    );
  }
  /** Fails an INITIATED attempt that never received a provider reference (no hand-off ever reached a client) and frees the request. */
  async failAbandoned(paymentId) {
    return this.close(
      paymentId,
      { providerReference: { $exists: false } },
      { status: EntryPaymentStatus.FAILED, failureCode: 'PROVIDER_INITIATION_ABANDONED' },
      'failedAt',
      AuditAction.MANAGED_MARKETING_PAYMENT_FAILED,
      'managed-marketing payment abandoned before the provider opened it',
    );
  }
  close(paymentId, guard, set, stamp, action, reason) {
    return runTransactionWithRetry(
      this.connection,
      async (session) => {
        const now = this.clock.now();
        const closed = await this.payments
          .findOneAndUpdate(
            { _id: new Types.ObjectId(paymentId), status: EntryPaymentStatus.INITIATED, ...guard },
            {
              $set: { ...set, [stamp]: now, lastVerifiedAt: now },
              $unset: { isLive: '', initiationClaimedAt: '' },
            },
            { new: true, session },
          )
          .lean()
          .exec();
        if (!closed) return false;
        // Back to the existing "payable and cancellable" state. A request that is not PENDING is left exactly as it is.
        await this.requests
          .findOneAndUpdate(
            { _id: closed.requestId, paymentStatus: ManagedMarketingPaymentStatus.PENDING },
            { $set: { paymentStatus: ManagedMarketingPaymentStatus.FAILED } },
            { new: true, session },
          )
          .lean()
          .exec();
        await this.audit.logSystemRequired(
          {
            action,
            targetResourceId: closed.requestId.toString(),
            targetUserId: closed.advertiserAccountId.toString(),
            reason,
            metadata: {
              paymentId,
              provider: closed.provider,
              initiatedAt: closed.initiatedAt,
              ...(set.failureCode ? { failureCode: set.failureCode } : {}),
            },
          },
          session,
        );
        return true;
      },
      {
        uniqueIndexNames: MM_PAYMENT_UNIQUE_INDEXES,
        retryExhausted: retryConflict(
          'تأكيد الدفع قيد المعالجة؛ أعد المحاولة',
          PaymentErrorCode.RETRY_EXHAUSTED,
        ),
      },
    );
  }
  /** Records the disagreement, parks the request for the operator (RECONCILIATION_REQUIRED), commits, then rejects. Grants nothing. */
  async flag(session, payment, flag, code, message, outcome, now) {
    const rejected = {
      result: {
        paymentId: payment._id.toString(),
        requestId: payment.requestId.toString(),
        status: payment.status,
        alreadyProcessed: false,
        pending: false,
        requestPaid: false,
      },
      rejection: { code, message },
    };
    // Already recorded: a repeated trigger keeps answering the rejection without writing a second flag/audit row.
    if (payment.reconciliationFlag === flag) return rejected;
    await this.payments
      .updateOne(
        { _id: payment._id, status: payment.status },
        {
          $set: {
            reconciliationFlag: flag,
            lastVerifiedAt: now,
            ...(outcome.providerEventId
              ? { providerEventId: outcome.providerEventId.slice(0, 200) }
              : {}),
          },
        },
        { session },
      )
      .exec();
    await this.requests
      .findOneAndUpdate(
        {
          _id: payment.requestId,
          status: ManagedMarketingRequestStatus.APPROVED,
          paymentStatus: {
            $in: [ManagedMarketingPaymentStatus.PENDING, ManagedMarketingPaymentStatus.FAILED],
          },
        },
        { $set: { paymentStatus: ManagedMarketingPaymentStatus.RECONCILIATION_REQUIRED } },
        { new: true, session },
      )
      .lean()
      .exec();
    await this.audit.logSystemRequired(
      {
        action: AuditAction.MANAGED_MARKETING_PAYMENT_REJECTED,
        targetResourceId: payment.requestId.toString(),
        targetUserId: payment.advertiserAccountId.toString(),
        reason: 'managed-marketing payment verification rejected',
        metadata: {
          paymentId: payment._id.toString(),
          flag,
          paymentStatus: payment.status,
          expectedAmountMinor: payment.amountMinor,
          expectedCurrency: payment.currency,
          reportedAmountMinor: outcome.amountMinor,
          reportedCurrency: outcome.currency,
          reportedStatus: outcome.status,
          providerEventId: outcome.providerEventId,
        },
      },
      session,
    );
    return rejected;
  }
}

Object.assign(exports, { ManagedMarketingPaymentConfirmationService });
