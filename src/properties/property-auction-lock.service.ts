import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Auction, AuctionDocument } from '../auctions/schemas/auction.schema';
import { AuctionStatus } from '../auctions/auction.types';
import { PropertyErrorCode } from '../common/errors/property-error-codes';

/**
 * Provider-neutral boundary the property lifecycle/revision paths call
 * before mutating a property. Wired to real auction state (MAZAD-024): a
 * property is locked exactly while it has a SCHEDULED or ACTIVE auction —
 * the two states in which the auction still promises bidders an unchanged
 * property (see `Auction.propertyRevisionId`'s doc comment). The lock
 * releases naturally once that auction leaves those statuses — cancelled,
 * ended with no bids, or (later) completed — with no separate "release"
 * step to keep in sync, because `isLocked` always re-queries current state.
 *
 * Reads the `Auction` collection directly via its own `MongooseModule.
 * forFeature` binding in `PropertiesModule`, rather than importing
 * `AuctionsModule` (which already imports `PropertiesModule` for the
 * auction-anchor lookup). That keeps this a plain query/port boundary
 * instead of a module import cycle.
 */
@Injectable()
export class PropertyAuctionLockService {
  constructor(@InjectModel(Auction.name) private readonly auctions: Model<AuctionDocument>) {}

  async isLocked(propertyId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(propertyId)) return false;
    const locked = await this.auctions
      .exists({
        propertyId: new Types.ObjectId(propertyId),
        status: { $in: [AuctionStatus.SCHEDULED, AuctionStatus.ACTIVE] },
      })
      .exec();
    return Boolean(locked);
  }

  async assertUnlocked(propertyId: string): Promise<void> {
    if (await this.isLocked(propertyId)) {
      throw new ConflictException({ message: 'يجب إلغاء المزاد المجدول أو النشط قبل تعديل حالة العقار', code: PropertyErrorCode.AUCTION_LOCKED });
    }
  }
}
