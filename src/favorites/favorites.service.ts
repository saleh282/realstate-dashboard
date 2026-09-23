import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FavoriteErrorCode } from '../common/errors/favorite-error-codes';
import { PropertiesService } from '../properties/properties.service';
import { ListFavoritesDto } from './dto/list-favorites.dto';
import { Favorite, FavoriteDocument } from './schemas/favorite.schema';

/**
 * `GET /favorites/ids` is not paginated: it is the lightweight full set the
 * Flutter app caches to answer "is this property favorited?" for any card
 * without a round trip per card. A hard cap keeps it bounded regardless.
 */
export const FAVORITE_IDS_CAP = 2000;

@Injectable()
export class FavoritesService {
  constructor(
    @InjectModel(Favorite.name) private readonly favorites: Model<FavoriteDocument>,
    private readonly properties: PropertiesService,
  ) {}

  /** Idempotent: favoriting an already-favorited property is a safe no-op, never a duplicate. */
  async add(userId: string, propertyId: string) {
    this.assertPropertyId(propertyId);
    const isVisible = await this.properties.isPubliclyVisible(propertyId);
    if (!isVisible) {
      throw new NotFoundException({ message: 'العقار غير متاح لإضافته إلى المفضلة', code: FavoriteErrorCode.PROPERTY_NOT_AVAILABLE });
    }
    const userObjectId = new Types.ObjectId(userId);
    const propertyObjectId = new Types.ObjectId(propertyId);
    try {
      await this.favorites.updateOne(
        { userId: userObjectId, propertyId: propertyObjectId },
        { $setOnInsert: { userId: userObjectId, propertyId: propertyObjectId } },
        { upsert: true },
      ).exec();
    } catch (error) {
      // Two concurrent "add" requests can both attempt the upsert; the
      // unique index lets exactly one insert win and the loser gets an
      // E11000 here. That is the already-favorited case, not a failure.
      if ((error as { code?: number })?.code !== 11000) throw error;
    }
    return { message: 'تمت الإضافة إلى المفضلة' };
  }

  /** Idempotent: removing a favorite that is already gone (or never existed) is a safe no-op. */
  async remove(userId: string, propertyId: string) {
    this.assertPropertyId(propertyId);
    await this.favorites.deleteOne({ userId: new Types.ObjectId(userId), propertyId: new Types.ObjectId(propertyId) }).exec();
    return { message: 'تمت الإزالة من المفضلة' };
  }

  /** The full set of the user's favorited property ids, for fast client-side favorite-state lookups. */
  async ids(userId: string) {
    const docs = await this.favorites
      .find({ userId: new Types.ObjectId(userId) })
      .select('propertyId')
      .limit(FAVORITE_IDS_CAP)
      .lean()
      .exec();
    return { propertyIds: docs.map((doc) => doc.propertyId.toString()) };
  }

  /**
   * Paginated favorites list with the safe public property projection.
   * `pagination.total` counts favorite records, not currently-visible
   * properties: a property that became hidden/archived after being
   * favorited still occupies its slot in the page (its favorite record is
   * untouched — see the Favorite schema doc comment) but is silently
   * omitted from `items`, so a page can legitimately contain fewer than
   * `limit` items without that being an error.
   */
  async list(userId: string, query: ListFavoritesDto = {}) {
    const page = Number.isFinite(query.page) ? Math.max(query.page!, 1) : 1;
    const limit = Number.isFinite(query.limit) ? Math.min(Math.max(query.limit!, 1), 50) : 20;
    const filter = { userId: new Types.ObjectId(userId) };
    const [docs, total] = await Promise.all([
      this.favorites.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.favorites.countDocuments(filter).exec(),
    ]);
    const propertyIds = docs.map((doc) => doc.propertyId.toString());
    const projections = await this.properties.getPublicProjectionsByIds(propertyIds);
    const favoritedAtByPropertyId = new Map(docs.map((doc) => [doc.propertyId.toString(), (doc as any).createdAt]));
    const items = propertyIds
      .map((id) => projections.get(id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((item) => ({ ...item, favoritedAt: favoritedAtByPropertyId.get(item.id) }));
    return { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  private assertPropertyId(propertyId: string) {
    if (!Types.ObjectId.isValid(propertyId)) {
      throw new BadRequestException({ message: 'معرّف العقار غير صالح', code: FavoriteErrorCode.PROPERTY_INVALID });
    }
  }
}
