'use strict';

const { Types } = require('mongoose');
const {
  BadRequestException,
  ConflictException,
  NotFoundException,
} = require('../common/http/errors');
const { ListingErrorCode } = require('../common/errors/listing-error-codes');
const { ListingStatus } = require('../domain/listings/listing.types');
const { MAX_LIMIT } = require('../domain/listings/listing-search');
const { AuditAction } = require('../models/audit-log.model');
const { REPORT_REASONS, ReportStatus } = require('../models/listing-report.model');
const { orderedPhotos } = require('../views/listing.view');

const invalid = (message, code = ListingErrorCode.REPORT_INVALID) =>
  new BadRequestException({ message, code });

function objectId(value, message) {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) {
    throw invalid(message, ListingErrorCode.ID_INVALID);
  }
  return new Types.ObjectId(value);
}

/** Complaints about published listings: accounts send them, staff read them. */
class ListingReportsService {
  constructor(reports, listings, users, auditLog, clock = () => new Date()) {
    this.reports = reports;
    this.listings = listings;
    this.users = users;
    this.auditLog = auditLog;
    this.clock = clock;
  }

  /** Records that `reporterId` reports the listing. Reporting it again changes nothing. */
  async report(reporterId, listingId, body) {
    const reason = body?.reason;
    if (!REPORT_REASONS.includes(reason)) throw invalid('اختر سبب البلاغ');
    const details = typeof body?.details === 'string' ? body.details.trim() : '';
    if (details.length > 500) throw invalid('تفاصيل البلاغ طويلة جداً');

    const listing = await this.listings
      .findOne({
        _id: objectId(listingId, 'معرف الإعلان غير صحيح'),
        status: ListingStatus.PUBLISHED,
      })
      .select('ownerId')
      .lean()
      .exec();
    if (!listing) {
      throw new NotFoundException({
        message: 'الإعلان غير موجود',
        code: ListingErrorCode.NOT_FOUND,
      });
    }
    if (String(listing.ownerId) === reporterId) throw invalid('لا يمكنك الإبلاغ عن إعلانك');

    const reporter = objectId(reporterId, 'معرف الحساب غير صحيح');
    await this.reports
      .findOneAndUpdate(
        { listingId: listing._id, reporterId: reporter },
        {
          $setOnInsert: {
            listingId: listing._id,
            reporterId: reporter,
            reason,
            ...(details ? { details } : {}),
            status: ReportStatus.OPEN,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .lean()
      .exec();
    return { message: 'تم إرسال بلاغك. شكراً لك.' };
  }

  /** The reports staff have to look at, newest first, each with its listing and who sent it. */
  async queue(query = {}) {
    const status = query.status ?? ReportStatus.OPEN;
    const page = /^\d{1,5}$/.test(query.page ?? '1') ? Number(query.page ?? 1) : 0;
    const limit = /^\d{1,2}$/.test(query.limit ?? '20') ? Number(query.limit ?? 20) : 0;
    if (
      !Object.values(ReportStatus).includes(status) ||
      page < 1 ||
      limit < 1 ||
      limit > MAX_LIMIT
    ) {
      throw invalid('طلب غير صحيح', ListingErrorCode.QUERY_INVALID);
    }
    const filter = { status };
    const [items, total] = await Promise.all([
      this.reports
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.reports.countDocuments(filter).exec(),
    ]);
    const ids = (field) =>
      [...new Set(items.map((item) => String(item[field])))].map(
        (value) => new Types.ObjectId(value),
      );
    const [listings, reporters, open] = await Promise.all([
      items.length
        ? this.listings
            .find({ _id: { $in: ids('listingId') } })
            .lean()
            .exec()
        : [],
      items.length
        ? this.users
            .find({ _id: { $in: ids('reporterId') } })
            .lean()
            .exec()
        : [],
      // How many open reports each of these listings has in all.
      Promise.all(
        ids('listingId').map(async (listingId) => [
          String(listingId),
          await this.reports.countDocuments({ listingId, status: ReportStatus.OPEN }).exec(),
        ]),
      ),
    ]);
    const byId = (docs) => new Map(docs.map((doc) => [String(doc._id), doc]));
    const listingOf = byId(listings);
    const reporterOf = byId(reporters);
    const openOn = new Map(open);
    return {
      items: items.map((report) => {
        const listing = listingOf.get(String(report.listingId));
        const reporter = reporterOf.get(String(report.reporterId));
        return {
          id: String(report._id),
          reason: report.reason,
          details: report.details ?? null,
          status: report.status,
          createdAt: report.createdAt,
          reviewedAt: report.reviewedAt ?? null,
          // Null once the advertiser deleted the listing.
          listing: listing
            ? {
                id: String(listing._id),
                titleAr: listing.titleAr,
                status: listing.status,
                price: listing.price,
                photoUrl: orderedPhotos(listing)[0]?.url ?? null,
                openReports: openOn.get(String(listing._id)) ?? 0,
              }
            : null,
          reporter: reporter
            ? { id: String(reporter._id), name: reporter.fullName, email: reporter.email ?? null }
            : null,
        };
      }),
      page,
      limit,
      total,
    };
  }

  /** Marks a report as looked at. What to do about the listing is a separate decision. */
  async review(actor, id) {
    const reportId = objectId(id, 'معرف البلاغ غير صحيح');
    const now = this.clock();
    const reviewed = await this.reports
      .findOneAndUpdate(
        { _id: reportId, status: ReportStatus.OPEN },
        {
          $set: {
            status: ReportStatus.REVIEWED,
            reviewedBy: objectId(actor.userId, 'معرف الحساب غير صحيح'),
            reviewedAt: now,
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    if (!reviewed) {
      const exists = await this.reports.findOne({ _id: reportId }).lean().exec();
      if (!exists) {
        throw new NotFoundException({
          message: 'البلاغ غير موجود',
          code: ListingErrorCode.REPORT_NOT_FOUND,
        });
      }
      throw new ConflictException({
        message: 'تمت مراجعة هذا البلاغ بالفعل',
        code: ListingErrorCode.STATE_INVALID,
      });
    }
    await this.auditLog.logRequired({
      action: AuditAction.LISTING_REPORT_REVIEWED,
      actorUserId: actor.userId,
      targetUserId: String(reviewed.reporterId),
      targetResourceId: String(reviewed.listingId),
      reason: 'listing report reviewed',
      ip: actor.ip,
    });
    return { message: 'تم تعليم البلاغ كمراجَع' };
  }
}

module.exports = { ListingReportsService };
