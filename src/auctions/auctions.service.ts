import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';
import { Capability } from '../authorization/capability';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { EGP_CURRENCY } from '../common/money/money';
import { PropertiesService } from '../properties/properties.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { AuctionRuleSnapshotInput, buildAuctionRuleSnapshot } from './auction-rule-snapshot';
import { AuctionStatus } from './auction.types';
import { Auction, AuctionDocument } from './schemas/auction.schema';

export type CreateAuctionInput = AuctionRuleSnapshotInput & { propertyId: string };

/**
 * MAZAD-023 foundation service. Only auction *creation* is implemented —
 * enough to exercise the schema, the immutable rule snapshot, the property
 * attribution anchor, and the authorization foundation
 * (`AUCTION_CREATE_OWN` / `assertOwnResource`, both seeded in earlier
 * tasks specifically for this). Bid acceptance, anti-sniping extension,
 * scheduling/closing workers, cancellation and winner selection are later
 * tasks (MAZAD-024+) and are deliberately not implemented here. There is
 * also no controller yet — this is consumed directly (e.g. by tests, and by
 * whatever later task adds the HTTP layer).
 */
@Injectable()
export class AuctionsService {
  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<AuctionDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly properties: PropertiesService,
    private readonly audit: AuditLogService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /** Self-service only: the authenticated actor creates an auction for their own eligible property. */
  async create(actorId: string, input: CreateAuctionInput, ip?: string) {
    if (!Types.ObjectId.isValid(input.propertyId)) {
      throw new NotFoundException({ message: 'العقار غير موجود أو غير مؤهل لإنشاء مزاد عليه', code: AuctionErrorCode.PROPERTY_NOT_ELIGIBLE });
    }
    const [actor, anchor] = await Promise.all([
      this.users.findById(actorId).lean().exec(),
      this.properties.getEligibleForAuctionAnchor(input.propertyId),
    ]);
    if (!actor) throw new NotFoundException({ message: 'الحساب غير موجود', code: AuctionErrorCode.ACTOR_INVALID });
    if (!anchor) throw new NotFoundException({ message: 'العقار غير موجود أو غير مؤهل لإنشاء مزاد عليه', code: AuctionErrorCode.PROPERTY_NOT_ELIGIBLE });

    // Reuses the existing authorization foundation rather than inventing a
    // second one: AUCTION_CREATE_OWN follows the same marketplace/broker
    // eligibility rules as PROPERTY_CREATE, and assertOwnResource is the
    // same own-resource/IDOR boundary every other "my resource" action uses.
    AuthorizationPolicyService.assert(actor, Capability.AUCTION_CREATE_OWN);
    AuthorizationPolicyService.assertOwnResource(actor, anchor.advertiserAccountId.toString());

    const ruleSnapshot = buildAuctionRuleSnapshot(input);

    const session = await this.connection.startSession();
    try {
      let created!: AuctionDocument;
      await session.withTransaction(async () => {
        [created] = await this.auctions.create(
          [{
            propertyId: anchor.propertyId,
            propertyRevisionId: anchor.currentPublicRevisionId,
            advertiserAccountId: anchor.advertiserAccountId,
            advertiserAccountTypeSnapshot: anchor.advertiserAccountTypeSnapshot,
            createdByActorId: new Types.ObjectId(actorId),
            startingPriceMinor: ruleSnapshot.startingPriceMinor,
            minimumBidStepMinor: ruleSnapshot.minimumBidStepMinor,
            currency: EGP_CURRENCY,
            scheduledStartAt: ruleSnapshot.scheduledStartAt,
            scheduledEndAt: ruleSnapshot.scheduledEndAt,
            currentEndAt: ruleSnapshot.scheduledEndAt,
            status: AuctionStatus.SCHEDULED,
            ruleSnapshot,
          }],
          { session },
        );
        await this.audit.logRequired(
          {
            action: AuditAction.AUCTION_CREATED,
            actorUserId: actorId,
            targetResourceId: created._id.toString(),
            reason: 'auction created',
            ip,
            metadata: {
              propertyId: anchor.propertyId.toString(),
              propertyRevisionId: anchor.currentPublicRevisionId.toString(),
              startingPriceMinor: ruleSnapshot.startingPriceMinor,
              minimumBidStepMinor: ruleSnapshot.minimumBidStepMinor,
            },
          },
          session,
        );
      });
      return { message: 'تم إنشاء المزاد بنجاح', auction: this.toSummary(created.toObject()) };
    } finally {
      await session.endSession();
    }
  }

  private toSummary(item: any) {
    return {
      id: item._id.toString(),
      propertyId: item.propertyId.toString(),
      propertyRevisionId: item.propertyRevisionId.toString(),
      advertiserAccountId: item.advertiserAccountId.toString(),
      advertiserAccountTypeSnapshot: item.advertiserAccountTypeSnapshot,
      status: item.status,
      startingPriceMinor: item.startingPriceMinor,
      minimumBidStepMinor: item.minimumBidStepMinor,
      currency: item.currency,
      scheduledStartAt: item.scheduledStartAt,
      scheduledEndAt: item.scheduledEndAt,
      currentEndAt: item.currentEndAt,
      ruleSnapshotVersion: item.ruleSnapshot?.version,
      createdAt: item.createdAt,
    };
  }
}
