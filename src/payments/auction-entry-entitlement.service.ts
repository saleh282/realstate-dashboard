import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';
import { AuctionStatus } from '../auctions/auction.types';
import { AuctionsQueryService } from '../auctions/auctions-query.service';
import { PaymentErrorCode } from '../common/errors/payment-error-codes';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../common/money/money';
import { ClockService } from '../common/time/clock.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { AUCTION_PAYMENT_PROVIDER_PORT, AuctionPaymentProviderPort } from './auction-payment-provider.port';
import { EntryPaymentStatus } from './payment.types';
import { AuctionBidEntitlement, AuctionBidEntitlementDocument } from './schemas/auction-bid-entitlement.schema';
import { AuctionEntryPayment, AuctionEntryPaymentDocument } from './schemas/auction-entry-payment.schema';

/** The one vocabulary a client needs to decide what to show (MAZAD-034A). */
export enum EntryEntitlementState {
  /** The auction has no admin-configured fee. Fail-closed: this is NOT "free", and no bid can be accepted. */
  FEE_NOT_CONFIGURED = 'FEE_NOT_CONFIGURED',
  /**
   * MAZAD-035: the Admin explicitly configured a 0 fee (FREE auction). No payment exists or is needed; the
   * bidder still has to pass every bidding policy check (`blockedReason` reports the first failing one).
   */
  FREE_ENTRY = 'FREE_ENTRY',
  /** A fee is configured and this account has neither paid nor started paying. */
  PAYMENT_REQUIRED = 'PAYMENT_REQUIRED',
  /** An attempt was opened and the server has not confirmed it (initiated / pending at the provider). */
  PAYMENT_PENDING = 'PAYMENT_PENDING',
  /**
   * The latest attempt definitively ended without a payment — it FAILED, or it EXPIRED locally — and a new attempt may
   * be started. One wire state on purpose (older app builds reject unknown states); `payment.status` tells which.
   */
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  /** Server-side verification disagreed with the payment; an operator must reconcile. No new attempt is accepted. */
  RECONCILIATION_REQUIRED = 'RECONCILIATION_REQUIRED',
  /** A server-confirmed entitlement exists for this account and auction. */
  ENTITLED = 'ENTITLED',
}

const PAYABLE_STATUSES: readonly string[] = [AuctionStatus.SCHEDULED, AuctionStatus.ACTIVE];

/**
 * Read side of the entry-payment flow (MAZAD-034A): the authenticated actor's
 * OWN entitlement and payment state for one auction. The auction must pass the public visibility gate; every query is scoped to
 * `(auctionId, actorId)`; there is no way to name another account. It never
 * writes, never contacts the provider and exposes no provider reference,
 * failure detail, reconciliation flag name or audit data.
 */
@Injectable()
export class AuctionEntryEntitlementService {
  constructor(
    private readonly queries: AuctionsQueryService,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(AuctionEntryPayment.name) private readonly payments: Model<AuctionEntryPaymentDocument>,
    @InjectModel(AuctionBidEntitlement.name) private readonly entitlements: Model<AuctionBidEntitlementDocument>,
    private readonly clock: ClockService,
    @Inject(AUCTION_PAYMENT_PROVIDER_PORT) private readonly provider: AuctionPaymentProviderPort,
  ) {}

  async getStatus(actorId: string, auctionId: string) {
    if (!Types.ObjectId.isValid(actorId)) throw new NotFoundException({ message: 'الحساب غير موجود', code: AuctionErrorCode.ACTOR_INVALID });
    const bidder = new Types.ObjectId(actorId);
    // The SAME gate as GET /auctions/:id (status AND the anchored public property projection): nothing is
    // revealed here about an auction whose public contract is unavailable.
    const { doc: auction } = (await this.queries.getPubliclyVisible(auctionId)) as { doc: any };
    const actor: any = await this.users.findById(actorId).lean().exec();
    if (!actor) throw new NotFoundException({ message: 'الحساب غير موجود', code: AuctionErrorCode.ACTOR_INVALID });

    const scope = { auctionId: auction._id, bidderAccountId: bidder };
    const entitlement: any = await this.entitlements.findOne(scope).lean().exec();
    const live: any = await this.payments.findOne({ ...scope, isLive: true }).lean().exec();
    const latest: any = live ?? (await this.payments.findOne(scope).sort({ createdAt: -1 }).lean().exec());
    const flagged = await this.payments.findOne({ ...scope, reconciliationFlag: { $exists: true } }).lean().exec();

    const fee = auction.entryFee;
    // MAZAD-035: 0 is a configured (FREE) fee; only an absent/invalid fee is "not configured".
    const feeConfigured = Boolean(fee) && isMoneyMinorAmount(fee.amountMinor) && fee.currency === EGP_CURRENCY;
    const free = feeConfigured && fee.amountMinor === 0;
    const entitled = Boolean(entitlement);
    const now = this.clock.now();

    let state: EntryEntitlementState;
    if (entitled) state = EntryEntitlementState.ENTITLED;
    else if (flagged) state = EntryEntitlementState.RECONCILIATION_REQUIRED;
    else if (live && live.status === EntryPaymentStatus.INITIATED) state = EntryEntitlementState.PAYMENT_PENDING;
    else if (latest && (latest.status === EntryPaymentStatus.FAILED || latest.status === EntryPaymentStatus.EXPIRED)) state = EntryEntitlementState.PAYMENT_FAILED;
    else if (!feeConfigured) state = EntryEntitlementState.FEE_NOT_CONFIGURED;
    else if (free) state = EntryEntitlementState.FREE_ENTRY;
    else state = EntryEntitlementState.PAYMENT_REQUIRED;

    const blockedReason = this.blockedReason({ actor, auction, entitled, feeConfigured, free, flagged: Boolean(flagged), now });
    return {
      auctionId: auction._id.toString(),
      auctionStatus: auction.status,
      state,
      entryFee: feeConfigured ? { configured: true, free, amountMinor: fee.amountMinor, currency: fee.currency } : { configured: false, free: false },
      /** MAZAD-035: false for a FREE auction (and when no fee is configured, which fails closed instead). */
      paymentRequired: feeConfigured && !free,
      /**
       * MAZAD-035 guidance for a FREE auction: every bidding policy check passed (the bid itself still re-checks
       * everything, including ACTIVE status and time). Always false for paid auctions — they use `entitled`.
       */
      freeBiddingEligible: free && blockedReason === PaymentErrorCode.NOT_REQUIRED,
      entitled,
      entitledAt: entitled ? entitlement.grantedAt : null,
      payment: latest
        ? {
            paymentId: latest._id.toString(),
            status: latest.status,
            amountMinor: latest.amountMinor,
            currency: latest.currency,
            initiatedAt: latest.initiatedAt,
            confirmedAt: latest.confirmedAt ?? null,
            failedAt: latest.failedAt ?? null,
            expiredAt: latest.expiredAt ?? null,
            requiresReconciliation: Boolean(flagged),
          }
        : null,
      /** Guidance only: initiation re-checks everything. `blockedReason` is a stable PaymentErrorCode / authorization code, or null. */
      canInitiate: blockedReason === null,
      blockedReason,
      /** False while no payment gateway is bound (production default): initiation then answers 503. */
      paymentProviderAvailable: this.provider.configured,
      serverTime: now,
    };
  }

  private blockedReason(input: { actor: any; auction: any; entitled: boolean; feeConfigured: boolean; free: boolean; flagged: boolean; now: Date }): string | null {
    if (input.entitled) return PaymentErrorCode.ALREADY_PAID;
    try {
      AuthorizationPolicyService.assertBid(input.actor, input.auction.advertiserAccountId.toString());
    } catch (error) {
      const code = (error as any)?.getResponse?.()?.code;
      return typeof code === 'string' ? code : 'FORBIDDEN';
    }
    const open = PAYABLE_STATUSES.includes(input.auction.status)
      && !(input.auction.status === AuctionStatus.ACTIVE && input.auction.currentEndAt && input.now.getTime() >= new Date(input.auction.currentEndAt).getTime());
    if (!open) return PaymentErrorCode.AUCTION_NOT_PAYABLE;
    if (!input.feeConfigured) return PaymentErrorCode.ENTRY_FEE_NOT_CONFIGURED;
    // A FREE auction has nothing to initiate: the bidder passed every policy check above.
    if (input.free) return PaymentErrorCode.NOT_REQUIRED;
    if (input.flagged) return PaymentErrorCode.RECONCILIATION_REQUIRED;
    return null;
  }
}
