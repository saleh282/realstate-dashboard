import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';
import { Capability } from '../authorization/capability';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../common/money/money';
import { PropertiesService } from '../properties/properties.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { AuctionActivationHoldCode } from './auction-request.types';

/**
 * MAZAD-035 activation gate. A due SCHEDULED auction starts only if, inside
 * the activation transaction:
 *   - its entry fee is configured (0 = FREE counts; absent never does),
 *   - the seller may still run auctions (ACTIVE, approved broker, not staff),
 *   - the property is still publicly visible and still the seller's,
 *   - the anchored revision still resolves and is a SALE listing.
 * The schedule itself was validated at approval and is immutable on the
 * Auction. The gate only reports; `AuctionLifecycleService` records the hold
 * and never invents a cancellation or refund.
 */
@Injectable()
export class AuctionActivationGate {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly properties: PropertiesService,
  ) {}

  async evaluate(auction: any, session: ClientSession): Promise<AuctionActivationHoldCode | null> {
    const fee = auction.entryFee;
    if (!fee || !isMoneyMinorAmount(fee.amountMinor) || fee.currency !== EGP_CURRENCY) return AuctionActivationHoldCode.ENTRY_FEE_MISSING;

    const advertiserId = auction.advertiserAccountId.toString();
    const seller: any = await this.users.findById(advertiserId).session(session).lean().exec();
    if (!seller || !AuthorizationPolicyService.can(seller, Capability.AUCTION_CREATE_OWN)) return AuctionActivationHoldCode.SELLER_NOT_ELIGIBLE;

    const facts = await this.properties.getAuctionOriginationFacts(auction.propertyId.toString(), session);
    if (!facts || !facts.publiclyVisible || facts.advertiserAccountId.toString() !== advertiserId) return AuctionActivationHoldCode.PROPERTY_NOT_ELIGIBLE;

    const anchor = await this.properties.resolveAuctionAnchor(auction.propertyId.toString(), auction.propertyRevisionId.toString(), session);
    if (!anchor) return AuctionActivationHoldCode.ANCHOR_UNRESOLVED;
    if (anchor.operationType !== 'sale') return AuctionActivationHoldCode.PROPERTY_NOT_SALE;
    return null;
  }
}
