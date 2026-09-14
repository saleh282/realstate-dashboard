import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { v2 as Cloudinary } from 'cloudinary';
import streamifier from 'streamifier';
import { CLOUDINARY } from '../config/cloudinary.provider';
import { Amenity, AmenityDocument } from '../amenities/schemas/amenity.schema';
import { Governorate, GovernorateDocument } from '../governorates/schemas/governorate.schema';
import { PropertyOption, PropertyOptionDocument } from '../property-options/schemas/property-option.schema';
import { PropertyType, PropertyTypeDocument } from '../property-types/schemas/property-type.schema';
import { CreatePropertyDto } from './dto/create-property.dto';
import { Property, PropertyAsset, PropertyDocument } from './schemas/property.schema';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';

@Injectable()
export class PropertiesService {
  constructor(
    @InjectModel(Property.name) private readonly properties: Model<PropertyDocument>,
    @InjectModel(PropertyType.name) private readonly propertyTypes: Model<PropertyTypeDocument>,
    @InjectModel(Amenity.name) private readonly amenities: Model<AmenityDocument>,
    @InjectModel(PropertyOption.name) private readonly options: Model<PropertyOptionDocument>,
    @InjectModel(Governorate.name) private readonly governorates: Model<GovernorateDocument>,
    @Inject(CLOUDINARY) private readonly cloudinary: typeof Cloudinary,
    private readonly audit: AuditLogService,
  ) {}

  async create(ownerId: string, dto: CreatePropertyDto, files: { images?: Express.Multer.File[]; titleDeed?: Express.Multer.File[] }) {
    const images = files?.images ?? [];
    if (!images.length) throw new BadRequestException('يجب إرفاق صورة واحدة للعقار على الأقل');
    if (dto.imageLabels.length !== images.length) throw new BadRequestException('عدد مسميات الصور لا يطابق عدد الصور');
    if (dto.coverImageIndex >= images.length) throw new BadRequestException('صورة الغلاف المحددة غير صالحة');
    if (dto.floor > dto.totalFloors) throw new BadRequestException('رقم الطابق لا يمكن أن يتجاوز عدد الطوابق');
    if (dto.downPayment > dto.totalPrice) throw new BadRequestException('المقدم لا يمكن أن يتجاوز السعر الإجمالي');

    const [type, governorate, finishing, delivery, payment, amenityCount] = await Promise.all([
      this.propertyTypes.findOne({ code: dto.propertyTypeCode, isActive: true }).lean().exec(),
      this.governorates.findOne({ code: dto.governorateCode, isActive: true }).lean().exec(),
      this.options.findOne({ group: 'finishing_status', code: dto.finishingStatusCode, isActive: true }).lean().exec(),
      this.options.findOne({ group: 'delivery_status', code: dto.deliveryStatusCode, isActive: true }).lean().exec(),
      this.options.findOne({ group: 'payment_method', code: dto.paymentMethodCode, isActive: true }).lean().exec(),
      this.amenities.countDocuments({ code: { $in: dto.amenityCodes }, isActive: true }).exec(),
    ]);
    const invalid = [!type && 'نوع العقار', !governorate && 'المحافظة', !finishing && 'حالة التشطيب', !delivery && 'جاهزية التسليم', !payment && 'طريقة السداد'].filter(Boolean);
    if (invalid.length || amenityCount !== dto.amenityCodes.length) throw new BadRequestException(`بعض الاختيارات غير موجودة أو غير متاحة: ${invalid.join('، ')}${amenityCount !== dto.amenityCodes.length ? `${invalid.length ? '، ' : ''}المميزات والخدمات` : ''}`);

    const uploaded: PropertyAsset[] = [];
    let createdPropertyId: Types.ObjectId | undefined;
    try {
      for (let i = 0; i < images.length; i++) uploaded.push({ ...(await this.upload(images[i], 'properties/images')), label: dto.imageLabels[i] });
      let titleDeed: PropertyAsset | undefined;
      if (files.titleDeed?.[0]) titleDeed = await this.upload(files.titleDeed[0], 'properties/title-deeds');
      if (titleDeed) uploaded.push(titleDeed);

      const property = await this.properties.create({ ownerId: new Types.ObjectId(ownerId), ...dto, images: uploaded.slice(0, images.length), titleDeed, status: 'pending_review' });
      createdPropertyId = property._id;
      await Promise.all([
        this.propertyTypes.updateOne({ code: dto.propertyTypeCode }, { $inc: { usageCount: 1 } }).exec(),
        this.governorates.updateOne({ code: dto.governorateCode }, { $inc: { usageCount: 1 } }).exec(),
        this.options.updateMany({ code: { $in: [dto.finishingStatusCode, dto.deliveryStatusCode, dto.paymentMethodCode] } }, { $inc: { usageCount: 1 } }).exec(),
        dto.amenityCodes.length ? this.amenities.updateMany({ code: { $in: dto.amenityCodes } }, { $inc: { usageCount: 1 } }).exec() : Promise.resolve(),
      ]);
      return { message: 'تم إرسال العقار للمراجعة بنجاح', property: this.toPublic(property.toObject()) };
    } catch (error) {
      if (createdPropertyId) await this.properties.deleteOne({ _id: createdPropertyId }).exec().catch(() => undefined);
      await Promise.allSettled(uploaded.map(asset => this.cloudinary.uploader.destroy(asset.publicId, { resource_type: asset.resourceType })));
      throw error;
    }
  }

  async listMine(ownerId: string) { const items = await this.properties.find({ ownerId: new Types.ObjectId(ownerId) }).sort({ createdAt: -1 }).lean().exec(); return { items: items.map(i => this.toPublic(i)) }; }
  async getMine(ownerId: string, id: string) { if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف العقار غير صالح'); const item = await this.properties.findOne({ _id: id, ownerId }).lean().exec(); if (!item) throw new NotFoundException('العقار غير موجود'); return { property: this.toPublic(item) }; }
  async listPublished(options: { page?: number; limit?: number }) {
    const page = Number.isFinite(options.page) ? Math.max(options.page!, 1) : 1;
    const limit = Number.isFinite(options.limit) ? Math.min(Math.max(options.limit!, 1), 50) : 20;
    const filter = { status: 'approved', isOwnerVisible: { $ne: false } };
    const [items, total] = await Promise.all([
      this.properties.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.properties.countDocuments(filter).exec(),
    ]);
    const [governorates, propertyTypes] = await Promise.all([
      this.governorates.find({ code: { $in: [...new Set(items.map(item => item.governorateCode))] } }).lean().exec(),
      this.propertyTypes.find({ code: { $in: [...new Set(items.map(item => item.propertyTypeCode))] } }).lean().exec(),
    ]);
    const governorateNames = new Map(governorates.map(item => [item.code, item.nameAr]));
    const propertyTypeNames = new Map(propertyTypes.map(item => [item.code, item.nameAr]));
    return {
      items: items.map(item => ({
        ...this.toPublic(item),
        governorateNameAr: governorateNames.get(item.governorateCode) ?? item.governorateCode,
        propertyTypeNameAr: propertyTypeNames.get(item.propertyTypeCode) ?? item.propertyTypeCode,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async updateOwnerVisibility(ownerId: string, id: string, isVisible: boolean) {
    this.assertId(id);
    const item = await this.properties.findOneAndUpdate(
      { _id: id, ownerId: new Types.ObjectId(ownerId) },
      { isOwnerVisible: isVisible },
      { new: true, runValidators: true },
    ).lean().exec();
    if (!item) throw new NotFoundException('العقار غير موجود');
    return { message: isVisible ? 'تم إظهار العقار للمستخدمين' : 'تم إخفاء العقار عن المستخدمين', property: this.toPublic(item) };
  }
  async listForAdmin(options: { page?: number; limit?: number; status?: string; search?: string }) {
    const page = Math.max(options.page || 1, 1);
    const limit = Math.min(Math.max(options.limit || 20, 1), 100);
    const filter: any = {};
    if (options.status && options.status !== 'all') {
      if (!['pending_review', 'approved', 'rejected', 'hidden'].includes(options.status)) throw new BadRequestException('حالة العقار غير صالحة');
      filter.status = options.status;
    }
    if (options.search?.trim()) {
      const escaped = options.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = ['title', 'city', 'district'].map(field => ({ [field]: { $regex: escaped, $options: 'i' } }));
    }
    const [items, total] = await Promise.all([
      this.properties.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('ownerId', 'fullName email phone').lean().exec(),
      this.properties.countDocuments(filter).exec(),
    ]);
    return { items: items.map(item => this.toAdmin(item)), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getForAdmin(id: string) {
    this.assertId(id);
    const item = await this.properties.findById(id).populate('ownerId', 'fullName email phone').lean().exec();
    if (!item) throw new NotFoundException('العقار غير موجود');
    return { property: this.toAdmin(item, true) };
  }

  async reviewForAdmin(id: string, status: 'approved' | 'rejected' | 'hidden' | 'pending_review', reason: string | undefined, actor: string, ip?: string) {
    this.assertId(id);
    const item = await this.properties.findByIdAndUpdate(id, {
      status, reviewReason: reason?.trim() || undefined,
      reviewedBy: new Types.ObjectId(actor), reviewedAt: new Date(),
    }, { new: true, runValidators: true }).populate('ownerId', 'fullName email phone').lean().exec();
    if (!item) throw new NotFoundException('العقار غير موجود');
    await this.audit.logAdminResourceAction(AuditAction.ADMIN_PROPERTY_STATUS_UPDATED, actor, id, `${status}: ${reason?.trim() || 'no reason provided'}`, ip);
    const messages = { approved: 'تم اعتماد العقار بنجاح', rejected: 'تم رفض العقار وتسجيل السبب', hidden: 'تم إخفاء العقار', pending_review: 'تمت إعادة العقار إلى المراجعة' };
    return { message: messages[status], property: this.toAdmin(item, true) };
  }

  private assertId(id: string) { if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف العقار غير صالح'); }
  private upload(file: Express.Multer.File, folder: string): Promise<PropertyAsset> { return new Promise((resolve, reject) => { const resourceType = file.mimetype === 'application/pdf' ? 'raw' : 'image'; const stream = this.cloudinary.uploader.upload_stream({ folder, resource_type: resourceType }, (error, result) => error || !result ? reject(error ?? new Error('Upload failed')) : resolve({ url: result.secure_url, publicId: result.public_id, resourceType })); streamifier.createReadStream(file.buffer).pipe(stream); }); }
  private toPublic(item: any) { return { id: item._id.toString(), operationType: item.operationType, propertyTypeCode: item.propertyTypeCode, title: item.title, description: item.description, governorateCode: item.governorateCode, city: item.city, district: item.district, area: item.area, bedrooms: item.bedrooms, bathrooms: item.bathrooms, floor: item.floor, totalPrice: item.totalPrice, images: item.images, coverImageIndex: item.coverImageIndex, hasTitleDeed: Boolean(item.titleDeed), advertiserType: item.advertiserType, isOwnerVisible: item.isOwnerVisible !== false, status: item.status, reviewReason: item.reviewReason, reviewedAt: item.reviewedAt, createdAt: item.createdAt }; }
  private toAdmin(item: any, detailed = false) {
    const populatedOwner = item.ownerId && typeof item.ownerId === 'object' && item.ownerId.fullName;
    const owner = populatedOwner ? { id: item.ownerId._id.toString(), fullName: item.ownerId.fullName, email: item.ownerId.email, phone: item.ownerId.phone } : undefined;
    const base = { ...this.toPublic(item), owner, reviewReason: item.reviewReason, reviewedAt: item.reviewedAt };
    return detailed ? { ...base, street: item.street, additionalAddressDetails: item.additionalAddressDetails, latitude: item.latitude, longitude: item.longitude, bedrooms: item.bedrooms, livingRooms: item.livingRooms, kitchens: item.kitchens, bathrooms: item.bathrooms, floor: item.floor, totalFloors: item.totalFloors, buildingYear: item.buildingYear, finishingStatusCode: item.finishingStatusCode, deliveryStatusCode: item.deliveryStatusCode, amenityCodes: item.amenityCodes, downPayment: item.downPayment, isPriceNegotiable: item.isPriceNegotiable, paymentMethodCode: item.paymentMethodCode, titleDeed: item.titleDeed, advertiserType: item.advertiserType, hidePhone: item.hidePhone } : base;
  }
}
