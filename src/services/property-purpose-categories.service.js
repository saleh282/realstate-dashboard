'use strict';

const {
  BadRequestException,
  ConflictException,
  NotFoundException,
} = require('../common/http/errors');
const { Types } = require('mongoose');
const { AuditAction } = require('../models/audit-log.model');
class PropertyPurposeCategoriesService {
  constructor(model, audit) {
    this.model = model;
    this.audit = audit;
  }
  async listPublic() {
    const items = await this.model
      .find({ isActive: true })
      .sort({ sortOrder: 1, nameAr: 1 })
      .lean()
      .exec();
    return { items: items.map((item) => this.toPublic(item)) };
  }
  async listAdmin() {
    const items = await this.model.find({}).sort({ sortOrder: 1, nameAr: 1 }).lean().exec();
    return { items: items.map((item) => this.toAdmin(item)) };
  }
  async create(dto, actorId, ip) {
    try {
      const item = await this.model.create({
        ...dto,
        code: this.toCode(dto.nameEn),
        nameAr: dto.nameAr.trim(),
        nameEn: dto.nameEn.trim(),
        descriptionAr: dto.descriptionAr?.trim() || undefined,
        createdBy: new Types.ObjectId(actorId),
      });
      await this.audit.logAdminResourceAction(
        AuditAction.ADMIN_PROPERTY_PURPOSE_CREATED,
        actorId,
        item._id.toString(),
        `created property purpose ${item.code}`,
        ip,
      );
      return { message: 'تمت إضافة غرض العقار بنجاح', ...this.toAdmin(item.toObject()) };
    } catch (error) {
      if (error?.code === 11000) throw new ConflictException('رمز غرض العقار مستخدم بالفعل');
      throw error;
    }
  }
  async update(id, dto, actorId, ip) {
    this.assertId(id);
    const { expectedVersion, ...values } = dto;
    const update = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.trim() : value,
      ]),
    );
    const item = await this.model
      .findOneAndUpdate(
        { _id: id, version: expectedVersion },
        { $set: { ...update, updatedBy: new Types.ObjectId(actorId) }, $inc: { version: 1 } },
        { new: true, runValidators: true },
      )
      .lean()
      .exec();
    if (!item) {
      const exists = await this.model.exists({ _id: id });
      if (!exists) throw new NotFoundException('غرض العقار غير موجود');
      throw new ConflictException({
        message: 'تم تعديل غرض العقار بواسطة طلب آخر',
        code: 'PROPERTY_PURPOSE_VERSION_CONFLICT',
      });
    }
    await this.audit.logAdminResourceAction(
      AuditAction.ADMIN_PROPERTY_PURPOSE_UPDATED,
      actorId,
      id,
      `updated property purpose ${item.code}`,
      ip,
    );
    return { message: 'تم تحديث غرض العقار بنجاح', ...this.toAdmin(item) };
  }
  assertId(id) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف غرض العقار غير صالح');
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
      sortOrder: item.sortOrder,
      version: item.version,
    };
  }
  toAdmin(item) {
    return { ...this.toPublic(item), isActive: item.isActive, usageCount: item.usageCount ?? 0 };
  }
}

Object.assign(exports, { PropertyPurposeCategoriesService });
