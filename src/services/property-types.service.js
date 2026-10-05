'use strict';

const {
  BadRequestException,
  ConflictException,
  NotFoundException,
} = require('../common/http/errors');
const { Types } = require('mongoose');
const { AuditAction } = require('../models/audit-log.model');
const { PROPERTY_TYPE_ICON_OPTIONS } = require('../domain/property-types/property-type-options');
class PropertyTypesService {
  constructor(model, purposes, audit, properties, revisions, connection) {
    this.model = model;
    this.purposes = purposes;
    this.audit = audit;
    this.properties = properties;
    this.revisions = revisions;
    this.connection = connection;
  }
  async listPublic() {
    const items = await this.model
      .find({ isActive: true })
      .sort({ sortOrder: 1, nameAr: 1 })
      .lean()
      .exec();
    return { items: items.map((item) => this.toPublic(item)) };
  }
  async listPublicMapped() {
    const items = await this.model
      .find({ isActive: true, purposeCategoryId: { $exists: true, $ne: null } })
      .sort({ sortOrder: 1, nameAr: 1 })
      .lean()
      .exec();
    return { items: items.map((item) => this.toPublic(item)) };
  }
  async listAdmin() {
    const items = await this.model.find({}).sort({ sortOrder: 1, nameAr: 1 }).lean().exec();
    return { items: items.map((item) => this.toAdmin(item)) };
  }
  getAdminOptions() {
    return {
      iconOptions: PROPERTY_TYPE_ICON_OPTIONS,
      sortOrder: { min: 0, max: 10000, default: 0 },
    };
  }
  async create(dto, actorUserId, ip) {
    if (
      !Types.ObjectId.isValid(dto.purposeCategoryId) ||
      !(await this.purposes.exists({ _id: dto.purposeCategoryId, isActive: true }))
    ) {
      throw new BadRequestException('غرض العقار غير موجود أو غير متاح');
    }
    try {
      const item = await this.model.create({
        ...dto,
        code: this.toCode(dto.nameEn),
        nameAr: dto.nameAr.trim(),
        nameEn: dto.nameEn?.trim() || undefined,
        descriptionAr: dto.descriptionAr?.trim() || undefined,
        iconKey: dto.iconKey?.trim() || undefined,
        purposeCategoryId: new Types.ObjectId(dto.purposeCategoryId),
        createdBy: new Types.ObjectId(actorUserId),
      });
      await this.audit.logAdminResourceAction(
        AuditAction.ADMIN_PROPERTY_TYPE_CREATED,
        actorUserId,
        item._id.toString(),
        `created property type ${item.code}`,
        ip,
      );
      return { message: 'تمت إضافة نوع العقار بنجاح', ...this.toAdmin(item.toObject()) };
    } catch (error) {
      if (error?.code === 11000) throw new ConflictException('رمز نوع العقار مستخدم بالفعل');
      throw error;
    }
  }
  async update(id, dto, actorUserId, ip) {
    this.assertId(id);
    if (
      dto.purposeCategoryId &&
      !(await this.purposes.exists({ _id: dto.purposeCategoryId, isActive: true }))
    ) {
      throw new BadRequestException('غرض العقار غير موجود أو غير متاح');
    }
    const { expectedVersion, ...values } = dto;
    const update = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.trim() : value,
      ]),
    );
    const item = (await this.changesPurpose(id, dto.purposeCategoryId))
      ? await this.reparentUnusedType(id, expectedVersion, update, actorUserId)
      : await this.applyUpdate(id, expectedVersion, update, actorUserId);
    if (!item) {
      if (!(await this.model.exists({ _id: id })))
        throw new NotFoundException('نوع العقار غير موجود');
      throw new ConflictException({
        message: 'تم تعديل نوع العقار بواسطة طلب آخر',
        code: 'PROPERTY_TYPE_VERSION_CONFLICT',
      });
    }
    await this.audit.logAdminResourceAction(
      AuditAction.ADMIN_PROPERTY_TYPE_UPDATED,
      actorUserId,
      id,
      `updated property type ${item.code}`,
      ip,
    );
    return { message: 'تم تحديث نوع العقار بنجاح', ...this.toAdmin(item) };
  }
  applyUpdate(id, expectedVersion, update, actorUserId, session) {
    return this.model
      .findOneAndUpdate(
        {
          _id: id,
          $or: [
            { version: expectedVersion },
            ...(expectedVersion === 0 ? [{ version: { $exists: false } }] : []),
          ],
        },
        { $set: { ...update, updatedBy: new Types.ObjectId(actorUserId) }, $inc: { version: 1 } },
        { new: true, runValidators: true, session },
      )
      .lean()
      .exec();
  }
  // A missing type is left to the regular update path so its NotFound handling stays unchanged.
  async changesPurpose(id, purposeCategoryId) {
    if (purposeCategoryId === undefined) return false;
    const current = await this.model.findById(id).select({ purposeCategoryId: 1 }).lean().exec();
    return (
      Boolean(current) &&
      (current.purposeCategoryId?.toString() ?? null) !== (purposeCategoryId ?? null)
    );
  }
  // Every Property/PropertyRevision write that references a type also increments that type's
  // usageCount inside its own transaction, so running the usage check and the reparent in one
  // transaction turns a concurrent listing write into a write conflict instead of a stale check.
  async reparentUnusedType(id, expectedVersion, update, actorUserId) {
    const session = await this.connection.startSession();
    try {
      let item = null;
      await session.withTransaction(async () => {
        await this.assertNotReferencedByListings(id, session);
        item = await this.applyUpdate(id, expectedVersion, update, actorUserId, session);
      });
      return item;
    } finally {
      await session.endSession();
    }
  }
  // usageCount is a conservative delete guard, not an exact usage metric, so reparenting is
  // decided by existence. A type is used as the primary (purposeSubcategoryId) or as an
  // additional selected type (purposeSubcategoryIds). strictQuery is pinned off so the array
  // filter is never stripped to {} while the field is not yet declared on the schemas.
  async assertNotReferencedByListings(id, session) {
    const typeId = new Types.ObjectId(id);
    const checks = [
      () => this.properties.exists({ purposeSubcategoryId: typeId }),
      () => this.properties.exists({ purposeSubcategoryIds: typeId }),
      () => this.revisions.exists({ purposeSubcategoryId: typeId }),
      () => this.revisions.exists({ purposeSubcategoryIds: typeId }),
    ];
    for (const check of checks) {
      if (await check().setOptions({ strictQuery: false }).session(session).exec()) {
        throw new ConflictException({
          message:
            'لا يمكن نقل نوع عقار مستخدم في عقارات إلى غرض آخر؛ أنشئ نوعاً جديداً تحت الغرض المطلوب',
          code: 'PROPERTY_TYPE_REPARENT_IN_USE',
        });
      }
    }
  }
  async remove(id, actorUserId, ip) {
    this.assertId(id);
    const item = await this.model.findById(id).exec();
    if (!item) throw new NotFoundException('نوع العقار غير موجود');
    if (item.usageCount > 0) {
      throw new ConflictException('لا يمكن حذف نوع مستخدم في عقارات؛ يمكنك تعطيله بدلاً من ذلك');
    }
    await item.deleteOne();
    await this.audit.logAdminResourceAction(
      AuditAction.ADMIN_PROPERTY_TYPE_DELETED,
      actorUserId,
      id,
      `deleted property type ${item.code}`,
      ip,
    );
    return { message: 'تم حذف نوع العقار بنجاح' };
  }
  assertId(id) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف نوع العقار غير صالح');
  }
  toCode(nameEn) {
    const code = nameEn
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 50);
    if (!/^[a-z][a-z0-9_]{1,49}$/.test(code)) {
      throw new BadRequestException('تعذر إنشاء كود صالح من الاسم الإنجليزي');
    }
    return code;
  }
  toPublic(item) {
    return {
      id: item._id.toString(),
      code: item.code,
      nameAr: item.nameAr,
      nameEn: item.nameEn,
      descriptionAr: item.descriptionAr,
      iconKey: item.iconKey,
      purposeCategoryId: item.purposeCategoryId?.toString(),
      sortOrder: item.sortOrder,
      version: item.version ?? 0,
    };
  }
  toAdmin(item) {
    return { ...this.toPublic(item), isActive: item.isActive, usageCount: item.usageCount ?? 0 };
  }
}

Object.assign(exports, { PropertyTypesService });
