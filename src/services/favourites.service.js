'use strict';

const { Types } = require('mongoose');
const {
  BadRequestException,
  ConflictException,
  NotFoundException,
} = require('../common/http/errors');
const { ListingErrorCode } = require('../common/errors/listing-error-codes');
const { ListingStatus } = require('../domain/listings/listing.types');

/** Favourites one account may keep. */
const MAX_FAVOURITES = 500;

function objectId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) {
    throw new BadRequestException({
      message: 'معرف الإعلان غير صحيح',
      code: ListingErrorCode.ID_INVALID,
    });
  }
  return new Types.ObjectId(value);
}

/** The listings each account marked with the heart. */
class FavouritesService {
  constructor(favourites, listings) {
    this.favourites = favourites;
    this.listings = listings;
  }

  /**
   * The ids of the account's favourites that can be shown now, newest first.
   * One whose listing is no longer published is left out, and comes back by
   * itself if the listing is published again.
   */
  async list(userId) {
    const kept = await this.favourites
      .find({ userId: objectId(userId) })
      .sort({ createdAt: -1 })
      .limit(MAX_FAVOURITES)
      .lean()
      .exec();
    if (!kept.length) return { ids: [] };
    const published = await this.listings
      .find({
        _id: { $in: kept.map((favourite) => favourite.listingId) },
        status: ListingStatus.PUBLISHED,
      })
      .select('_id')
      .lean()
      .exec();
    const shown = new Set(published.map((listing) => String(listing._id)));
    return {
      ids: kept.map((favourite) => String(favourite.listingId)).filter((id) => shown.has(id)),
    };
  }

  /** Marks a published listing. Marking it again changes nothing. */
  async add(userId, listingId) {
    const user = objectId(userId);
    const listing = await this.listings
      .findOne({ _id: objectId(listingId), status: ListingStatus.PUBLISHED })
      .select('_id')
      .lean()
      .exec();
    if (!listing) {
      throw new NotFoundException({
        message: 'الإعلان غير موجود',
        code: ListingErrorCode.NOT_FOUND,
      });
    }
    const already = await this.favourites
      .findOne({ userId: user, listingId: listing._id })
      .lean()
      .exec();
    if (!already) {
      if ((await this.favourites.countDocuments({ userId: user }).exec()) >= MAX_FAVOURITES) {
        throw new ConflictException({
          message: `لا يمكن حفظ أكثر من ${MAX_FAVOURITES} إعلان في المفضلة`,
          code: ListingErrorCode.LIMIT_REACHED,
        });
      }
      await this.favourites
        .findOneAndUpdate(
          { userId: user, listingId: listing._id },
          { $setOnInsert: { userId: user, listingId: listing._id } },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
        .lean()
        .exec();
    }
    return { message: 'تمت الإضافة إلى المفضلة' };
  }

  /** Unmarks a listing, whatever became of it. Unmarking twice is fine. */
  async remove(userId, listingId) {
    await this.favourites
      .deleteOne({ userId: objectId(userId), listingId: objectId(listingId) })
      .exec();
    return { message: 'تمت الإزالة من المفضلة' };
  }
}

module.exports = { FavouritesService, MAX_FAVOURITES };
