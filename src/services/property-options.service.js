'use strict';

const {
  BadRequestException,
  ConflictException,
  NotFoundException,
} = require('../common/http/errors');
const { Types } = require('mongoose');
const { AuditAction } = require('../models/audit-log.model');
const {
  DEFAULT_PROPERTY_OPTIONS,
  PROPERTY_OPTION_GROUP_OPTIONS,
  PROPERTY_OPTION_ICON_OPTIONS,
} = require('../domain/property-options/property-option.constants');
class PropertyOptionsService {
  constructor(model, audit) {
    this.model = model;
    this.audit = audit;
  }
  async onModuleInit() {
    await Promise.all(
      DEFAULT_PROPERTY_OPTIONS.map(([group, code, nameAr, nameEn, iconKey, sortOrder, isDefault]) =>
        this.model
          .updateOne(
            { group, code },
            {
              $setOnInsert: {
                group,
                code,
                nameAr,
                nameEn,
                iconKey,
                sortOrder,
                isDefault,
                isActive: true,
                usageCount: 0,
              },
            },
            { upsert: true },
          )
          .exec(),
      ),
    );
  }
  async listPublic() {
    const items = await this.model
      .find({ isActive: true })
      .sort({ group: 1, sortOrder: 1, nameAr: 1 })
      .lean()
      .exec();
    return { items: items.map((i) => this.toPublic(i)) };
  }
  async listAdmin(group) {
    const items = await this.model
      .find(group ? { group } : {})
      .sort({ group: 1, sortOrder: 1, nameAr: 1 })
      .lean()
      .exec();
    return { items: items.map((i) => this.toAdmin(i)) };
  }
  getAdminOptions() {
    return {
      groupOptions: PROPERTY_OPTION_GROUP_OPTIONS,
      iconOptions: PROPERTY_OPTION_ICON_OPTIONS,
      sortOrder: { min: 0, max: 10000, default: 0 },
    };
  }
  async create(dto, actor, ip) {
    try {
      if (dto.isDefault) await this.clearDefault(dto.group);
      const item = await this.model.create({
        ...dto,
        code: this.toCode(dto.nameEn),
        createdBy: new Types.ObjectId(actor),
      });
      await this.audit.logAdminResourceAction(
        AuditAction.ADMIN_PROPERTY_OPTION_CREATED,
        actor,
        item._id.toString(),
        `created property option ${item.group}:${item.code}`,
        ip,
      );
      return { message: 'تمت إضافة الخيار بنجاح', ...this.toAdmin(item.toObject()) };
    } catch (error) {
      if (error?.code === 11000)
        throw new ConflictException('كود الخيار مستخدم بالفعل داخل هذه المجموعة');
      throw error;
    }
  }
  async update(id, dto, actor, ip) {
    this.assertId(id);
    const current = await this.model.findById(id).lean().exec();
    if (!current) throw new NotFoundException('الخيار غير موجود');
    const group = dto.group ?? current.group;
    if (dto.isDefault) await this.clearDefault(group, id);
    const update = Object.fromEntries(
      Object.entries(dto).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]),
    );
    const item = await this.model
      .findByIdAndUpdate(
        id,
        { ...update, updatedBy: new Types.ObjectId(actor) },
        { new: true, runValidators: true },
      )
      .lean()
      .exec();
    await this.audit.logAdminResourceAction(
      AuditAction.ADMIN_PROPERTY_OPTION_UPDATED,
      actor,
      id,
      `updated property option ${item.group}:${item.code}`,
      ip,
    );
    return { message: 'تم تحديث الخيار بنجاح', ...this.toAdmin(item) };
  }
  async remove(id, actor, ip) {
    this.assertId(id);
    const item = await this.model.findById(id).exec();
    if (!item) throw new NotFoundException('الخيار غير موجود');
    if (item.usageCount > 0)
      throw new ConflictException('لا يمكن حذف خيار مستخدم في عقارات؛ يمكنك تعطيله بدلاً من ذلك');
    await item.deleteOne();
    await this.audit.logAdminResourceAction(
      AuditAction.ADMIN_PROPERTY_OPTION_DELETED,
      actor,
      id,
      `deleted property option ${item.group}:${item.code}`,
      ip,
    );
    return { message: 'تم حذف الخيار بنجاح' };
  }
  clearDefault(group, exceptId) {
    return this.model
      .updateMany(
        { group, isDefault: true, ...(exceptId ? { _id: { $ne: exceptId } } : {}) },
        { $set: { isDefault: false } },
      )
      .exec();
  }
  assertId(id) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف الخيار غير صالح');
  }
  toCode(value) {
    const code = value
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
  toPublic(i) {
    return {
      id: i._id.toString(),
      code: i.code,
      group: i.group,
      nameAr: i.nameAr,
      nameEn: i.nameEn,
      descriptionAr: i.descriptionAr,
      iconKey: i.iconKey,
      sortOrder: i.sortOrder,
      isDefault: i.isDefault,
    };
  }
  toAdmin(i) {
    return { ...this.toPublic(i), isActive: i.isActive, usageCount: i.usageCount ?? 0 };
  }
}

Object.assign(exports, { PropertyOptionsService });
