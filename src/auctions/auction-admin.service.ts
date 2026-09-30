import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';
import { Capability } from '../authorization/capability';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { ClockService } from '../common/time/clock.service';
import { BidLedgerService } from '../bids/bid-ledger.service';
import { PropertiesService } from '../properties/properties.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { toAdminAuction } from './auction-projections';
import { AuctionParticipantsReader } from './auction-participants.reader';
import { AuctionRequest, AuctionRequestDocument } from './schemas/auction-request.schema';
import { Auction, AuctionDocument } from './schemas/auction.schema';

function assertId(id: string) {
  if (typeof id !== 'string' || !Types.ObjectId.isValid(id)) {
    throw new BadRequestException({ message: 'معرّف المزاد غير صالح', code: AuctionErrorCode.ID_INVALID });
  }
}

/**
 * MAZAD-035 Admin auction operations (read side): the operational projection
 * with fee, bidding, payment and entitlement summaries, seller/property
 * context and the originating request, plus the staff bid ledger. Read-only:
 * staff can never alter a bid or choose a winner (DEC-AUCTION-006).
 */
@Injectable()
export class AuctionAdminService {
  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<AuctionDocument>,
    @InjectModel(AuctionRequest.name) private readonly requests: Model<AuctionRequestDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly properties: PropertiesService,
    private readonly participants: AuctionParticipantsReader,
    private readonly ledger: BidLedgerService,
    private readonly clock: ClockService,
  ) {}

  async getDetail(auctionId: string) {
    assertId(auctionId);
    const doc: any = await this.auctions.findById(auctionId).lean().exec();
    if (!doc) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    const [highest, bidCount, money, seller, facts, projections, request] = await Promise.all([
      this.ledger.getHighestForAuction(auctionId),
      this.ledger.countForAuction(auctionId),
      this.participants.adminSummary(auctionId),
      this.users.findById(doc.advertiserAccountId).select('fullName accountType accountStatus brokerStatus systemRole').lean().exec(),
      this.properties.getAuctionOriginationFacts(doc.propertyId.toString()),
      this.properties.getAnchoredPublicProjections([{ propertyId: doc.propertyId.toString(), revisionId: doc.propertyRevisionId.toString() }]),
      doc.originRequestId ? this.requests.findById(doc.originRequestId).select('_id status revision').lean().exec() : Promise.resolve(null),
    ]);
    const s: any = seller;
    return {
      auction: {
        ...toAdminAuction(doc),
        bidding: {
          acceptedBidCount: doc.acceptedBidCount ?? 0,
          ledgerBidCount: bidCount,
          highestBid: highest ? {
            sequence: highest.sequence, amountMinor: highest.amountMinor, currency: highest.currency, acceptedAt: highest.acceptedAt,
            bidderAccountId: highest.bidderAccountId.toString(), bidderAccountTypeSnapshot: highest.bidderAccountTypeSnapshot,
          } : null,
        },
        payments: money.payments,
        entitlements: money.entitlements,
        seller: s ? {
          id: s._id.toString(), fullName: s.fullName, accountType: s.accountType, accountStatus: s.accountStatus, brokerStatus: s.brokerStatus,
          auctionEligible: AuthorizationPolicyService.can(s, Capability.AUCTION_CREATE_OWN),
        } : null,
        property: {
          anchored: projections.get(`${doc.propertyId}:${doc.propertyRevisionId}`) ?? null,
          title: facts?.title ?? null,
          publiclyVisible: facts?.publiclyVisible ?? false,
          currentPublicRevisionId: facts?.currentPublicRevisionId?.toString() ?? null,
          operationType: facts?.operationType ?? null,
        },
        request: request ? { id: (request as any)._id.toString(), status: (request as any).status, revision: (request as any).revision } : null,
      },
      serverTime: this.clock.now(),
    };
  }

  /** The staff bid ledger (identities included), in ledger order with a stable `sequence` cursor. */
  async listBids(auctionId: string, query: { afterSequence?: number; limit?: number } = {}) {
    assertId(auctionId);
    const exists = await this.auctions.exists({ _id: new Types.ObjectId(auctionId) }).exec();
    if (!exists) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const rows = await this.ledger.listForAuction(auctionId, { afterSequence: query.afterSequence, limit: limit + 1 });
    const page = rows.slice(0, limit);
    return {
      items: page.map((bid: any) => ({
        sequence: bid.sequence, amountMinor: bid.amountMinor, currency: bid.currency, acceptedAt: bid.acceptedAt,
        bidderAccountId: bid.bidderAccountId.toString(), bidderAccountTypeSnapshot: bid.bidderAccountTypeSnapshot,
      })),
      nextAfterSequence: rows.length > limit ? page[page.length - 1].sequence : null,
      serverTime: this.clock.now(),
    };
  }
}
