import { ConflictException, Inject, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { PaymentErrorCode } from '../common/errors/payment-error-codes';
import { TransactionAttemptConflict, retryConflict, runTransactionWithRetry } from '../common/mongo/transaction-runner';
import { ClockService } from '../common/time/clock.service';
import { ManagedMarketingPaymentStatus, ManagedMarketingRequestStatus } from '../managed-marketing/managed-marketing.types';
import { ManagedMarketingRequest, ManagedMarketingRequestDocument } from '../managed-marketing/schemas/managed-marketing-request.schema';
import { AUCTION_PAYMENT_PROVIDER_PORT, AuctionPaymentProviderPort } from './auction-payment-provider.port';
import { MM_PAYMENT_UNIQUE_INDEXES } from './managed-marketing-payment.service';
import { decideOutcome } from './payment-verification';
import { EntryPaymentStatus, PaymentReconciliationFlag, VerifiedProviderOutcome } from './payment.types';
import { ManagedMarketingPayment, ManagedMarketingPaymentDocument } from './schemas/managed-marketing-payment.schema';

export type ManagedMarketingPaymentConfirmationResult = {
  paymentId: string;
  requestId: string;
  status: EntryPaymentStatus;
  alreadyProcessed: boolean;
  pending: boolean;
  /** True iff the request is now (or already was) PAID by this payment. */
  requestPaid: boolean;
};

type Outcome = { result: ManagedMarketingPaymentConfirmationResult; rejection?: { code: PaymentErrorCode; message: string } };

/**
 * The ONLY path that turns a managed-marketing request PAID (MAZAD-028).
 * Same trust model as the auction-entry confirmation: no outcome is accepted
 * from the caller; the provider port is asked server-to-server, and the
 * verified answer is compared (shared `decideOutcome`) with the amount and
 * currency copied from the request's immutable package snapshot.
 *
 * Business effect, all in ONE transaction and only on verified success:
 *   payment INITIATED→SUCCEEDED  +  request {APPROVED, PENDING} → {PAID, SUCCEEDED, paidAt, paidPaymentId}
 * Nothing else: no schedule/SLA dates, no inspection/photography states, no
 * auction entitlement, auction, or bid — this service does not even inject
 * those models. Any disagreement or ambiguity parks the request in
 * `RECONCILIATION_REQUIRED` (operator action), granting nothing.
 */
@Injectable()
export class ManagedMarketingPaymentConfirmationService {
  constructor(
    @InjectModel(ManagedMarketingRequest.name) private readonly requests: Model<ManagedMarketingRequestDocument>,
    @InjectModel(ManagedMarketingPayment.name) private readonly payments: Model<ManagedMarketingPaymentDocument>,
    private readonly audit: AuditLogService,
    private readonly clock: ClockService,
    @Inject(AUCTION_PAYMENT_PROVIDER_PORT) private readonly provider: AuctionPaymentProviderPort,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async confirm(paymentId: string): Promise<ManagedMarketingPaymentConfirmationResult> {
    if (!Types.ObjectId.isValid(paymentId)) throw this.notFound();
    const payment: any = await this.payments.findById(paymentId).lean().exec();
    if (!payment) throw this.notFound();
    if (payment.status === EntryPaymentStatus.SUCCEEDED) return this.apply(paymentId, undefined); // replay: no provider call
    if (!payment.providerReference) {
      throw new ConflictException({ message: 'عملية الدفع لم تُفتح لدى مزود الدفع بعد', code: PaymentErrorCode.STATE_INCONSISTENT });
    }
    const outcome = await this.provider.verify(payment.providerReference);
    return this.apply(paymentId, outcome);
  }

  private notFound() {
    return new NotFoundException({ message: 'عملية الدفع غير موجودة', code: PaymentErrorCode.NOT_FOUND });
  }

  private async apply(paymentId: string, outcome: VerifiedProviderOutcome | undefined) {
    const { result, rejection } = await runTransactionWithRetry(
      this.connection,
      (session) => this.applyWithinTransaction(session, paymentId, outcome),
      { uniqueIndexNames: MM_PAYMENT_UNIQUE_INDEXES, retryExhausted: retryConflict('تأكيد الدفع قيد المعالجة؛ أعد المحاولة', PaymentErrorCode.RETRY_EXHAUSTED) },
    );
    if (rejection) throw new ConflictException({ message: rejection.message, code: rejection.code });
    return result;
  }

  private async applyWithinTransaction(session: ClientSession, paymentId: string, outcome: VerifiedProviderOutcome | undefined): Promise<Outcome> {
    const now = this.clock.now();
    const payment: any = await this.payments.findById(paymentId).session(session).lean().exec();
    if (!payment) throw this.notFound();
    const requestId = payment.requestId.toString();
    const done = (status: EntryPaymentStatus, extra: Partial<ManagedMarketingPaymentConfirmationResult> = {}): Outcome => ({
      result: { paymentId, requestId, status, alreadyProcessed: false, pending: false, requestPaid: false, ...extra },
    });

    if (payment.status === EntryPaymentStatus.SUCCEEDED) {
      // Idempotent replay. The request must already be PAID by this very payment; anything else is corruption, never silently "fixed".
      const request: any = await this.requests.findById(payment.requestId).session(session).lean().exec();
      if (!request || request.status !== ManagedMarketingRequestStatus.PAID || String(request.paidPaymentId) !== paymentId) {
        throw new InternalServerErrorException({ message: 'تعذر تأكيد الدفع', code: PaymentErrorCode.STATE_INCONSISTENT });
      }
      return done(EntryPaymentStatus.SUCCEEDED, { alreadyProcessed: true, requestPaid: true });
    }
    if (!outcome) throw new TransactionAttemptConflict('payment state changed since the provider was asked');

    if (payment.status === EntryPaymentStatus.FAILED) {
      if (outcome.status !== 'SUCCEEDED') return done(EntryPaymentStatus.FAILED, { alreadyProcessed: true });
      return this.flag(session, payment, PaymentReconciliationFlag.CONFIRMED_AFTER_FAILURE, PaymentErrorCode.CONFIRMED_AFTER_FAILURE, 'تم تأكيد دفعة مسجلة كفاشلة وتحتاج مراجعة يدوية', outcome, now);
    }

    const decision = decideOutcome(payment, outcome);
    if (decision.kind === 'MISMATCH') {
      return this.flag(session, payment, decision.flag, PaymentErrorCode.VERIFICATION_MISMATCH, 'بيانات الدفع لا تطابق السجل', outcome, now);
    }
    if (decision.kind === 'PENDING') return done(EntryPaymentStatus.INITIATED, { pending: true });

    if (decision.kind === 'FAILED') {
      const failed = await this.payments
        .findOneAndUpdate(
          { _id: payment._id, status: EntryPaymentStatus.INITIATED },
          { $set: { status: EntryPaymentStatus.FAILED, failedAt: now, failureCode: (outcome.failureCode ?? 'PROVIDER_REPORTED_FAILURE').slice(0, 100), lastVerifiedAt: now }, $unset: { isLive: '' } },
          { new: true, session },
        )
        .lean().exec();
      if (!failed) throw new TransactionAttemptConflict('payment changed under a failure confirmation');
      // Back to a payable AND cancellable state (FAILED), never PAID.
      await this.requests
        .findOneAndUpdate({ _id: payment.requestId, paymentStatus: ManagedMarketingPaymentStatus.PENDING }, { $set: { paymentStatus: ManagedMarketingPaymentStatus.FAILED } }, { new: true, session })
        .lean().exec();
      await this.audit.logSystemRequired(
        { action: AuditAction.MANAGED_MARKETING_PAYMENT_FAILED, targetResourceId: requestId, targetUserId: payment.advertiserAccountId.toString(), reason: 'managed-marketing payment failed', metadata: { paymentId, provider: payment.provider, failureCode: outcome.failureCode } },
        session,
      );
      return done(EntryPaymentStatus.FAILED);
    }

    // Verified SUCCESS. The payment write comes first (concurrent confirmations collide on it).
    const confirmed = await this.payments
      .findOneAndUpdate(
        { _id: payment._id, status: EntryPaymentStatus.INITIATED },
        { $set: { status: EntryPaymentStatus.SUCCEEDED, confirmedAt: now, lastVerifiedAt: now, ...(outcome.providerEventId ? { providerEventId: outcome.providerEventId.slice(0, 200) } : {}) } },
        { new: true, session },
      )
      .lean().exec();
    if (!confirmed) throw new TransactionAttemptConflict('payment changed under a success confirmation');

    const paid = await this.requests
      .findOneAndUpdate(
        { _id: payment.requestId, status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: ManagedMarketingPaymentStatus.PENDING },
        { $set: { status: ManagedMarketingRequestStatus.PAID, paymentStatus: ManagedMarketingPaymentStatus.SUCCEEDED, paidAt: now, paidPaymentId: payment._id } },
        { new: true, session },
      )
      .lean().exec();
    if (!paid) {
      // Not the expected APPROVED/PENDING request: do not force it. Abort (payment stays INITIATED) for the operator.
      throw new InternalServerErrorException({ message: 'تعذر تأكيد الدفع', code: PaymentErrorCode.STATE_INCONSISTENT });
    }
    await this.audit.logSystemRequired(
      { action: AuditAction.MANAGED_MARKETING_PAYMENT_CONFIRMED, targetResourceId: requestId, targetUserId: payment.advertiserAccountId.toString(), reason: 'managed-marketing payment confirmed', metadata: { paymentId, provider: payment.provider, amountMinor: payment.amountMinor, currency: payment.currency, providerEventId: outcome.providerEventId } },
      session,
    );
    return done(EntryPaymentStatus.SUCCEEDED, { requestPaid: true });
  }

  /** Records the disagreement, parks the request for the operator (RECONCILIATION_REQUIRED), commits, then rejects. Grants nothing. */
  private async flag(session: ClientSession, payment: any, flag: PaymentReconciliationFlag, code: PaymentErrorCode, message: string, outcome: VerifiedProviderOutcome, now: Date): Promise<Outcome> {
    await this.payments.updateOne({ _id: payment._id, status: payment.status }, { $set: { reconciliationFlag: flag, lastVerifiedAt: now } }, { session }).exec();
    await this.requests
      .findOneAndUpdate(
        { _id: payment.requestId, status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: { $in: [ManagedMarketingPaymentStatus.PENDING, ManagedMarketingPaymentStatus.FAILED] } },
        { $set: { paymentStatus: ManagedMarketingPaymentStatus.RECONCILIATION_REQUIRED } },
        { new: true, session },
      )
      .lean().exec();
    await this.audit.logSystemRequired(
      {
        action: AuditAction.MANAGED_MARKETING_PAYMENT_REJECTED,
        targetResourceId: payment.requestId.toString(),
        targetUserId: payment.advertiserAccountId.toString(),
        reason: 'managed-marketing payment verification rejected',
        metadata: { paymentId: payment._id.toString(), flag, expectedAmountMinor: payment.amountMinor, expectedCurrency: payment.currency, reportedAmountMinor: outcome.amountMinor, reportedCurrency: outcome.currency, reportedStatus: outcome.status },
      },
      session,
    );
    return {
      result: { paymentId: payment._id.toString(), requestId: payment.requestId.toString(), status: payment.status, alreadyProcessed: false, pending: false, requestPaid: false },
      rejection: { code, message },
    };
  }
}
