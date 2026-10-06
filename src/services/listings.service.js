'use strict';

const { Types } = require('mongoose');
const {
  BadRequestException,
  ConflictException,
  NotFoundException,
} = require('../common/http/errors');
const { ListingErrorCode } = require('../common/errors/listing-error-codes');
const { EvidenceErrorCode } = require('../common/errors/evidence-error-codes');
const { validateEvidenceFile } = require('../common/uploads/evidence-file.validator');
const { runTransactionWithRetry } = require('../common/mongo/transaction-runner');
const { AuditAction } = require('../models/audit-log.model');
const { listingDecisionEvent } = require('../domain/outbox/outbox-events');
const {
  ListingStatus,
  MAX_PHOTOS,
  MAX_OPEN_LISTINGS,
} = require('../domain/listings/listing.types');
const { requiredShots } = require('../domain/listings/photo-shots');
const {
  MAX_MAP_POINTS,
  parseListingQuery,
  listingFilter,
  listingSearchPipeline,
} = require('../domain/listings/listing-search');
const { validateListing } = require('../validators/listings/listing.validator');
const {
  DATA_FIELDS,
  missingShots,
  ownerListing,
  publicListing,
  reviewListing,
  mapPoint,
} = require('../views/listing.view');

const PHOTO_POLICY = { kind: 'image', maxBytes: 8 * 1024 * 1024, maxImagePixels: 50_000_000 };
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime']);
/** A minute, with room for how recorders round the length. */
const VIDEO_MAX_SECONDS = 62;
/** How often a media change is retried when another one landed first. */
const MEDIA_ATTEMPTS = 5;
/** Stored fields that hold the advertiser's data, replaced as a whole on every edit. */
const STORED_DATA_FIELDS = [
  ...DATA_FIELDS,
  'areaSqm',
  'location',
  'transfer',
  'contactPhone',
  'showPhone',
  'allowWhatsapp',
];

const REVIEW_STATUSES = [
  ListingStatus.PENDING_REVIEW,
  ListingStatus.PUBLISHED,
  ListingStatus.REJECTED,
];

const notFound = () =>
  new NotFoundException({ message: 'الإعلان غير موجود', code: ListingErrorCode.NOT_FOUND });
const stateInvalid = (message) =>
  new ConflictException({ message, code: ListingErrorCode.STATE_INVALID });
const versionConflict = () =>
  new ConflictException({
    message: 'تم تعديل الإعلان من مكان آخر، أعد تحميله ثم حاول مرة أخرى',
    code: ListingErrorCode.VERSION_CONFLICT,
  });

function objectId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) {
    throw new BadRequestException({
      message: 'معرف الإعلان غير صحيح',
      code: ListingErrorCode.ID_INVALID,
    });
  }
  return new Types.ObjectId(value);
}

/** What the advertiser sent, checked; throws with the message of every wrong field. */
function checkedData(body) {
  const { value, errors } = validateListing(body);
  if (Object.keys(errors).length) {
    throw new BadRequestException({
      message: 'بيانات الإعلان غير صحيحة',
      code: ListingErrorCode.INVALID,
      details: errors,
    });
  }
  if (value.transfer) {
    value.transfer.remainingYears = value.transfer.totalYears - value.transfer.paidYears;
  }
  return value;
}

/**
 * Where a listing stands once its content changed: an unfinished one stays
 * unfinished, anything the review has seen goes back to it.
 */
function statusAfterChange(listing) {
  return listing.status === ListingStatus.DRAFT
    ? ListingStatus.DRAFT
    : ListingStatus.PENDING_REVIEW;
}

class ListingsService {
  constructor(listings, users, assets, auditLog, outbox, connection, clock = () => new Date()) {
    this.listings = listings;
    this.users = users;
    this.assets = assets;
    this.auditLog = auditLog;
    this.outbox = outbox;
    this.connection = connection;
    this.clock = clock;
  }

  // ---------------------------------------------------------------------
  // The advertiser's own listings
  // ---------------------------------------------------------------------

  async create(ownerId, body) {
    const data = checkedData(body);
    const owner = objectId(ownerId);
    const open = await this.listings
      .countDocuments({ ownerId: owner, status: { $ne: ListingStatus.CLOSED } })
      .exec();
    if (open >= MAX_OPEN_LISTINGS) {
      throw new ConflictException({
        message: `لا يمكن أن يكون لديك أكثر من ${MAX_OPEN_LISTINGS} إعلاناً مفتوحاً`,
        code: ListingErrorCode.LIMIT_REACHED,
      });
    }
    const listing = await this.listings.create({
      ...data,
      ownerId: owner,
      status: ListingStatus.DRAFT,
      version: 1,
    });
    return { message: 'تم حفظ الإعلان', listing: ownerListing(listing.toObject()) };
  }

  /** Replaces the data of a listing. `body.version` is the version the edit started from. */
  async update(ownerId, id, body) {
    const version = body?.version;
    if (!Number.isInteger(version)) {
      throw new BadRequestException({
        message: 'رقم نسخة الإعلان مطلوب',
        code: ListingErrorCode.INVALID,
        details: { version: 'هذا الحقل مطلوب' },
      });
    }
    const data = checkedData(body);
    const listing = await this.ownEditable(ownerId, id);
    if (listing.version !== version) throw versionConflict();

    const next = { ...listing, ...data };
    for (const field of STORED_DATA_FIELDS) if (!(field in data)) delete next[field];
    // A new category asks for other shots; an unfinished set cannot stay in review.
    const complete = missingShots(next).length === 0;
    const status = complete ? statusAfterChange(listing) : ListingStatus.DRAFT;

    const unset = Object.fromEntries(
      STORED_DATA_FIELDS.filter((field) => !(field in data)).map((field) => [field, '']),
    );
    const updated = await this.change(listing, {
      $set: { ...data, ...this.statusFields(listing, status) },
      $unset: { ...unset, rejectionReason: '' },
    });
    if (!updated) throw versionConflict();
    return { message: 'تم حفظ التعديلات', listing: ownerListing(updated) };
  }

  /** Sends an unfinished or refused listing to the review. */
  async submit(ownerId, id) {
    const listing = await this.ownEditable(ownerId, id);
    if (![ListingStatus.DRAFT, ListingStatus.REJECTED].includes(listing.status)) {
      throw stateInvalid('الإعلان مرسل للمراجعة بالفعل');
    }
    const missing = missingShots(listing);
    if (missing.length) {
      throw new BadRequestException({
        message: 'أضف الصور المطلوبة قبل إرسال الإعلان',
        code: ListingErrorCode.PHOTOS_MISSING,
        details: { missingShots: missing },
      });
    }
    const updated = await this.change(listing, {
      $set: this.statusFields(listing, ListingStatus.PENDING_REVIEW),
      $unset: { rejectionReason: '' },
    });
    if (!updated) throw versionConflict();
    return { message: 'تم إرسال إعلانك وهو قيد المراجعة', listing: ownerListing(updated) };
  }

  /** Ends a listing: sold, rented out or handed over. */
  async close(ownerId, id) {
    const listing = await this.ownEditable(ownerId, id);
    if (listing.status === ListingStatus.DRAFT) {
      throw stateInvalid('الإعلان لم يُرسل بعد، يمكنك حذفه');
    }
    const updated = await this.change(listing, {
      $set: { status: ListingStatus.CLOSED, closedAt: this.clock() },
    });
    if (!updated) throw versionConflict();
    return { message: 'تم إغلاق الإعلان', listing: ownerListing(updated) };
  }

  async remove(ownerId, id) {
    const listing = await this.own(ownerId, id);
    const deleted = await this.listings
      .deleteOne({ _id: listing._id, ownerId: listing.ownerId })
      .exec();
    if (!deleted.deletedCount) throw notFound();
    await this.assets.deleteOrEnqueue(
      [...(listing.photos ?? []), listing.video].filter(Boolean).map((media) => this.asset(media)),
      'listing-deleted',
    );
    return { message: 'تم حذف الإعلان' };
  }

  async mine(ownerId, query = {}) {
    const { value, errors } = parseListingQuery({ page: query.page, limit: query.limit });
    const status = query.status;
    if (
      Object.keys(errors).length ||
      (status !== undefined && !Object.values(ListingStatus).includes(status))
    ) {
      throw new BadRequestException({
        message: 'طلب غير صحيح',
        code: ListingErrorCode.QUERY_INVALID,
      });
    }
    const filter = { ownerId: objectId(ownerId), ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      this.listings
        .find(filter)
        .sort({ updatedAt: -1 })
        .skip((value.page - 1) * value.limit)
        .limit(value.limit)
        .lean()
        .exec(),
      this.listings.countDocuments(filter).exec(),
    ]);
    return { items: items.map(ownerListing), page: value.page, limit: value.limit, total };
  }

  async mineOne(ownerId, id) {
    return ownerListing(await this.own(ownerId, id));
  }

  // ---------------------------------------------------------------------
  // Photos and video
  // ---------------------------------------------------------------------

  /** Stores the photo of the required shot `shot`, replacing the one it had. */
  async putShot(ownerId, id, shot, file) {
    const listing = await this.ownEditable(ownerId, id);
    if (!requiredShots(listing).includes(shot)) {
      throw new BadRequestException({
        message: 'هذه اللقطة غير مطلوبة لهذا النوع من العقارات',
        code: ListingErrorCode.SHOT_INVALID,
      });
    }
    const uploaded = await this.uploadPhoto(file);
    let replaced;
    const updated = await this.changeMedia(ownerId, id, uploaded, (current) => {
      replaced = (current.photos ?? []).filter((photo) => photo.shot === shot);
      return {
        photos: [
          ...(current.photos ?? []).filter((photo) => photo.shot !== shot),
          { _id: new Types.ObjectId(), ...this.stored(uploaded), shot, order: 0 },
        ],
      };
    });
    await this.assets.deleteOrEnqueue(
      replaced.map((photo) => this.asset(photo)),
      'listing-shot-replaced',
    );
    return { message: 'تم رفع الصورة', listing: ownerListing(updated) };
  }

  /** Adds one more photo after the required shots. */
  async addPhoto(ownerId, id, file) {
    await this.ownEditable(ownerId, id);
    const uploaded = await this.uploadPhoto(file);
    const updated = await this.changeMedia(ownerId, id, uploaded, (current) => {
      const photos = current.photos ?? [];
      if (photos.length >= MAX_PHOTOS) {
        throw new ConflictException({
          message: `الحد الأقصى ${MAX_PHOTOS} صورة للإعلان`,
          code: ListingErrorCode.PHOTO_LIMIT_REACHED,
        });
      }
      const last = Math.max(
        0,
        ...photos.filter((photo) => !photo.shot).map((photo) => photo.order ?? 0),
      );
      return {
        photos: [
          ...photos,
          { _id: new Types.ObjectId(), ...this.stored(uploaded), order: last + 1 },
        ],
      };
    });
    return { message: 'تم رفع الصورة', listing: ownerListing(updated) };
  }

  /** Removes an extra photo. A required shot can only be replaced. */
  async removePhoto(ownerId, id, photoId) {
    let removed;
    const updated = await this.changeMedia(ownerId, id, null, (current) => {
      removed = (current.photos ?? []).find((photo) => String(photo._id) === photoId);
      if (!removed) {
        throw new NotFoundException({
          message: 'الصورة غير موجودة',
          code: ListingErrorCode.PHOTO_NOT_FOUND,
        });
      }
      if (removed.shot && requiredShots(current).includes(removed.shot)) {
        throw stateInvalid('هذه صورة مطلوبة، يمكنك استبدالها فقط');
      }
      return { photos: current.photos.filter((photo) => photo !== removed) };
    });
    await this.assets.deleteOrEnqueue([this.asset(removed)], 'listing-photo-removed');
    return { message: 'تم حذف الصورة', listing: ownerListing(updated) };
  }

  /** Puts the extra photos in the order of `photoIds`, which must name each of them once. */
  async orderPhotos(ownerId, id, photoIds) {
    const updated = await this.changeMedia(ownerId, id, null, (current) => {
      const shots = requiredShots(current);
      const extras = (current.photos ?? []).filter(
        (photo) => !photo.shot || !shots.includes(photo.shot),
      );
      const known = new Set(extras.map((photo) => String(photo._id)));
      const valid =
        Array.isArray(photoIds) &&
        photoIds.length === known.size &&
        new Set(photoIds).size === known.size &&
        photoIds.every((photoId) => known.has(photoId));
      if (!valid) {
        throw new BadRequestException({
          message: 'ترتيب الصور غير صحيح',
          code: ListingErrorCode.INVALID,
        });
      }
      return {
        photos: current.photos.map((photo) =>
          known.has(String(photo._id))
            ? { ...photo, order: photoIds.indexOf(String(photo._id)) + 1 }
            : photo,
        ),
      };
    });
    return { message: 'تم حفظ ترتيب الصور', listing: ownerListing(updated) };
  }

  /** Stores the listing's one video, replacing any it had. */
  async putVideo(ownerId, id, file) {
    await this.ownEditable(ownerId, id);
    this.checkVideo(file);
    const uploaded = await this.assets.uploadListingVideo(file);
    if (uploaded.duration !== undefined && uploaded.duration > VIDEO_MAX_SECONDS) {
      await this.assets.deleteOrEnqueue([uploaded], 'listing-video-too-long');
      throw new BadRequestException({
        message: 'مدة الفيديو يجب ألا تزيد عن دقيقة',
        code: EvidenceErrorCode.FILE_INVALID,
      });
    }
    let previous;
    const updated = await this.changeMedia(ownerId, id, uploaded, (current) => {
      previous = current.video;
      return { video: this.stored(uploaded) };
    });
    if (previous)
      await this.assets.deleteOrEnqueue([this.asset(previous, 'video')], 'listing-video-replaced');
    return { message: 'تم رفع الفيديو', listing: ownerListing(updated) };
  }

  async removeVideo(ownerId, id) {
    let previous;
    const updated = await this.changeMedia(ownerId, id, null, (current) => {
      previous = current.video;
      return { video: undefined };
    });
    if (previous)
      await this.assets.deleteOrEnqueue([this.asset(previous, 'video')], 'listing-video-removed');
    return { message: 'تم حذف الفيديو', listing: ownerListing(updated) };
  }

  // ---------------------------------------------------------------------
  // What everyone sees
  // ---------------------------------------------------------------------

  async search(query) {
    const search = this.checkedQuery(query);
    const [result] = await this.listings.aggregate(listingSearchPipeline(search)).exec();
    return {
      items: (result?.items ?? []).map((listing) => publicListing(listing, listing.owner)),
      page: search.page,
      limit: search.limit,
      total: result?.total?.[0]?.count ?? 0,
    };
  }

  /** Light markers of the published listings inside `bbox`. */
  async map(query) {
    const search = this.checkedQuery(query);
    if (!search.bbox) {
      throw new BadRequestException({
        message: 'حدود الخريطة مطلوبة',
        code: ListingErrorCode.QUERY_INVALID,
        details: { bbox: 'هذا الحقل مطلوب' },
      });
    }
    const filter = listingFilter(search);
    const items = await this.listings
      .find(filter)
      .select('location price purpose category')
      .sort({ publishedAt: -1 })
      .limit(MAX_MAP_POINTS + 1)
      .lean()
      .exec();
    return {
      items: items.slice(0, MAX_MAP_POINTS).map(mapPoint),
      // More listings are in view than a map can usefully show.
      truncated: items.length > MAX_MAP_POINTS,
    };
  }

  async publicOne(id) {
    const listing = await this.listings
      .findOne({ _id: objectId(id), status: ListingStatus.PUBLISHED })
      .lean()
      .exec();
    if (!listing) throw notFound();
    return publicListing(listing, await this.ownerOf(listing));
  }

  // ---------------------------------------------------------------------
  // The review
  // ---------------------------------------------------------------------

  async reviewQueue(query = {}) {
    const { value, errors } = parseListingQuery({ page: query.page, limit: query.limit });
    const status = query.status ?? ListingStatus.PENDING_REVIEW;
    if (Object.keys(errors).length || !REVIEW_STATUSES.includes(status)) {
      throw new BadRequestException({
        message: 'طلب غير صحيح',
        code: ListingErrorCode.QUERY_INVALID,
      });
    }
    const filter = { status };
    // The queue is worked oldest first; what was decided reads newest first.
    const sort = status === ListingStatus.PENDING_REVIEW ? { submittedAt: 1 } : { reviewedAt: -1 };
    const [items, total] = await Promise.all([
      this.listings
        .find(filter)
        .sort(sort)
        .skip((value.page - 1) * value.limit)
        .limit(value.limit)
        .lean()
        .exec(),
      this.listings.countDocuments(filter).exec(),
    ]);
    const owners = await this.ownersOf(items);
    return {
      items: items.map((listing) => reviewListing(listing, owners.get(String(listing.ownerId)))),
      page: value.page,
      limit: value.limit,
      total,
    };
  }

  async reviewOne(id) {
    const listing = await this.listings
      .findOne({ _id: objectId(id), status: { $ne: ListingStatus.DRAFT } })
      .lean()
      .exec();
    if (!listing) throw notFound();
    return reviewListing(listing, await this.ownerOf(listing));
  }

  approve(actor, id) {
    return this.decide(actor, id, { approved: true });
  }

  async reject(actor, id, reason) {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (text.length < 3 || text.length > 500) {
      throw new BadRequestException({
        message: 'اكتب سبب الرفض (من 3 إلى 500 حرف)',
        code: ListingErrorCode.REASON_REQUIRED,
      });
    }
    return this.decide(actor, id, { approved: false, reason: text });
  }

  /**
   * Records the review decision with its audit row and the advertiser's
   * notification in one transaction: all of them happen or none does.
   */
  async decide(actor, id, { approved, reason }) {
    const listingId = objectId(id);
    const now = this.clock();
    const updated = await runTransactionWithRetry(
      this.connection,
      async (session) => {
        // Only a listing still waiting can be decided, so of two reviewers one wins.
        const decided = await this.listings
          .findOneAndUpdate(
            { _id: listingId, status: ListingStatus.PENDING_REVIEW },
            {
              $set: {
                status: approved ? ListingStatus.PUBLISHED : ListingStatus.REJECTED,
                reviewedBy: objectId(actor.userId),
                reviewedAt: now,
                ...(approved ? { publishedAt: now } : { rejectionReason: reason }),
              },
              ...(approved ? { $unset: { rejectionReason: '' } } : {}),
              $inc: { version: 1 },
            },
            { new: true, session },
          )
          .lean()
          .exec();
        if (!decided) return null;
        await this.auditLog.logRequired(
          {
            action: approved ? AuditAction.LISTING_APPROVED : AuditAction.LISTING_REJECTED,
            actorUserId: actor.userId,
            targetUserId: String(decided.ownerId),
            targetResourceId: String(decided._id),
            reason: approved ? 'listing approved' : reason,
            ip: actor.ip,
          },
          session,
        );
        await this.outbox.recordRequired(
          listingDecisionEvent({
            approved,
            listingId: String(decided._id),
            ownerId: String(decided.ownerId),
            listingVersion: decided.version,
            occurredAt: now,
          }),
          session,
        );
        return decided;
      },
      { retryExhausted: () => versionConflict() },
    );
    if (!updated) {
      const exists = await this.listings.findOne({ _id: listingId }).select('status').lean().exec();
      if (!exists || exists.status === ListingStatus.DRAFT) throw notFound();
      throw stateInvalid('تمت مراجعة هذا الإعلان بالفعل');
    }
    return {
      message: approved ? 'تم نشر الإعلان' : 'تم رفض الإعلان',
      listing: reviewListing(updated, await this.ownerOf(updated)),
    };
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  checkedQuery(query) {
    const { value, errors } = parseListingQuery(query);
    if (Object.keys(errors).length) {
      throw new BadRequestException({
        message: 'طلب البحث غير صحيح',
        code: ListingErrorCode.QUERY_INVALID,
        details: errors,
      });
    }
    return value;
  }

  /** A listing of `ownerId`. Someone else's reads as missing, never as forbidden. */
  async own(ownerId, id) {
    const listing = await this.listings
      .findOne({ _id: objectId(id), ownerId: objectId(ownerId) })
      .lean()
      .exec();
    if (!listing) throw notFound();
    return listing;
  }

  async ownEditable(ownerId, id) {
    const listing = await this.own(ownerId, id);
    if (listing.status === ListingStatus.CLOSED) throw stateInvalid('الإعلان مغلق ولا يمكن تعديله');
    return listing;
  }

  /** Status with the dates that follow from it. */
  statusFields(listing, status) {
    return {
      status,
      ...(status === ListingStatus.PENDING_REVIEW && listing.status !== ListingStatus.PENDING_REVIEW
        ? { submittedAt: this.clock() }
        : {}),
    };
  }

  /**
   * Applies `update` if the listing is still at the version that was read,
   * and moves it to the next one. Returns null when it changed meanwhile.
   */
  change(listing, update) {
    return this.listings
      .findOneAndUpdate(
        { _id: listing._id, ownerId: listing.ownerId, version: listing.version },
        { ...update, $inc: { version: 1 } },
        { new: true },
      )
      .lean()
      .exec();
  }

  /**
   * Changes the photos or video of a listing. Several uploads may arrive at
   * once, so a change that lost the race is worked out again on the newer
   * listing. `uploaded` is discarded from storage if the change cannot be made.
   */
  async changeMedia(ownerId, id, uploaded, work) {
    try {
      for (let attempt = 0; attempt < MEDIA_ATTEMPTS; attempt++) {
        const current = await this.ownEditable(ownerId, id);
        const changes = work(current);
        const set = Object.fromEntries(
          Object.entries(changes).filter(([, value]) => value !== undefined),
        );
        const unset = Object.fromEntries(
          Object.entries(changes)
            .filter(([, value]) => value === undefined)
            .map(([field]) => [field, '']),
        );
        const updated = await this.change(current, {
          $set: { ...set, ...this.statusFields(current, statusAfterChange(current)) },
          $unset: {
            ...unset,
            ...(current.status === ListingStatus.REJECTED ? { rejectionReason: '' } : {}),
          },
        });
        if (updated) return updated;
      }
      throw versionConflict();
    } catch (error) {
      if (uploaded) await this.assets.deleteOrEnqueue([uploaded], 'listing-media-not-saved');
      throw error;
    }
  }

  async uploadPhoto(file) {
    if (!file) {
      throw new BadRequestException({
        message: 'الصورة مطلوبة',
        code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED,
      });
    }
    return this.assets.uploadListingPhoto(file, validateEvidenceFile(file, PHOTO_POLICY));
  }

  checkVideo(file) {
    const invalid = (message, code = EvidenceErrorCode.FILE_INVALID) =>
      new BadRequestException({ message, code });
    if (!file?.buffer?.length) throw invalid('ملف الفيديو فارغ أو تالف');
    if (file.buffer.length > VIDEO_MAX_BYTES) {
      throw invalid('حجم الفيديو يتجاوز 50 ميجابايت', EvidenceErrorCode.FILE_TOO_LARGE);
    }
    // MP4 and QuickTime both carry an `ftyp` box right after the size.
    const container = file.buffer.subarray(4, 8).toString('latin1');
    if (!VIDEO_MIME_TYPES.has(file.mimetype) || container !== 'ftyp') {
      throw invalid('صيغة الفيديو غير مدعومة', EvidenceErrorCode.FILE_TYPE_UNSUPPORTED);
    }
  }

  /** What is kept of an uploaded file on the listing. */
  stored(uploaded) {
    return { publicId: uploaded.publicId, url: uploaded.secureUrl, bytes: uploaded.bytes };
  }

  /** A stored photo or video as the storage service names it, to delete it. */
  asset(media, resourceType) {
    return {
      publicId: media.publicId,
      resourceType: resourceType ?? this.kindOf(media),
      deliveryType: 'upload',
      classification: 'public_property_media',
    };
  }

  kindOf(media) {
    return /\/video\/upload\//.test(media.url ?? '') ? 'video' : 'image';
  }

  async ownerOf(listing) {
    return this.users.findById(listing.ownerId).lean().exec();
  }

  async ownersOf(listings) {
    const ids = [...new Set(listings.map((listing) => String(listing.ownerId)))];
    const owners = ids.length
      ? await this.users
          .find({ _id: { $in: ids.map((value) => new Types.ObjectId(value)) } })
          .lean()
          .exec()
      : [];
    return new Map(owners.map((owner) => [String(owner._id), owner]));
  }
}

module.exports = { ListingsService };
