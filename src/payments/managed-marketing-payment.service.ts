import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';
import { Capability } from '../authorization/capability';
import { PaymentErrorCode } from '../common/errors/payment-error-codes';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../common/money/money';
import { retryConflict, runTransactionWithRetry } from '../common/mongo/transaction-runner';
import { ClockService } from '../common/time/clock.service';
import { ManagedMarketingPaymentStatus, ManagedMarketingRequestStatus } from '../managed-marketing/managed-marketing.types';
import { ManagedMarketingRequest, ManagedMarketingRequestDocument } from '../managed-marketing/schemas/managed-marketing-request.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { PAYMENT_PROVIDER_PORT, PaymentProviderPort } from './payment-provider.port';
import { INITIATION_CLAIM_LEASE_MS, openAttemptWithProvider } from './payment-attempt-opening';
import { EntryPaymentStatus, PaymentPurpose } from './payment.types';
import { ManagedMarketingPayment, ManagedMarketingPaymentDocument } from './schemas/managed-marketing-payment.schema';

export const MM_PAYMENT_UNIQUE_INDEXES = ['mm_payment_one_live_per_request', 'mm_payment_provider_reference'] as const;

export type InitiatedManagedMarketingPayment = {
  paymentId: string;
  requestId: string;
  amountMinor: number;
  currency: string;
  status: EntryPaymentStatus;
  providerReference?: string;
  clientHandoff?: string;
  reused: boolean;
};

/**
 * MANAGED_MARKETING payment INITIATION (MAZAD-028). Internal service; no route.
 *
 * Contract (MAZAD-020B lifecycle): only an Admin-APPROVED request
 * (`APPROVED` / `AWAITING_PAYMENT`, or `FAILED` for a retry) can be paid.
 * Initiation moves `paymentStatus` to `PENDING`, which the existing cancel
 * filter already refuses — so the customer can cancel only before payment
 * starts (and after a failed attempt), never once a payment is pending or
 * succeeded. The amount is the request's immutable package snapshot price.
 */
@Injectable()
export class ManagedMarketingPaymentService {
  constructor(
    @InjectModel(ManagedMarketingRequest.name) private readonly requests: Model<ManagedMarketingRequestDocument>,
    @InjectModel(ManagedMarketingPayment.name) private readonly payments: Model<ManagedMarketingPaymentDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditLogService,
    private readonly clock: ClockService,
    @Inject(PAYMENT_PROVIDER_PORT) private readonly provider: PaymentProviderPort,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /** `actorId` MUST be the authenticated principal; only the request's own advertiser may pay. No amount parameter exists. */
  async initiate(actorId: string, requestId: string, ip?: string): Promise<InitiatedManagedMarketingPayment> {
    if (!this.provider.configured) {
      throw new ServiceUnavailableException({ message: 'خدمة الدفع غير متاحة حالياً', code: PaymentErrorCode.PROVIDER_UNAVAILABLE });
    }
    if (!Types.ObjectId.isValid(requestId) || !Types.ObjectId.isValid(actorId)) {
      throw new NotFoundException({ message: 'طلب التسويق غير موجود', code: PaymentErrorCode.NOT_FOUND });
    }
    const { payment, reused } = await runTransactionWithRetry(
      this.connection,
      (session) => this.openAttempt(session, actorId, requestId, ip),
      { uniqueIndexNames: MM_PAYMENT_UNIQUE_INDEXES, retryExhausted: retryConflict('عملية الدفع قيد المعالجة؛ أعد المحاولة', PaymentErrorCode.RETRY_EXHAUSTED) },
    );
    // One provider order per attempt, and only a PERSISTED reference is ever returned (see `openAttemptWithProvider`).
    // Only a reference-less attempt may be failed on a provider error: one with a reference may already be paid at the gateway.
    const opened = await openAttemptWithProvider({
      payments: this.payments,
      provider: this.provider,
      purpose: PaymentPurpose.MANAGED_MARKETING,
      attempt: payment,
      reused,
      now: () => this.clock.now(),
      onProviderFailure: (paymentId) => this.failUnreferenced(paymentId, requestId),
    });
    return this.toResult(opened.payment, opened.reused);
  }

  private async openAttempt(session: ClientSession, actorId: string, requestId: string, ip?: string) {
    const request: any = await this.requests.findById(requestId).session(session).lean().exec();
    const actor = await this.users.findById(actorId).session(session).lean().exec();
    // IDOR: someone else's request is indistinguishable from a missing one.
    if (!request || !actor || request.advertiserAccountId.toString() !== actorId) {
      throw new NotFoundException({ message: 'طلب التسويق غير موجود', code: PaymentErrorCode.NOT_FOUND });
    }
    AuthorizationPolicyService.assert(actor, Capability.MANAGED_MARKETING_REQUEST);

    const snapshot = request.packageSnapshot;
    if (!snapshot || !isMoneyMinorAmount(snapshot.priceMinor, { positive: true }) || snapshot.currency !== EGP_CURRENCY) {
      throw new ConflictException({ message: 'سعر الباقة غير صالح', code: PaymentErrorCode.STATE_INCONSISTENT });
    }
    if (request.paymentStatus === ManagedMarketingPaymentStatus.SUCCEEDED) {
      throw new ConflictException({ message: 'تم دفع رسوم هذا الطلب مسبقاً', code: PaymentErrorCode.ALREADY_PAID });
    }
    if (request.paymentStatus === ManagedMarketingPaymentStatus.RECONCILIATION_REQUIRED) {
      throw new ConflictException({ message: 'الدفع قيد المراجعة اليدوية', code: PaymentErrorCode.RECONCILIATION_REQUIRED });
    }
    if (request.status !== ManagedMarketingRequestStatus.APPROVED) {
      throw new ConflictException({ message: 'الطلب غير مؤهل للدفع', code: PaymentErrorCode.REQUEST_NOT_PAYABLE });
    }
    if (request.paymentStatus === ManagedMarketingPaymentStatus.PENDING) {
      const live: any = await this.payments.findOne({ requestId: request._id, isLive: true }).session(session).lean().exec();
      if (!live) throw new ConflictException({ message: 'حالة الدفع غير متسقة', code: PaymentErrorCode.STATE_INCONSISTENT });
      return { payment: live, reused: true };
    }
    if (request.paymentStatus !== ManagedMarketingPaymentStatus.AWAITING_PAYMENT && request.paymentStatus !== ManagedMarketingPaymentStatus.FAILED) {
      throw new ConflictException({ message: 'الطلب غير مؤهل للدفع', code: PaymentErrorCode.REQUEST_NOT_PAYABLE });
    }

    // Write the request FIRST: it is the document concurrent initiations collide on.
    const moved = await this.requests
      .findOneAndUpdate(
        { _id: request._id, status: ManagedMarketingRequestStatus.APPROVED, paymentStatus: request.paymentStatus },
        { $set: { paymentStatus: ManagedMarketingPaymentStatus.PENDING } },
        { new: true, session },
      )
      .lean().exec();
    if (!moved) throw new ConflictException({ message: 'تغيرت حالة الطلب؛ أعد المحاولة', code: PaymentErrorCode.REQUEST_NOT_PAYABLE });

    const now = this.clock.now();
    const [created] = await this.payments.create(
      [{
        purpose: PaymentPurpose.MANAGED_MARKETING,
        requestId: request._id,
        advertiserAccountId: request.advertiserAccountId,
        amountMinor: snapshot.priceMinor,
        currency: EGP_CURRENCY,
        status: EntryPaymentStatus.INITIATED,
        isLive: true,
        initiatedAt: now,
        provider: this.provider.providerKey,
        // This request holds the right to open the attempt with the provider; the worker leaves it alone meanwhile.
        initiationClaimedAt: now,
        nextVerifyAt: new Date(now.getTime() + INITIATION_CLAIM_LEASE_MS),
        verifyAttempts: 0,
      }],
      { session },
    );
    await this.audit.logRequired(
      {
        action: AuditAction.MANAGED_MARKETING_PAYMENT_INITIATED,
        actorUserId: actorId,
        targetResourceId: requestId,
        reason: 'managed-marketing payment initiated',
        ip,
        metadata: { paymentId: created._id.toString(), amountMinor: snapshot.priceMinor, currency: EGP_CURRENCY, provider: this.provider.providerKey },
      },
      session,
    );
    return { payment: created.toObject() as any, reused: false };
  }

  /** Provider refused to open the attempt: fail it and return the request to a payable/cancellable state, atomically. */
  private async failUnreferenced(paymentId: Types.ObjectId, requestId: string) {
    try {
      await runTransactionWithRetry(
        this.connection,
        async (session) => {
          const failed = await this.payments
            .findOneAndUpdate(
              { _id: paymentId, status: EntryPaymentStatus.INITIATED, providerReference: { $exists: false } },
              { $set: { status: EntryPaymentStatus.FAILED, failedAt: this.clock.now(), failureCode: 'PROVIDER_INITIATION_FAILED' }, $unset: { isLive: '' } },
              { new: true, session },
            )
            .lean().exec();
          if (!failed) return;
          await this.requests
            .findOneAndUpdate(
              { _id: new Types.ObjectId(requestId), paymentStatus: ManagedMarketingPaymentStatus.PENDING },
              { $set: { paymentStatus: ManagedMarketingPaymentStatus.FAILED } },
              { new: true, session },
            )
            .lean().exec();
        },
        { uniqueIndexNames: MM_PAYMENT_UNIQUE_INDEXES, retryExhausted: retryConflict('', PaymentErrorCode.RETRY_EXHAUSTED) },
      );
    } catch {
      /* the original provider error is what matters; the attempt stays INITIATED/PENDING for reconciliation */
    }
  }

  private toResult(payment: any, reused: boolean): InitiatedManagedMarketingPayment {
    return {
      paymentId: payment._id.toString(),
      requestId: payment.requestId.toString(),
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      status: payment.status,
      providerReference: payment.providerReference,
      clientHandoff: payment.clientHandoff,
      reused,
    };
  }
}
