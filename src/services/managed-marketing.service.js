'use strict';

const {
  BadRequestException,
  ConflictException,
  NotFoundException,
} = require('../common/http/errors');
const { Types } = require('mongoose');
const { AuditAction } = require('../models/audit-log.model');
const {
  PropertyRevisionModerationStatus,
  PropertyMarketingMode,
} = require('../domain/properties/property.types');
const {
  buildManagedMarketingPackageSnapshot,
} = require('../domain/managed-marketing/managed-marketing.snapshot');
const {
  ManagedMarketingPaymentStatus,
  ManagedMarketingRequestStatus,
} = require('../domain/managed-marketing/managed-marketing.types');
class ManagedMarketingService {
  constructor(packages, requests, properties, revisions, connection, audit) {
    this.packages = packages;
    this.requests = requests;
    this.properties = properties;
    this.revisions = revisions;
    this.connection = connection;
    this.audit = audit;
  }
  id(value) {
    if (!Types.ObjectId.isValid(value))
      throw new BadRequestException({
        message: 'المعرّف غير صالح',
        code: 'MANAGED_MARKETING_ID_INVALID',
      });
    return new Types.ObjectId(value);
  }
  packageView(item) {
    return {
      id: item._id.toString(),
      code: item.code,
      nameAr: item.nameAr,
      nameEn: item.nameEn,
      detailsAr: item.detailsAr,
      detailsEn: item.detailsEn,
      includedServiceCodes: item.includedServiceCodes ?? [],
      benefitsAr: item.benefitsAr ?? [],
      benefitsEn: item.benefitsEn ?? [],
      priceMinor: item.priceMinor,
      currency: item.currency,
      isActive: item.isActive,
      sortOrder: item.sortOrder,
      version: item.version,
    };
  }
  requestView(item) {
    return {
      id: item._id.toString(),
      propertyId: item.propertyId.toString(),
      propertyRevisionId: item.propertyRevisionId.toString(),
      package: { ...item.packageSnapshot, packageId: item.packageSnapshot.packageId.toString() },
      status: item.status,
      paymentStatus: item.paymentStatus,
      reviewReason: item.reviewReason,
      cancellationReason: item.cancellationReason,
      reviewedAt: item.reviewedAt,
      cancelledAt: item.cancelledAt,
      createdAt: item.createdAt,
      version: item.version ?? 0,
    };
  }
  async listActivePackages() {
    const items = await this.packages
      .find({ isActive: true, priceMinor: { $exists: true } })
      .sort({ sortOrder: 1, nameAr: 1 })
      .lean()
      .exec();
    return { items: items.map((i) => this.packageView(i)) };
  }
  async listPackagesAdmin() {
    const items = await this.packages.find({}).sort({ sortOrder: 1, nameAr: 1 }).lean().exec();
    return { items: items.map((i) => this.packageView(i)) };
  }
  async createPackage(dto, actor, ip) {
    try {
      const item = await this.packages.create({
        ...dto,
        code: dto.code.trim().toLowerCase(),
        currency: 'EGP',
        createdByActorId: this.id(actor),
        version: 1,
      });
      await this.audit.logAdminResourceAction(
        AuditAction.ADMIN_MANAGED_MARKETING_PACKAGE_CREATED,
        actor,
        item._id.toString(),
        `created managed-marketing package ${item.code}`,
        ip,
      );
      return { message: 'تم إنشاء باقة التسويق', package: this.packageView(item.toObject()) };
    } catch (error) {
      if (error?.code === 11000)
        throw new ConflictException({
          message: 'كود الباقة مستخدم بالفعل',
          code: 'MANAGED_MARKETING_PACKAGE_CODE_CONFLICT',
        });
      throw error;
    }
  }
  async updatePackage(packageId, dto, actor, ip) {
    const { version, ...changes } = dto;
    const item = await this.packages
      .findOneAndUpdate(
        { _id: this.id(packageId), version },
        { $set: { ...changes, updatedByActorId: this.id(actor) }, $inc: { version: 1 } },
        { new: true, runValidators: true },
      )
      .lean()
      .exec();
    if (!item)
      throw new ConflictException({
        message: 'تغيرت الباقة؛ أعد تحميل البيانات',
        code: 'MANAGED_MARKETING_PACKAGE_VERSION_CONFLICT',
      });
    await this.audit.logAdminResourceAction(
      AuditAction.ADMIN_MANAGED_MARKETING_PACKAGE_UPDATED,
      actor,
      packageId,
      `updated managed-marketing package ${item.code}`,
      ip,
    );
    return { message: 'تم تحديث باقة التسويق', package: this.packageView(item) };
  }
  async createRequest(actor, dto, ip) {
    const propertyId = this.id(dto.propertyId),
      revisionId = this.id(dto.propertyRevisionId);
    const [property, revision, selectedPackage] = await Promise.all([
      this.properties
        .findOne({
          _id: propertyId,
          $or: [
            { advertiserAccountId: this.id(actor) },
            { advertiserAccountId: { $exists: false }, ownerId: this.id(actor) },
          ],
        })
        .lean()
        .exec(),
      this.revisions.findOne({ _id: revisionId, propertyId }).lean().exec(),
      this.packages.findById(this.id(dto.packageId)).lean().exec(),
    ]);
    if (!property || !revision)
      throw new NotFoundException({
        message: 'العقار أو نسخته غير موجود',
        code: 'MANAGED_MARKETING_PROPERTY_NOT_FOUND',
      });
    if (revision.marketingMode !== PropertyMarketingMode.PLATFORM_MANAGED)
      throw new BadRequestException({
        message: 'طلب التسويق متاح للعقارات التي تدير المنصة تسويقها فقط',
        code: 'MANAGED_MARKETING_MODE_REQUIRED',
      });
    if (revision.moderationStatus !== PropertyRevisionModerationStatus.PENDING_REVIEW)
      throw new ConflictException({
        message: 'يجب إرسال نسخة العقار للمراجعة قبل طلب الباقة',
        code: 'MANAGED_MARKETING_REVISION_NOT_PENDING',
      });
    if (!selectedPackage)
      throw new NotFoundException({
        message: 'باقة التسويق غير موجودة',
        code: 'MANAGED_MARKETING_PACKAGE_NOT_FOUND',
      });
    const snapshot = buildManagedMarketingPackageSnapshot(selectedPackage);
    const session = await this.connection.startSession();
    try {
      let created;
      await session.withTransaction(async () => {
        [created] = await this.requests.create(
          [
            {
              propertyId,
              propertyRevisionId: revisionId,
              advertiserAccountId: this.id(actor),
              createdByActorId: this.id(actor),
              packageSnapshot: snapshot,
              status: ManagedMarketingRequestStatus.PENDING_REVIEW,
              paymentStatus: ManagedMarketingPaymentStatus.NOT_ELIGIBLE,
            },
          ],
          { session },
        );
        await this.audit.logRequired(
          {
            action: AuditAction.MANAGED_MARKETING_REQUEST_CREATED,
            actorUserId: actor,
            targetResourceId: created._id.toString(),
            reason: 'managed-marketing request created',
            ip,
            metadata: {
              propertyId: dto.propertyId,
              revisionId: dto.propertyRevisionId,
              packageId: dto.packageId,
            },
          },
          session,
        );
      });
      return {
        message: 'تم إرسال طلب التسويق للمراجعة',
        request: this.requestView(created.toObject()),
      };
    } catch (error) {
      if (error?.code === 11000)
        throw new ConflictException({
          message: 'يوجد طلب تسويق لهذه النسخة بالفعل',
          code: 'MANAGED_MARKETING_REQUEST_EXISTS',
        });
      throw error;
    } finally {
      await session.endSession();
    }
  }
  async listMine(actor) {
    const items = await this.requests
      .find({ advertiserAccountId: this.id(actor) })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    return { items: items.map((i) => this.requestView(i)) };
  }
  async cancel(actor, requestId, reason, ip) {
    const item = await this.requests
      .findOneAndUpdate(
        {
          _id: this.id(requestId),
          advertiserAccountId: this.id(actor),
          status: {
            $in: [
              ManagedMarketingRequestStatus.PENDING_REVIEW,
              ManagedMarketingRequestStatus.APPROVED,
            ],
          },
          paymentStatus: {
            $in: [
              ManagedMarketingPaymentStatus.NOT_ELIGIBLE,
              ManagedMarketingPaymentStatus.AWAITING_PAYMENT,
              ManagedMarketingPaymentStatus.FAILED,
            ],
          },
        },
        {
          $set: {
            status: ManagedMarketingRequestStatus.CANCELLED,
            cancellationReason: reason?.trim(),
            cancelledAt: new Date(),
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    if (!item)
      throw new ConflictException({
        message: 'لا يمكن إلغاء الطلب بعد بدء الدفع',
        code: 'MANAGED_MARKETING_CANCELLATION_NOT_ALLOWED',
      });
    await this.audit.logResourceAction(
      AuditAction.MANAGED_MARKETING_REQUEST_CANCELLED,
      actor,
      requestId,
      reason?.trim() || 'customer cancelled before payment',
      ip,
    );
    return { message: 'تم إلغاء طلب التسويق', request: this.requestView(item) };
  }
  async listRequestsAdmin(status) {
    const filter = status && status !== 'all' ? { status } : {};
    const items = await this.requests.find(filter).sort({ createdAt: 1 }).lean().exec();
    return { items: items.map((i) => this.requestView(i)) };
  }
  async review(requestId, dto, actor, ip) {
    const status =
      dto.status === 'APPROVED'
        ? ManagedMarketingRequestStatus.APPROVED
        : ManagedMarketingRequestStatus.REJECTED;
    const paymentStatus =
      status === ManagedMarketingRequestStatus.APPROVED
        ? ManagedMarketingPaymentStatus.AWAITING_PAYMENT
        : ManagedMarketingPaymentStatus.NOT_ELIGIBLE;
    const item = await this.requests
      .findOneAndUpdate(
        {
          _id: this.id(requestId),
          status: ManagedMarketingRequestStatus.PENDING_REVIEW,
          version: dto.version,
        },
        {
          $set: {
            status,
            paymentStatus,
            reviewReason: dto.reason?.trim(),
            reviewedByActorId: this.id(actor),
            reviewedAt: new Date(),
          },
        },
        { new: true, runValidators: true },
      )
      .lean()
      .exec();
    if (!item)
      throw new ConflictException({
        message: 'تغير الطلب أو تمت مراجعته بالفعل',
        code: 'MANAGED_MARKETING_REQUEST_VERSION_CONFLICT',
      });
    await this.audit.logAdminResourceAction(
      AuditAction.ADMIN_MANAGED_MARKETING_REQUEST_REVIEWED,
      actor,
      requestId,
      `managed-marketing request ${status}`,
      ip,
    );
    return {
      message:
        status === ManagedMarketingRequestStatus.APPROVED
          ? 'تمت الموافقة على الطلب وأصبح مؤهلاً للدفع'
          : 'تم رفض طلب التسويق',
      request: this.requestView(item),
    };
  }
}

Object.assign(exports, { ManagedMarketingService });
