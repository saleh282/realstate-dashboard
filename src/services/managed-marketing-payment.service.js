'use strict';

const {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} = require('../common/http/errors');
const { Types } = require('mongoose');
const { AuditAction } = require('../models/audit-log.model');
const { AuthorizationPolicyService } = require('./authorization-policy.service');
const { Capability } = require('../domain/authorization/capability');
const { PaymentErrorCode } = require('../common/errors/payment-error-codes');
const { EGP_CURRENCY, isMoneyMinorAmount } = require('../common/money/money');
const { retryConflict, runTransactionWithRetry } = require('../common/mongo/transaction-runner');
const {
  ManagedMarketingPaymentStatus,
  ManagedMarketingRequestStatus,
} = require('../domain/managed-marketing/managed-marketing.types');
const {
  INITIATION_CLAIM_LEASE_MS,
  openAttemptWithProvider,
} = require('../domain/payments/payment-attempt-opening');
const { EntryPaymentStatus, PaymentPurpose } = require('../domain/payments/payment.types');
const MM_PAYMENT_UNIQUE_INDEXES = [
  'mm_payment_one_live_per_request',
  'mm_payment_provider_reference',
];
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
class ManagedMarketingPaymentService {
  constructor(requests, payments, users, audit, clock, provider, connection) {
    this.requests = requests;
    this.payments = payments;
    this.users = users;
    this.audit = audit;
    this.clock = clock;
    this.provider = provider;
    this.connection = connection;
  }
  /** `actorId` MUST be the authenticated principal; only the request's own advertiser may pay. No amount parameter exists. */
  async initiate(actorId, requestId, ip) {
    if (!this.provider.configured) {
      throw new ServiceUnavailableException({
        message: 'خدمة الدفع غير متاحة حالياً',
        code: PaymentErrorCode.PROVIDER_UNAVAILABLE,
      });
    }
    if (!Types.ObjectId.isValid(requestId) || !Types.ObjectId.isValid(actorId)) {
      throw new NotFoundException({
        message: 'طلب التسويق غير موجود',
        code: PaymentErrorCode.NOT_FOUND,
      });
    }
    const { payment, reused } = await runTransactionWithRetry(
      this.connection,
      (session) => this.openAttempt(session, actorId, requestId, ip),
      {
        uniqueIndexNames: MM_PAYMENT_UNIQUE_INDEXES,
        retryExhausted: retryConflict(
          'عملية الدفع قيد المعالجة؛ أعد المحاولة',
          PaymentErrorCode.RETRY_EXHAUSTED,
        ),
      },
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
  async openAttempt(session, actorId, requestId, ip) {
    const request = await this.requests.findById(requestId).session(session).lean().exec();
    const actor = await this.users.findById(actorId).session(session).lean().exec();
    // IDOR: someone else's request is indistinguishable from a missing one.
    if (!request || !actor || request.advertiserAccountId.toString() !== actorId) {
      throw new NotFoundException({
        message: 'طلب التسويق غير موجود',
        code: PaymentErrorCode.NOT_FOUND,
      });
    }
    AuthorizationPolicyService.assert(actor, Capability.MANAGED_MARKETING_REQUEST);
    const snapshot = request.packageSnapshot;
    if (
      !snapshot ||
      !isMoneyMinorAmount(snapshot.priceMinor, { positive: true }) ||
      snapshot.currency !== EGP_CURRENCY
    ) {
      throw new ConflictException({
        message: 'سعر الباقة غير صالح',
        code: PaymentErrorCode.STATE_INCONSISTENT,
      });
    }
    if (request.paymentStatus === ManagedMarketingPaymentStatus.SUCCEEDED) {
      throw new ConflictException({
        message: 'تم دفع رسوم هذا الطلب مسبقاً',
        code: PaymentErrorCode.ALREADY_PAID,
      });
    }
    if (request.paymentStatus === ManagedMarketingPaymentStatus.RECONCILIATION_REQUIRED) {
      throw new ConflictException({
        message: 'الدفع قيد المراجعة اليدوية',
        code: PaymentErrorCode.RECONCILIATION_REQUIRED,
      });
    }
    if (request.status !== ManagedMarketingRequestStatus.APPROVED) {
      throw new ConflictException({
        message: 'الطلب غير مؤهل للدفع',
        code: PaymentErrorCode.REQUEST_NOT_PAYABLE,
      });
    }
    if (request.paymentStatus === ManagedMarketingPaymentStatus.PENDING) {
      const live = await this.payments
        .findOne({ requestId: request._id, isLive: true })
        .session(session)
        .lean()
        .exec();
      if (!live)
        throw new ConflictException({
          message: 'حالة الدفع غير متسقة',
          code: PaymentErrorCode.STATE_INCONSISTENT,
        });
      return { payment: live, reused: true };
    }
    if (
      request.paymentStatus !== ManagedMarketingPaymentStatus.AWAITING_PAYMENT &&
      request.paymentStatus !== ManagedMarketingPaymentStatus.FAILED
    ) {
      throw new ConflictException({
        message: 'الطلب غير مؤهل للدفع',
        code: PaymentErrorCode.REQUEST_NOT_PAYABLE,
      });
    }
    // Write the request FIRST: it is the document concurrent initiations collide on.
    const moved = await this.requests
      .findOneAndUpdate(
        {
          _id: request._id,
          status: ManagedMarketingRequestStatus.APPROVED,
          paymentStatus: request.paymentStatus,
        },
        { $set: { paymentStatus: ManagedMarketingPaymentStatus.PENDING } },
        { new: true, session },
      )
      .lean()
      .exec();
    if (!moved)
      throw new ConflictException({
        message: 'تغيرت حالة الطلب؛ أعد المحاولة',
        code: PaymentErrorCode.REQUEST_NOT_PAYABLE,
      });
    const now = this.clock.now();
    const [created] = await this.payments.create(
      [
        {
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
        },
      ],
      { session },
    );
    await this.audit.logRequired(
      {
        action: AuditAction.MANAGED_MARKETING_PAYMENT_INITIATED,
        actorUserId: actorId,
        targetResourceId: requestId,
        reason: 'managed-marketing payment initiated',
        ip,
        metadata: {
          paymentId: created._id.toString(),
          amountMinor: snapshot.priceMinor,
          currency: EGP_CURRENCY,
          provider: this.provider.providerKey,
        },
      },
      session,
    );
    return { payment: created.toObject(), reused: false };
  }
  /** Provider refused to open the attempt: fail it and return the request to a payable/cancellable state, atomically. */
  async failUnreferenced(paymentId, requestId) {
    try {
      await runTransactionWithRetry(
        this.connection,
        async (session) => {
          const failed = await this.payments
            .findOneAndUpdate(
              {
                _id: paymentId,
                status: EntryPaymentStatus.INITIATED,
                providerReference: { $exists: false },
              },
              {
                $set: {
                  status: EntryPaymentStatus.FAILED,
                  failedAt: this.clock.now(),
                  failureCode: 'PROVIDER_INITIATION_FAILED',
                },
                $unset: { isLive: '' },
              },
              { new: true, session },
            )
            .lean()
            .exec();
          if (!failed) return;
          await this.requests
            .findOneAndUpdate(
              {
                _id: new Types.ObjectId(requestId),
                paymentStatus: ManagedMarketingPaymentStatus.PENDING,
              },
              { $set: { paymentStatus: ManagedMarketingPaymentStatus.FAILED } },
              { new: true, session },
            )
            .lean()
            .exec();
        },
        {
          uniqueIndexNames: MM_PAYMENT_UNIQUE_INDEXES,
          retryExhausted: retryConflict('', PaymentErrorCode.RETRY_EXHAUSTED),
        },
      );
    } catch {
      /* the original provider error is what matters; the attempt stays INITIATED/PENDING for reconciliation */
    }
  }
  toResult(payment, reused) {
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

Object.assign(exports, { MM_PAYMENT_UNIQUE_INDEXES, ManagedMarketingPaymentService });
