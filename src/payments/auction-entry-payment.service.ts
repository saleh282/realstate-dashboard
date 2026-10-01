import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';
import { Capability } from '../authorization/capability';
import { AuctionStatus } from '../auctions/auction.types';
import { Auction, AuctionDocument } from '../auctions/schemas/auction.schema';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { PaymentErrorCode } from '../common/errors/payment-error-codes';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../common/money/money';
import { retryConflict, runTransactionWithRetry } from '../common/mongo/transaction-runner';
import { ClockService } from '../common/time/clock.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { AUCTION_PAYMENT_PROVIDER_PORT, AuctionPaymentProviderPort } from './auction-payment-provider.port';
import { INITIATION_CLAIM_LEASE_MS, openAttemptWithProvider } from './payment-attempt-opening';
import { EntryPaymentStatus, PaymentPurpose } from './payment.types';
import { AuctionBidEntitlement, AuctionBidEntitlementDocument } from './schemas/auction-bid-entitlement.schema';
import { AuctionEntryPayment, AuctionEntryPaymentDocument } from './schemas/auction-entry-payment.schema';

export const PAYMENT_UNIQUE_INDEXES = ['entry_payment_one_live_per_bidder_auction', 'entry_payment_provider_reference', 'entitlement_auction_bidder', 'entitlement_payment'] as const;

export type InitiatedEntryPayment = {
  paymentId: string;
  auctionId: string;
  amountMinor: number;
  currency: string;
  status: EntryPaymentStatus;
  providerReference?: string;
  clientHandoff?: string;
  /** True when an existing INITIATED attempt was returned instead of opening a new one. */
  reused: boolean;
};

/**
 * Payment INITIATION (MAZAD-028), exposed over HTTP by MAZAD-034A's controller.
 * Initiating grants nothing — only server-verified confirmation does. The
 * amount is copied from the auction's configured fee, never from the caller.
 */
@Injectable()
export class AuctionEntryPaymentService {
  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<AuctionDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(AuctionEntryPayment.name) private readonly payments: Model<AuctionEntryPaymentDocument>,
    @InjectModel(AuctionBidEntitlement.name) private readonly entitlements: Model<AuctionBidEntitlementDocument>,
    private readonly audit: AuditLogService,
    private readonly clock: ClockService,
    @Inject(AUCTION_PAYMENT_PROVIDER_PORT) private readonly provider: AuctionPaymentProviderPort,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /** `actorId` MUST be the authenticated principal's id; there is deliberately no amount parameter. */
  async initiate(actorId: string, auctionId: string, ip?: string): Promise<InitiatedEntryPayment> {
    if (!Types.ObjectId.isValid(auctionId)) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    if (!Types.ObjectId.isValid(actorId)) throw new NotFoundException({ message: 'الحساب غير موجود', code: AuctionErrorCode.ACTOR_INVALID });

    const { payment, reused } = await runTransactionWithRetry(
      this.connection,
      (session) => this.openAttempt(session, actorId, auctionId, ip),
      { uniqueIndexNames: PAYMENT_UNIQUE_INDEXES, retryExhausted: retryConflict('عملية الدفع قيد المعالجة؛ أعد المحاولة', PaymentErrorCode.RETRY_EXHAUSTED) },
    );

    // One provider order per attempt, and only a PERSISTED reference is ever returned (see `openAttemptWithProvider`).
    // Only a reference-less attempt may be failed on a provider error: one that has a reference may be paid at the gateway.
    const opened = await openAttemptWithProvider({
      payments: this.payments,
      provider: this.provider,
      purpose: PaymentPurpose.AUCTION_ENTRY,
      attempt: payment,
      reused,
      now: () => this.clock.now(),
      onProviderFailure: (paymentId) => this.failUnreferenced(paymentId),
    });
    return this.toResult(opened.payment, opened.reused);
  }

  private async openAttempt(session: ClientSession, actorId: string, auctionId: string, ip?: string) {
    const auction: any = await this.auctions.findById(auctionId).session(session).lean().exec();
    const actor = await this.users.findById(actorId).session(session).lean().exec();
    if (!auction) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    if (!actor) throw new NotFoundException({ message: 'الحساب غير موجود', code: AuctionErrorCode.ACTOR_INVALID });

    // Payment never replaces bidding authorization: a principal who could never bid has nothing to buy.
    AuthorizationPolicyService.assert(actor, Capability.PAYMENT_ENTRY_INITIATE);
    AuthorizationPolicyService.assertBid(actor, auction.advertiserAccountId.toString());

    if (auction.status !== AuctionStatus.SCHEDULED && auction.status !== AuctionStatus.ACTIVE) {
      throw new ConflictException({ message: 'لا يمكن دفع رسوم الاشتراك لهذا المزاد', code: PaymentErrorCode.AUCTION_NOT_PAYABLE });
    }
    const openNow = this.clock.now();
    if (auction.status === AuctionStatus.ACTIVE && auction.currentEndAt && openNow.getTime() >= new Date(auction.currentEndAt).getTime()) {
      throw new ConflictException({ message: 'لا يمكن دفع رسوم الاشتراك لهذا المزاد', code: PaymentErrorCode.AUCTION_NOT_PAYABLE });
    }
    const fee = auction.entryFee;
    if (!fee || !isMoneyMinorAmount(fee.amountMinor) || fee.currency !== EGP_CURRENCY) {
      throw new ConflictException({ message: 'لم يتم تحديد رسوم الاشتراك لهذا المزاد', code: PaymentErrorCode.ENTRY_FEE_NOT_CONFIGURED });
    }
    // MAZAD-035: a FREE auction (explicit 0 fee) never creates a payment record, real or fabricated.
    if (fee.amountMinor === 0) {
      throw new ConflictException({ message: 'هذا المزاد مجاني ولا يتطلب دفع رسوم اشتراك', code: PaymentErrorCode.NOT_REQUIRED });
    }

    const entitled = await this.entitlements.exists({ auctionId: auction._id, bidderAccountId: new Types.ObjectId(actorId) }).session(session).exec();
    const live = await this.payments.findOne({ auctionId: auction._id, bidderAccountId: new Types.ObjectId(actorId), isLive: true }).session(session).lean().exec();
    if (entitled || live?.status === EntryPaymentStatus.SUCCEEDED) {
      throw new ConflictException({ message: 'تم دفع رسوم الاشتراك لهذا المزاد مسبقاً', code: PaymentErrorCode.ALREADY_PAID });
    }
    // MAZAD-034A: a payment the server flagged (verification mismatch, success after failure) must be reconciled by an
    // operator first; opening another attempt could charge the bidder twice.
    const flagged = await this.payments.exists({ auctionId: auction._id, bidderAccountId: new Types.ObjectId(actorId), reconciliationFlag: { $exists: true } }).session(session).exec();
    if (flagged) {
      throw new ConflictException({ message: 'الدفعة قيد المراجعة اليدوية', code: PaymentErrorCode.RECONCILIATION_REQUIRED });
    }
    if (live) {
      // An attempt that already has its gateway reference is returned as it is (no provider call is needed).
      if (!live.providerReference) this.assertProviderAvailable();
      return { payment: live as any, reused: true };
    }
    // Every eligibility/state check above passed: only now does a NEW provider operation matter. Fail closed
    // BEFORE writing anything, so an unavailable gateway never leaves an attempt row behind.
    this.assertProviderAvailable();

    const now = this.clock.now();
    // MAZAD-035: write the Auction document (the aggregate's serialisation point) so this attempt conflicts with a
    // concurrent cancellation or pre-start revision instead of slipping past their "no payments exist" checks.
    const guarded = await this.auctions
      .updateOne(
        { _id: auction._id, status: { $in: [AuctionStatus.SCHEDULED, AuctionStatus.ACTIVE] } },
        { $inc: { entryPaymentAttemptCount: 1 } },
        { session },
      )
      .exec();
    if (!guarded.matchedCount) {
      throw new ConflictException({ message: 'لا يمكن دفع رسوم الاشتراك لهذا المزاد', code: PaymentErrorCode.AUCTION_NOT_PAYABLE });
    }
    const [created] = await this.payments.create(
      [{
        auctionId: auction._id,
        bidderAccountId: new Types.ObjectId(actorId),
        amountMinor: fee.amountMinor,
        currency: EGP_CURRENCY,
        status: EntryPaymentStatus.INITIATED,
        isLive: true,
        initiatedAt: now,
        provider: this.provider.providerKey,
        purpose: PaymentPurpose.AUCTION_ENTRY,
        // This request holds the right to open the attempt with the provider; the worker leaves it alone meanwhile.
        initiationClaimedAt: now,
        nextVerifyAt: new Date(now.getTime() + INITIATION_CLAIM_LEASE_MS),
        verifyAttempts: 0,
      }],
      { session },
    );
    await this.audit.logRequired(
      {
        action: AuditAction.AUCTION_ENTRY_PAYMENT_INITIATED,
        actorUserId: actorId,
        targetResourceId: auctionId,
        reason: 'entry payment initiated',
        ip,
        metadata: { paymentId: created._id.toString(), amountMinor: fee.amountMinor, currency: EGP_CURRENCY, provider: this.provider.providerKey },
      },
      session,
    );
    return { payment: created.toObject() as any, reused: false };
  }

  private assertProviderAvailable(): void {
    if (!this.provider.configured) {
      throw new ServiceUnavailableException({ message: 'خدمة الدفع غير متاحة حالياً', code: PaymentErrorCode.PROVIDER_UNAVAILABLE });
    }
  }

  private async failUnreferenced(paymentId: Types.ObjectId) {
    try {
      await this.payments
        .updateOne(
          { _id: paymentId, status: EntryPaymentStatus.INITIATED, providerReference: { $exists: false } },
          { $set: { status: EntryPaymentStatus.FAILED, failedAt: this.clock.now(), failureCode: 'PROVIDER_INITIATION_FAILED' }, $unset: { isLive: '' } },
        )
        .exec();
    } catch {
      /* the original provider error is what matters; the attempt stays INITIATED for reconciliation */
    }
  }

  private toResult(payment: any, reused: boolean): InitiatedEntryPayment {
    return {
      paymentId: payment._id.toString(),
      auctionId: payment.auctionId.toString(),
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      status: payment.status,
      providerReference: payment.providerReference,
      // The stored hand-off of THIS live attempt (presentation only; never proof of payment).
      clientHandoff: payment.clientHandoff,
      reused,
    };
  }
}
