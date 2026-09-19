import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { CreatePropertyTypeDto } from './dto/create-property-type.dto';
import { UpdatePropertyTypeDto } from './dto/update-property-type.dto';
import { PropertyType, PropertyTypeDocument } from './schemas/property-type.schema';
import { PROPERTY_TYPE_ICON_OPTIONS } from './property-type-options';
import { PropertyPurposeCategory, PropertyPurposeCategoryDocument } from '../property-purpose-categories/schemas/property-purpose-category.schema';

@Injectable()
export class PropertyTypesService {
  constructor(
    @InjectModel(PropertyType.name) private readonly model: Model<PropertyTypeDocument>,
    @InjectModel(PropertyPurposeCategory.name) private readonly purposes: Model<PropertyPurposeCategoryDocument>,
    private readonly audit: AuditLogService,
  ) {}

  async listPublic() {
    const items = await this.model.find({ isActive: true }).sort({ sortOrder: 1, nameAr: 1 }).lean().exec();
    return { items: items.map((item) => this.toPublic(item)) };
  }

  async listPublicMapped() {
    const items = await this.model.find({ isActive: true, purposeCategoryId: { $exists: true, $ne: null } }).sort({ sortOrder: 1, nameAr: 1 }).lean().exec();
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

  async create(dto: CreatePropertyTypeDto, actorUserId: string, ip?: string) {
    if (!Types.ObjectId.isValid(dto.purposeCategoryId) || !(await this.purposes.exists({ _id: dto.purposeCategoryId, isActive: true }))) {
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
    } catch (error: any) {
      if (error?.code === 11000) throw new ConflictException('رمز نوع العقار مستخدم بالفعل');
      throw error;
    }
  }

  async update(id: string, dto: UpdatePropertyTypeDto, actorUserId: string, ip?: string) {
    this.assertId(id);
    if (dto.purposeCategoryId && !(await this.purposes.exists({ _id: dto.purposeCategoryId, isActive: true }))) {
      throw new BadRequestException('غرض العقار غير موجود أو غير متاح');
    }
    const { expectedVersion, ...values } = dto;
    const update = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]),
    );
    const item = await this.model.findOneAndUpdate(
      { _id: id, $or: [{ version: expectedVersion }, ...(expectedVersion === 0 ? [{ version: { $exists: false } }] : [])] },
      { $set: { ...update, updatedBy: new Types.ObjectId(actorUserId) }, $inc: { version: 1 } },
      { new: true, runValidators: true },
    ).lean().exec();
    if (!item) {
      if (!(await this.model.exists({ _id: id }))) throw new NotFoundException('نوع العقار غير موجود');
      throw new ConflictException({ message: 'تم تعديل نوع العقار بواسطة طلب آخر', code: 'PROPERTY_TYPE_VERSION_CONFLICT' });
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

  async remove(id: string, actorUserId: string, ip?: string) {
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

  private assertId(id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف نوع العقار غير صالح');
  }

  private toCode(nameEn: string) {
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

  private toPublic(item: any) {
    return {
      id: item._id.toString(), code: item.code, nameAr: item.nameAr,
      nameEn: item.nameEn, descriptionAr: item.descriptionAr,
      iconKey: item.iconKey, purposeCategoryId: item.purposeCategoryId?.toString(), sortOrder: item.sortOrder, version: item.version ?? 0,
    };
  }

  private toAdmin(item: any) {
    return { ...this.toPublic(item), isActive: item.isActive, usageCount: item.usageCount ?? 0 };
  }
}
