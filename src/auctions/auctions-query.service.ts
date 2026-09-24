import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { ClockService } from '../common/time/clock.service';
import { PropertiesService } from '../properties/properties.service';
import { toAdminAuction, toOwnAuction, toPublicAuction } from './auction-projections';
import { DEFAULT_PUBLIC_LIST_STATUSES, PUBLIC_AUCTION_STATUSES } from './auction.types';
import { ListAdminAuctionsDto, ListOwnAuctionsDto, ListPublicAuctionsDto, PublicAuctionSort } from './dto/list-auctions.dto';
import { Auction, AuctionDocument } from './schemas/auction.schema';

/** Mirrors `@Schema({ collection: 'properties' })` on the Property schema; needed for the public-listing `$lookup`. */
const PROPERTIES_COLLECTION = 'properties';

const PUBLIC_SORTS: Record<PublicAuctionSort, Record<string, 1 | -1>> = {
  newest: { createdAt: -1, _id: -1 },
  ending_soon: { currentEndAt: 1, _id: 1 },
  starting_soon: { scheduledStartAt: 1, _id: 1 },
  price_asc: { startingPriceMinor: 1, _id: 1 },
  price_desc: { startingPriceMinor: -1, _id: -1 },
};

function paging(query: { page?: number; limit?: number }) {
  const page = Number.isFinite(query.page) ? Math.max(query.page!, 1) : 1;
  const limit = Number.isFinite(query.limit) ? Math.min(Math.max(query.limit!, 1), 50) : 20;
  return { page, limit, skip: (page - 1) * limit };
}

function pagination(page: number, limit: number, total: number) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

function assertId(id: string) {
  if (typeof id !== 'string' || !Types.ObjectId.isValid(id)) {
    throw new BadRequestException({ message: 'معرّف المزاد غير صالح', code: AuctionErrorCode.ID_INVALID });
  }
}

/**
 * Read side of the auction HTTP contract (MAZAD-025): public discovery, the
 * advertiser's own auctions, and the staff operational read. Every method
 * derives what the caller may see from authoritative backend state — the
 * caller's identity comes from the verified token, never from the request —
 * and emits only whitelisted projections (see `auction-projections.ts`).
 * Reads are never audited. Mutations live in `AuctionsService` (create) and
 * `AuctionLifecycleService` (cancel), untouched by this class.
 */
@Injectable()
export class AuctionsQueryService {
  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<AuctionDocument>,
    private readonly properties: PropertiesService,
    private readonly clock: ClockService,
  ) {}

  // ------------------------------- public -------------------------------

  /**
   * Public discovery. Auctions are joined to their property in a single
   * aggregation so the visibility gate (approved, owner-visible, not
   * archived/admin-hidden — the same gate as `GET /properties`) and the
   * property-fact filters apply *before* pagination: `total` and page
   * contents are always consistent, never a short page with holes.
   */
  async listPublic(query: ListPublicAuctionsDto = {}) {
    const { page, limit, skip } = paging(query);
    const propertyMatch = await this.properties.buildPublicPropertyMatchForAuctions(query);

    const auctionMatch: Record<string, unknown> = {
      status: query.status ? query.status : { $in: [...DEFAULT_PUBLIC_LIST_STATUSES] },
    };
    if (query.minStartingPriceMinor !== undefined || query.maxStartingPriceMinor !== undefined) {
      if (query.minStartingPriceMinor !== undefined && query.maxStartingPriceMinor !== undefined && query.minStartingPriceMinor > query.maxStartingPriceMinor) {
        throw new BadRequestException({ message: 'الحد الأدنى للسعر أكبر من الحد الأقصى المحدد', code: AuctionErrorCode.QUERY_INVALID });
      }
      auctionMatch.startingPriceMinor = {
        ...(query.minStartingPriceMinor !== undefined ? { $gte: query.minStartingPriceMinor } : {}),
        ...(query.maxStartingPriceMinor !== undefined ? { $lte: query.maxStartingPriceMinor } : {}),
      };
    }
    const sort = PUBLIC_SORTS[query.sort ?? 'newest'];

    const [result] = await this.auctions.aggregate([
      { $match: auctionMatch },
      {
        $lookup: {
          from: PROPERTIES_COLLECTION,
          let: { propertyId: '$propertyId' },
          pipeline: [{ $match: { $and: [{ $expr: { $eq: ['$_id', '$$propertyId'] } }, propertyMatch] } }, { $project: { _id: 1 } }],
          as: 'visibleProperty',
        },
      },
      { $match: { 'visibleProperty.0': { $exists: true } } },
      { $project: { visibleProperty: 0 } },
      { $sort: sort },
      { $facet: { items: [{ $skip: skip }, { $limit: limit }], total: [{ $count: 'count' }] } },
    ]).exec();

    const docs: any[] = result?.items ?? [];
    const total: number = result?.total?.[0]?.count ?? 0;
    const projections = await this.properties.getAnchoredPublicProjections(
      docs.map((doc) => ({ propertyId: doc.propertyId.toString(), revisionId: doc.propertyRevisionId.toString() })),
    );
    const items = docs.flatMap((doc) => {
      const property = projections.get(`${doc.propertyId}:${doc.propertyRevisionId}`);
      return property ? [toPublicAuction(doc, property)] : [];
    });
    return { items, pagination: pagination(page, limit, total), serverTime: this.clock.now() };
  }

  async getPublic(id: string) {
    assertId(id);
    const doc = await this.auctions.findById(id).lean().exec();
    if (!doc) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    const unavailable = () => new NotFoundException({ message: 'هذا المزاد غير متاح للعرض', code: AuctionErrorCode.PUBLIC_UNAVAILABLE });
    if (!PUBLIC_AUCTION_STATUSES.includes(doc.status)) throw unavailable();
    const projections = await this.properties.getAnchoredPublicProjections([
      { propertyId: doc.propertyId.toString(), revisionId: doc.propertyRevisionId.toString() },
    ]);
    const property = projections.get(`${doc.propertyId}:${doc.propertyRevisionId}`);
    if (!property) throw unavailable();
    return { auction: toPublicAuction(doc, property), serverTime: this.clock.now() };
  }

  // -------------------------------- own ---------------------------------

  /** The caller's own auctions in every status, regardless of public discoverability. */
  async listMine(userId: string, query: ListOwnAuctionsDto = {}) {
    const { page, limit, skip } = paging(query);
    const filter: Record<string, unknown> = { advertiserAccountId: new Types.ObjectId(userId) };
    if (query.status) filter.status = query.status;
    const [docs, total] = await Promise.all([
      this.auctions.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean().exec(),
      this.auctions.countDocuments(filter).exec(),
    ]);
    const projections = await this.properties.getAnchoredPublicProjections(
      docs.map((doc) => ({ propertyId: doc.propertyId.toString(), revisionId: doc.propertyRevisionId.toString() })),
    );
    return {
      items: docs.map((doc) => toOwnAuction(doc, projections.get(`${doc.propertyId}:${doc.propertyRevisionId}`) ?? null)),
      pagination: pagination(page, limit, total),
      serverTime: this.clock.now(),
    };
  }

  /** Another account's auction is indistinguishable from a missing one (404), so ids cannot be probed for ownership. */
  async getMine(userId: string, id: string) {
    assertId(id);
    const doc = await this.auctions.findOne({ _id: id, advertiserAccountId: new Types.ObjectId(userId) }).lean().exec();
    if (!doc) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    const projections = await this.properties.getAnchoredPublicProjections([
      { propertyId: doc.propertyId.toString(), revisionId: doc.propertyRevisionId.toString() },
    ]);
    return { auction: toOwnAuction(doc, projections.get(`${doc.propertyId}:${doc.propertyRevisionId}`) ?? null), serverTime: this.clock.now() };
  }

  // ------------------------------- admin --------------------------------

  async listForAdmin(query: ListAdminAuctionsDto = {}) {
    const { page, limit, skip } = paging(query);
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.propertyId) filter.propertyId = new Types.ObjectId(query.propertyId);
    if (query.advertiserAccountId) filter.advertiserAccountId = new Types.ObjectId(query.advertiserAccountId);
    const [docs, total] = await Promise.all([
      this.auctions.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean().exec(),
      this.auctions.countDocuments(filter).exec(),
    ]);
    return { items: docs.map(toAdminAuction), pagination: pagination(page, limit, total), serverTime: this.clock.now() };
  }

  async getForAdmin(id: string) {
    assertId(id);
    const doc = await this.auctions.findById(id).lean().exec();
    if (!doc) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    return { auction: toAdminAuction(doc), serverTime: this.clock.now() };
  }
}
