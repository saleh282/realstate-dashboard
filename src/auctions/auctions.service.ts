import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { EGP_CURRENCY } from '../common/money/money';
import { AccountType } from '../users/identity.types';
import { AuctionRuleSnapshotInput, buildAuctionRuleSnapshot } from './auction-rule-snapshot';
import { AuctionStatus } from './auction.types';
import { Auction, AuctionDocument } from './schemas/auction.schema';

export type CreateAuctionInput = AuctionRuleSnapshotInput & { propertyId: string };

/** Everything an Admin approval fixes for the auction it creates (MAZAD-035). */
export type ApprovedAuctionInput = AuctionRuleSnapshotInput & {
  auctionId: Types.ObjectId;
  propertyId: Types.ObjectId;
  propertyRevisionId: Types.ObjectId;
  advertiserAccountId: Types.ObjectId;
  advertiserAccountTypeSnapshot: AccountType;
  /** The seller who submitted the request (the auction's creator of record). */
  createdByActorId: Types.ObjectId;
  originRequestId: Types.ObjectId;
  originRequestRevision: number;
  approvedByActorId: Types.ObjectId;
  approvedAt: Date;
  /** Explicit, Admin-chosen entry fee; 0 = FREE. */
  entryFeeMinor: number;
};

/**
 * Auction creation. MAZAD-035 retired direct seller creation: an Auction now
 * exists only because an Admin approved an `AuctionRequest`, and it is born
 * SCHEDULED with its approved terms, frozen rule snapshot and explicit entry
 * fee (including 0 = FREE) all at once — nothing is configured afterwards.
 */
@Injectable()
export class AuctionsService {
  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<AuctionDocument>,
    private readonly audit: AuditLogService,
  ) {}

  /** `POST /auctions` compatibility: creating an auction without review is no longer possible. */
  rejectDirectCreation(): never {
    throw new ConflictException({
      message: 'إنشاء المزاد يتطلب مراجعة الإدارة؛ أرسل طلب مزاد عبر /auction-requests',
      code: AuctionErrorCode.REVIEW_REQUIRED,
    });
  }

  /**
   * Called ONLY from the Admin approval transaction, after every eligibility
   * re-check passed and after the request's own conditional write. The
   * `(originRequestId, originRequestRevision)` unique index is the backstop
   * against a duplicate auction for one approval.
   */
  async createApprovedWithinTransaction(session: ClientSession, input: ApprovedAuctionInput): Promise<AuctionDocument> {
    const ruleSnapshot = buildAuctionRuleSnapshot(input);
    const [created] = await this.auctions.create(
      [{
        _id: input.auctionId,
        propertyId: input.propertyId,
        propertyRevisionId: input.propertyRevisionId,
        advertiserAccountId: input.advertiserAccountId,
        advertiserAccountTypeSnapshot: input.advertiserAccountTypeSnapshot,
        createdByActorId: input.createdByActorId,
        startingPriceMinor: ruleSnapshot.startingPriceMinor,
        minimumBidStepMinor: ruleSnapshot.minimumBidStepMinor,
        currency: EGP_CURRENCY,
        scheduledStartAt: ruleSnapshot.scheduledStartAt,
        scheduledEndAt: ruleSnapshot.scheduledEndAt,
        currentEndAt: ruleSnapshot.scheduledEndAt,
        status: AuctionStatus.SCHEDULED,
        ruleSnapshot,
        entryFee: { amountMinor: input.entryFeeMinor, currency: EGP_CURRENCY, configuredByActorId: input.approvedByActorId, configuredAt: input.approvedAt },
        originRequestId: input.originRequestId,
        originRequestRevision: input.originRequestRevision,
        approvedByActorId: input.approvedByActorId,
        approvedAt: input.approvedAt,
      }],
      { session },
    );
    await this.audit.logRequired(
      {
        action: AuditAction.AUCTION_CREATED,
        actorUserId: input.approvedByActorId.toString(),
        targetResourceId: created._id.toString(),
        reason: 'auction created by approval',
        metadata: {
          originRequestId: input.originRequestId.toString(),
          originRequestRevision: input.originRequestRevision,
          propertyId: input.propertyId.toString(),
          propertyRevisionId: input.propertyRevisionId.toString(),
          startingPriceMinor: ruleSnapshot.startingPriceMinor,
          minimumBidStepMinor: ruleSnapshot.minimumBidStepMinor,
          entryFeeMinor: input.entryFeeMinor,
        },
      },
      session,
    );
    return created;
  }
}
