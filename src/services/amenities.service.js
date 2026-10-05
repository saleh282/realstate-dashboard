'use strict';

const {
  BadRequestException,
  ConflictException,
  NotFoundException,
} = require('../common/http/errors');
const { Types } = require('mongoose');
const { AuditAction } = require('../models/audit-log.model');
const {
  AMENITY_CATEGORY_OPTIONS,
  AMENITY_ICON_OPTIONS,
} = require('../domain/amenities/amenity-options');
class AmenitiesService {
  constructor(model, audit) {
    this.model = model;
    this.audit = audit;
  }
  async listPublic() {
    const items = await this.model
      .find({ isActive: true })
      .sort({ category: 1, sortOrder: 1, nameAr: 1 })
      .lean()
      .exec();
    return { items: items.map((item) => this.toPublic(item)) };
  }
  async listAdmin() {
    const items = await this.model
      .find({})
      .sort({ category: 1, sortOrder: 1, nameAr: 1 })
      .lean()
      .exec();
    return { items: items.map((item) => this.toAdmin(item)) };
  }
  getAdminOptions() {
    return {
      iconOptions: AMENITY_ICON_OPTIONS,
      categoryOptions: AMENITY_CATEGORY_OPTIONS,
      sortOrder: { min: 0, max: 10000, default: 0 },
    };
  }
  async create(dto, actorUserId, ip) {
    try {
      const item = await this.model.create({
        ...dto,
        code: this.toCode(dto.nameEn),
        nameAr: dto.nameAr.trim(),
        nameEn: dto.nameEn.trim(),
        descriptionAr: dto.descriptionAr?.trim() || undefined,
        iconKey: dto.iconKey.trim(),
        category: dto.category.trim(),
        createdBy: new Types.ObjectId(actorUserId),
      });
      await this.audit.logAdminResourceAction(
        AuditAction.ADMIN_AMENITY_CREATED,
        actorUserId,
        item._id.toString(),
        `created amenity ${item.code}`,
        ip,
      );
      return { message: 'تمت إضافة الميزة أو الخدمة بنجاح', ...this.toAdmin(item.toObject()) };
    } catch (error) {
      if (error?.code === 11000) throw new ConflictException('كود الميزة أو الخدمة مستخدم بالفعل');
      throw error;
    }
  }
  async update(id, dto, actorUserId, ip) {
    this.assertId(id);
    const update = Object.fromEntries(
      Object.entries(dto).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.trim() : value,
      ]),
    );
    const item = await this.model
      .findByIdAndUpdate(
        id,
        { ...update, updatedBy: new Types.ObjectId(actorUserId) },
        { new: true, runValidators: true },
      )
      .lean()
      .exec();
    if (!item) throw new NotFoundException('الميزة أو الخدمة غير موجودة');
    await this.audit.logAdminResourceAction(
      AuditAction.ADMIN_AMENITY_UPDATED,
      actorUserId,
      id,
      `updated amenity ${item.code}`,
      ip,
    );
    return { message: 'تم تحديث الميزة أو الخدمة بنجاح', ...this.toAdmin(item) };
  }
  async remove(id, actorUserId, ip) {
    this.assertId(id);
    const item = await this.model.findById(id).exec();
    if (!item) throw new NotFoundException('الميزة أو الخدمة غير موجودة');
    if (item.usageCount > 0)
      throw new ConflictException('لا يمكن حذف عنصر مستخدم في عقارات؛ يمكنك تعطيله بدلاً من ذلك');
    await item.deleteOne();
    await this.audit.logAdminResourceAction(
      AuditAction.ADMIN_AMENITY_DELETED,
      actorUserId,
      id,
      `deleted amenity ${item.code}`,
      ip,
    );
    return { message: 'تم حذف الميزة أو الخدمة بنجاح' };
  }
  assertId(id) {
    if (!Types.ObjectId.isValid(id))
      throw new BadRequestException('معرّف الميزة أو الخدمة غير صالح');
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
    if (!/^[a-z][a-z0-9_]{1,49}$/.test(code))
      throw new BadRequestException('تعذر إنشاء كود صالح من الاسم الإنجليزي');
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
      category: item.category,
      sortOrder: item.sortOrder,
    };
  }
  toAdmin(item) {
    return { ...this.toPublic(item), isActive: item.isActive, usageCount: item.usageCount ?? 0 };
  }
}

Object.assign(exports, { AmenitiesService });
