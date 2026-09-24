import { ConflictException, Inject, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { Auction, AuctionDocument } from '../auctions/schemas/auction.schema';
import { AuctionStatus } from '../auctions/auction.types';
import { PaymentErrorCode } from '../common/errors/payment-error-codes';
import { EGP_CURRENCY } from '../common/money/money';
import { TransactionAttemptConflict, retryConflict, runTransactionWithRetry } from '../common/mongo/transaction-runner';
import { ClockService } from '../common/time/clock.service';
import { decideOutcome } from './payment-verification';
import { PAYMENT_UNIQUE_INDEXES } from './auction-entry-payment.service';
import { AUCTION_PAYMENT_PROVIDER_PORT, AuctionPaymentProviderPort } from './auction-payment-provider.port';
import { EntryPaymentStatus, PaymentReconciliationFlag, VerifiedProviderOutcome } from './payment.types';
import { AuctionBidEntitlement, AuctionBidEntitlementDocument } from './schemas/auction-bid-entitlement.schema';
import { AuctionEntryPayment, AuctionEntryPaymentDocument } from './schemas/auction-entry-payment.schema';

export type PaymentConfirmationResult = {
  paymentId: string;
  status: EntryPaymentStatus;
  /** True when this call did not change anything because the payment was already in that final state. */
  alreadyProcessed: boolean;
  /** True when the provider still reports the payment as pending (nothing changed). */
  pending: boolean;
  entitlementGranted: boolean;
};

type Outcome = { result: PaymentConfirmationResult; rejection?: { code: PaymentErrorCode; message: string } };

/**
 * The ONLY path from INITIATED to SUCCEEDED (MAZAD-028). Internal: no route.
 *
 * `confirm(paymentId)` takes no outcome from its caller. It asks the provider
 * port server-to-server what happened (so a webhook/callback is only a
 * trigger, and "the client says paid" cannot reach this code), then applies
 * the verified outcome in ONE transaction: payment status change + unique
 * entitlement + audit. It is idempotent and safe under concurrent duplicates:
 * both racers write the payment document, so one WriteConflicts and retries
 * into the "already SUCCEEDED" branch; the unique entitlement indexes are the
 * backstop.
 *
 * Late success: confirmation touches ONLY payment/entitlement/audit. It never
 * reads-then-writes the auction, never changes status or end time, never
 * creates a bid, and does not look at account eligibility. If the payment
 * genuinely succeeded after the auction ended, the truthful SUCCEEDED record and
 * the entitlement are kept (audited as `lateConfirmation`, for refund/
 * reconciliation) — the entitlement is inert because MAZAD-027 still requires
 * ACTIVE + before end + an eligible bidder on every bid.
 */
@Injectable()
export class AuctionPaymentConfirmationService {
  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<AuctionDocument>,
    @InjectModel(AuctionEntryPayment.name) private readonly payments: Model<AuctionEntryPaymentDocument>,
    @InjectModel(AuctionBidEntitlement.name) private readonly entitlements: Model<AuctionBidEntitlementDocument>,
    private readonly audit: AuditLogService,
    private readonly clock: ClockService,
    @Inject(AUCTION_PAYMENT_PROVIDER_PORT) private readonly provider: AuctionPaymentProviderPort,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async confirm(paymentId: string): Promise<PaymentConfirmationResult> {
    if (!Types.ObjectId.isValid(paymentId)) throw new NotFoundException({ message: 'عملية الدفع غير موجودة', code: PaymentErrorCode.NOT_FOUND });
    const payment: any = await this.payments.findById(paymentId).lean().exec();
    if (!payment) throw new NotFoundException({ message: 'عملية الدفع غير موجودة', code: PaymentErrorCode.NOT_FOUND });
    if (payment.status === EntryPaymentStatus.SUCCEEDED) return this.apply(paymentId, undefined); // idempotent replay: no provider call needed
    if (!payment.providerReference) {
      throw new ConflictException({ message: 'عملية الدفع لم تُفتح لدى مزود الدفع بعد', code: PaymentErrorCode.STATE_INCONSISTENT });
    }
    const outcome = await this.provider.verify(payment.providerReference); // server-to-server; adapter authenticates the gateway
    return this.apply(paymentId, outcome);
  }

  private async apply(paymentId: string, outcome: VerifiedProviderOutcome | undefined): Promise<PaymentConfirmationResult> {
    const { result, rejection } = await runTransactionWithRetry(
      this.connection,
      (session) => this.applyWithinTransaction(session, paymentId, outcome),
      { uniqueIndexNames: PAYMENT_UNIQUE_INDEXES, retryExhausted: retryConflict('تأكيد الدفع قيد المعالجة؛ أعد المحاولة', PaymentErrorCode.RETRY_EXHAUSTED) },
    );
    // The rejection audit/flag was committed above; only now is the caller told nothing was granted.
    if (rejection) throw new ConflictException({ message: rejection.message, code: rejection.code });
    return result;
  }

  private async applyWithinTransaction(session: ClientSession, paymentId: string, outcome: VerifiedProviderOutcome | undefined): Promise<Outcome> {
    const now = this.clock.now();
    const payment: any = await this.payments.findById(paymentId).session(session).lean().exec();
    if (!payment) throw new NotFoundException({ message: 'عملية الدفع غير موجودة', code: PaymentErrorCode.NOT_FOUND });
    const done = (status: EntryPaymentStatus, extra: Partial<PaymentConfirmationResult> = {}): Outcome => ({
      result: { paymentId, status, alreadyProcessed: false, pending: false, entitlementGranted: false, ...extra },
    });

    if (payment.status === EntryPaymentStatus.SUCCEEDED) {
      // Idempotent replay: return the authoritative result; heal a missing entitlement (never a second one).
      await this.ensureEntitlement(session, payment, now, false);
      return done(EntryPaymentStatus.SUCCEEDED, { alreadyProcessed: true, entitlementGranted: true });
    }
    if (!outcome) throw new TransactionAttemptConflict('payment state changed since the provider was asked');
    if (payment.status === EntryPaymentStatus.FAILED) {
      if (outcome.status !== 'SUCCEEDED') return done(EntryPaymentStatus.FAILED, { alreadyProcessed: true });
      return this.flag(session, payment, PaymentReconciliationFlag.CONFIRMED_AFTER_FAILURE, PaymentErrorCode.CONFIRMED_AFTER_FAILURE, 'تم تأكيد دفعة مسجلة كفاشلة وتحتاج مراجعة يدوية', outcome, now);
    }

    // payment is INITIATED. Verify the provider's answer against the SERVER-owned record (shared rules).
    const decision = decideOutcome(payment, outcome);
    if (decision.kind === 'MISMATCH') {
      const reference = decision.flag === PaymentReconciliationFlag.REFERENCE_MISMATCH;
      return this.flag(session, payment, decision.flag, PaymentErrorCode.VERIFICATION_MISMATCH,
        reference ? 'مرجع الدفع لا يطابق السجل' : decision.flag === PaymentReconciliationFlag.CURRENCY_MISMATCH ? 'عملة الدفع لا تطابق المبلغ المطلوب' : 'مبلغ الدفع لا يطابق المبلغ المطلوب', outcome, now);
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
      await this.audit.logSystemRequired(
        { action: AuditAction.AUCTION_ENTRY_PAYMENT_FAILED, targetResourceId: payment.auctionId.toString(), targetUserId: payment.bidderAccountId.toString(), reason: 'entry payment failed', metadata: { paymentId, provider: payment.provider, failureCode: outcome.failureCode } },
        session,
      );
      return done(EntryPaymentStatus.FAILED);
    }

    // Verified SUCCESS (reference, currency and amount all equal the server-owned snapshot).
    // The payment write comes FIRST: it is the document concurrent confirmations collide on.
    const confirmed = await this.payments
      .findOneAndUpdate(
        { _id: payment._id, status: EntryPaymentStatus.INITIATED },
        { $set: { status: EntryPaymentStatus.SUCCEEDED, confirmedAt: now, lastVerifiedAt: now, ...(outcome.providerEventId ? { providerEventId: outcome.providerEventId.slice(0, 200) } : {}) } },
        { new: true, session },
      )
      .lean().exec();
    if (!confirmed) throw new TransactionAttemptConflict('payment changed under a success confirmation');

    await this.ensureEntitlement(session, confirmed, now, true);

    // Read-only, for the audit trail: was this a late confirmation? The auction is never written here.
    const auction: any = await this.auctions.findById(payment.auctionId).session(session).select('status').lean().exec();
    const lateConfirmation = !auction || (auction.status !== AuctionStatus.SCHEDULED && auction.status !== AuctionStatus.ACTIVE);
    await this.audit.logSystemRequired(
      { action: AuditAction.AUCTION_ENTRY_PAYMENT_CONFIRMED, targetResourceId: payment.auctionId.toString(), targetUserId: payment.bidderAccountId.toString(), reason: 'entry payment confirmed', metadata: { paymentId, provider: payment.provider, amountMinor: payment.amountMinor, currency: payment.currency, providerEventId: outcome.providerEventId, lateConfirmation, auctionStatus: auction?.status } },
      session,
    );
    await this.audit.logSystemRequired(
      { action: AuditAction.AUCTION_BID_ENTITLEMENT_GRANTED, targetResourceId: payment.auctionId.toString(), targetUserId: payment.bidderAccountId.toString(), reason: 'bid entitlement granted', metadata: { paymentId, lateConfirmation } },
      session,
    );
    return done(EntryPaymentStatus.SUCCEEDED, { entitlementGranted: true });
  }

  /** Creates the unique entitlement if absent. An existing one must belong to this very payment. */
  private async ensureEntitlement(session: ClientSession, payment: any, now: Date, mustBeNew: boolean): Promise<boolean> {
    const existing: any = await this.entitlements.findOne({ auctionId: payment.auctionId, bidderAccountId: payment.bidderAccountId }).session(session).lean().exec();
    if (existing) {
      if (existing.paymentId.toString() !== payment._id.toString() || mustBeNew) {
        throw new InternalServerErrorException({ message: 'تعذر تأكيد الدفع', code: PaymentErrorCode.STATE_INCONSISTENT });
      }
      return false;
    }
    await this.entitlements.create(
      [{ auctionId: payment.auctionId, bidderAccountId: payment.bidderAccountId, paymentId: payment._id, amountMinor: payment.amountMinor, currency: EGP_CURRENCY, grantedAt: now }],
      { session },
    );
    return true;
  }

  /** Records the disagreement (flag + audit, committed) and returns a rejection; grants nothing. */
  private async flag(session: ClientSession, payment: any, flag: PaymentReconciliationFlag, code: PaymentErrorCode, message: string, outcome: VerifiedProviderOutcome, now: Date): Promise<Outcome> {
    await this.payments.updateOne({ _id: payment._id, status: payment.status }, { $set: { reconciliationFlag: flag, lastVerifiedAt: now } }, { session }).exec();
    await this.audit.logSystemRequired(
      {
        action: AuditAction.AUCTION_ENTRY_PAYMENT_REJECTED,
        targetResourceId: payment.auctionId.toString(),
        targetUserId: payment.bidderAccountId.toString(),
        reason: 'entry payment verification rejected',
        // Only the disagreeing scalars — never the raw provider payload.
        metadata: { paymentId: payment._id.toString(), flag, expectedAmountMinor: payment.amountMinor, expectedCurrency: payment.currency, reportedAmountMinor: outcome.amountMinor, reportedCurrency: outcome.currency, reportedStatus: outcome.status },
      },
      session,
    );
    return {
      result: { paymentId: payment._id.toString(), status: payment.status, alreadyProcessed: false, pending: false, entitlementGranted: false },
      rejection: { code, message },
    };
  }
}
