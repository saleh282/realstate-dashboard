import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { CreateCityDto } from './dto/create-city.dto';
import { CreateGovernorateDto } from './dto/create-governorate.dto';
import { UpdateCityDto } from './dto/update-city.dto';
import { UpdateGovernorateDto } from './dto/update-governorate.dto';
import { DEFAULT_CITIES, DEFAULT_GOVERNORATES, GOVERNORATE_ICON_OPTIONS } from './governorate.constants';
import { City, CityDocument } from './schemas/city.schema';
import { Governorate, GovernorateDocument } from './schemas/governorate.schema';

@Injectable()
export class GovernoratesService implements OnModuleInit {
  constructor(
    @InjectModel(Governorate.name) private readonly model: Model<GovernorateDocument>,
    @InjectModel(City.name) private readonly cities: Model<CityDocument>,
    private readonly audit: AuditLogService,
  ) {}

  async onModuleInit() {
    await Promise.all(DEFAULT_GOVERNORATES.map(([code, nameAr, nameEn, sortOrder]) => this.model.updateOne(
      { code },
      { $setOnInsert: { code, nameAr, nameEn, sortOrder, iconKey: 'location', isActive: true, usageCount: 0 } },
      { upsert: true },
    ).exec()));
    const governorates = await this.model.find({ code: { $in: DEFAULT_GOVERNORATES.map(item => item[0]) } }).select({ _id: 1, code: 1 }).lean().exec();
    const ids = new Map(governorates.map(item => [item.code, item._id]));
    await Promise.all(DEFAULT_CITIES.map(([governorateCode, code, nameAr, nameEn], index) => {
      const governorateId = ids.get(governorateCode);
      if (!governorateId) return Promise.resolve();
      return this.cities.updateOne(
        { governorateId, code },
        { $setOnInsert: { governorateId, code, nameAr, nameEn, sortOrder: (index + 1) * 10, isActive: true, usageCount: 0 } },
        { upsert: true },
      ).exec();
    }));
  }

  async listPublic() {
    const items = await this.model.find({ isActive: true }).sort({ sortOrder: 1, nameAr: 1 }).lean().exec();
    return { items: items.map(item => this.toPublic(item)) };
  }

  async listPublicCities() {
    const items = await this.cities.find({ isActive: true })
      .populate({ path: 'governorateId', match: { isActive: true }, select: 'code' })
      .sort({ sortOrder: 1, nameAr: 1 }).lean().exec();
    return { items: items.filter(item => item.governorateId).map(item => this.toCityPublic(item)) };
  }

  async listAdmin() {
    const items = await this.model.find({}).sort({ sortOrder: 1, nameAr: 1 }).lean().exec();
    return { items: items.map(item => this.toAdmin(item)) };
  }

  async listCitiesAdmin() {
    const items = await this.cities.find({})
      .populate({ path: 'governorateId', select: 'code nameAr nameEn isActive' })
      .sort({ sortOrder: 1, nameAr: 1 }).lean().exec();
    return { items: items.map(item => this.toCityAdmin(item)) };
  }

  getAdminOptions() {
    return { iconOptions: GOVERNORATE_ICON_OPTIONS, sortOrder: { min: 0, max: 10000, default: 0 } };
  }

  async getCityAdminOptions() {
    const governorates = await this.model.find({}).sort({ sortOrder: 1, nameAr: 1 }).lean().exec();
    return {
      governorates: governorates.map(item => ({ id: item._id.toString(), code: item.code, nameAr: item.nameAr, isActive: item.isActive })),
      sortOrder: { min: 0, max: 10000, default: 0 },
    };
  }

  async create(dto: CreateGovernorateDto, actor: string, ip?: string) {
    try {
      const item = await this.model.create({ ...dto, code: this.toCode(dto.nameEn), createdBy: new Types.ObjectId(actor) });
      await this.audit.logAdminResourceAction(AuditAction.ADMIN_GOVERNORATE_CREATED, actor, item._id.toString(), `created governorate ${item.code}`, ip);
      return { message: 'تمت إضافة المحافظة بنجاح', ...this.toAdmin(item.toObject()) };
    } catch (error: any) {
      if (error?.code === 11000) throw new ConflictException('كود المحافظة مستخدم بالفعل');
      throw error;
    }
  }

  async update(id: string, dto: UpdateGovernorateDto, actor: string, ip?: string) {
    this.assertId(id, 'المحافظة');
    const update = this.trimStrings(dto);
    const item = await this.model.findByIdAndUpdate(id, { ...update, updatedBy: new Types.ObjectId(actor) }, { new: true, runValidators: true }).lean().exec();
    if (!item) throw new NotFoundException('المحافظة غير موجودة');
    await this.audit.logAdminResourceAction(AuditAction.ADMIN_GOVERNORATE_UPDATED, actor, id, `updated governorate ${item.code}`, ip);
    return { message: 'تم تحديث المحافظة بنجاح', ...this.toAdmin(item) };
  }

  async remove(id: string, actor: string, ip?: string) {
    this.assertId(id, 'المحافظة');
    const item = await this.model.findById(id).exec();
    if (!item) throw new NotFoundException('المحافظة غير موجودة');
    if (item.usageCount > 0 || await this.cities.exists({ governorateId: item._id })) {
      throw new ConflictException('لا يمكن حذف محافظة مستخدمة أو مرتبطة بمدن؛ يمكنك تعطيلها بدلاً من ذلك');
    }
    await item.deleteOne();
    await this.audit.logAdminResourceAction(AuditAction.ADMIN_GOVERNORATE_DELETED, actor, id, `deleted governorate ${item.code}`, ip);
    return { message: 'تم حذف المحافظة بنجاح' };
  }

  async createCity(dto: CreateCityDto, actor: string, ip?: string) {
    this.assertId(dto.governorateId, 'المحافظة');
    const governorate = await this.model.findById(dto.governorateId).lean().exec();
    if (!governorate) throw new BadRequestException('المحافظة غير موجودة');
    try {
      const item = await this.cities.create({ ...dto, nameAr: dto.nameAr.trim(), nameEn: dto.nameEn.trim(), code: this.toCode(dto.nameEn), governorateId: governorate._id, createdBy: new Types.ObjectId(actor) });
      await this.audit.logAdminResourceAction(AuditAction.ADMIN_CITY_CREATED, actor, item._id.toString(), `created city ${governorate.code}:${item.code}`, ip);
      return { message: 'تمت إضافة المدينة بنجاح', ...this.toCityAdmin({ ...item.toObject(), governorateId: governorate }) };
    } catch (error: any) {
      if (error?.code === 11000) throw new ConflictException('المدينة موجودة بالفعل داخل هذه المحافظة');
      throw error;
    }
  }

  async updateCity(id: string, dto: UpdateCityDto, actor: string, ip?: string) {
    this.assertId(id, 'المدينة');
    if (dto.governorateId) {
      this.assertId(dto.governorateId, 'المحافظة');
      if (!await this.model.exists({ _id: dto.governorateId })) throw new BadRequestException('المحافظة غير موجودة');
    }
    const update: any = this.trimStrings(dto);
    if (update.governorateId) update.governorateId = new Types.ObjectId(update.governorateId);
    try {
      const item = await this.cities.findByIdAndUpdate(id, { ...update, updatedBy: new Types.ObjectId(actor) }, { new: true, runValidators: true })
        .populate({ path: 'governorateId', select: 'code nameAr nameEn isActive' }).lean().exec();
      if (!item) throw new NotFoundException('المدينة غير موجودة');
      await this.audit.logAdminResourceAction(AuditAction.ADMIN_CITY_UPDATED, actor, id, `updated city ${item.code}`, ip);
      return { message: 'تم تحديث المدينة بنجاح', ...this.toCityAdmin(item) };
    } catch (error: any) {
      if (error?.code === 11000) throw new ConflictException('المدينة موجودة بالفعل داخل هذه المحافظة');
      throw error;
    }
  }

  async removeCity(id: string, actor: string, ip?: string) {
    this.assertId(id, 'المدينة');
    const item = await this.cities.findById(id).exec();
    if (!item) throw new NotFoundException('المدينة غير موجودة');
    if (item.usageCount > 0) throw new ConflictException('لا يمكن حذف مدينة مستخدمة في عقارات؛ يمكنك تعطيلها بدلاً من ذلك');
    await item.deleteOne();
    await this.audit.logAdminResourceAction(AuditAction.ADMIN_CITY_DELETED, actor, id, `deleted city ${item.code}`, ip);
    return { message: 'تم حذف المدينة بنجاح' };
  }

  private assertId(id: string, label: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`معرّف ${label} غير صالح`);
  }

  private trimStrings(dto: object) {
    return Object.fromEntries(Object.entries(dto).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value]));
  }

  private toCode(value: string) {
    const code = value.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
    if (!/^[a-z][a-z0-9_]{1,49}$/.test(code)) throw new BadRequestException('تعذر إنشاء كود صالح من الاسم الإنجليزي');
    return code;
  }

  private toPublic(item: any) {
    return { id: item._id.toString(), code: item.code, nameAr: item.nameAr, nameEn: item.nameEn, iconKey: item.iconKey, sortOrder: item.sortOrder };
  }

  private toAdmin(item: any) {
    return { ...this.toPublic(item), isActive: item.isActive, usageCount: item.usageCount ?? 0 };
  }

  private toCityPublic(item: any) {
    const governorate = item.governorateId;
    return { id: item._id.toString(), code: item.code, nameAr: item.nameAr, nameEn: item.nameEn, governorateId: governorate._id.toString(), governorateCode: governorate.code, sortOrder: item.sortOrder };
  }

  private toCityAdmin(item: any) {
    const governorate = item.governorateId;
    return { ...this.toCityPublic(item), governorateNameAr: governorate.nameAr, governorateActive: governorate.isActive, isActive: item.isActive, usageCount: item.usageCount ?? 0 };
  }
}
