import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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
import { normalizePropertyMoneyInput, propertyMoneyFromStoredRecord } from '../common/money/money';
import { validateEvidenceFile } from '../common/uploads/evidence-file.validator';
import { EvidenceErrorCode } from '../common/errors/evidence-error-codes';
import { AssetClassification, StoredAssetMetadata } from '../config/evidence-asset.types';
import { CloudinaryAssetService } from '../config/cloudinary-asset.service';

const PROPERTY_IMAGE_POLICY = { kind: 'image' as const, maxBytes: 10 * 1024 * 1024, maxImagePixels: 50_000_000 };
const PROPERTY_EVIDENCE_POLICY = { kind: 'document' as const, maxBytes: 10 * 1024 * 1024, maxImagePixels: 50_000_000, allowPdf: true };

@Injectable()
export class PropertiesService {
  constructor(
    @InjectModel(Property.name) private readonly properties: Model<PropertyDocument>,
    @InjectModel(PropertyType.name) private readonly propertyTypes: Model<PropertyTypeDocument>,
    @InjectModel(Amenity.name) private readonly amenities: Model<AmenityDocument>,
    @InjectModel(PropertyOption.name) private readonly options: Model<PropertyOptionDocument>,
    @InjectModel(Governorate.name) private readonly governorates: Model<GovernorateDocument>,
    @Inject(CLOUDINARY) private readonly cloudinary: typeof Cloudinary,
    private readonly evidenceAssets: CloudinaryAssetService,
    private readonly audit: AuditLogService,
  ) {}

  async create(ownerId: string, dto: CreatePropertyDto, files: { images?: Express.Multer.File[]; titleDeed?: Express.Multer.File[] }) {
    let money: ReturnType<typeof normalizePropertyMoneyInput>;
    try {
      money = normalizePropertyMoneyInput(dto);
    } catch (error) {
      if (error instanceof RangeError && error.message.includes('down payment exceeds')) {
        throw new BadRequestException('المقدم لا يمكن أن يتجاوز السعر الإجمالي');
      }
      throw new BadRequestException('بيانات السعر يجب أن تكون أعدادًا صحيحة بوحدات العملة الصغرى ضمن النطاق الآمن');
    }
    const images = files?.images ?? [];
    if (!images.length) throw new BadRequestException('يجب إرفاق صورة واحدة للعقار على الأقل');
    if (images.length > 20) throw new BadRequestException({ message: 'عدد صور العقار يتجاوز الحد المسموح', code: EvidenceErrorCode.FILE_COUNT_EXCEEDED });
    if (dto.imageLabels.length !== images.length) throw new BadRequestException('عدد مسميات الصور لا يطابق عدد الصور');
    if (dto.coverImageIndex >= images.length) throw new BadRequestException('صورة الغلاف المحددة غير صالحة');
    if (dto.floor > dto.totalFloors) throw new BadRequestException('رقم الطابق لا يمكن أن يتجاوز عدد الطوابق');
    if (money.downPaymentMinor > money.totalPriceMinor) throw new BadRequestException('المقدم لا يمكن أن يتجاوز السعر الإجمالي');
    const detectedImages = images.map((image) => validateEvidenceFile(image, PROPERTY_IMAGE_POLICY));
    const deedFile = files.titleDeed?.[0];
    const detectedDeed = deedFile ? validateEvidenceFile(deedFile, PROPERTY_EVIDENCE_POLICY) : undefined;

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

    const uploadedPublic: PropertyAsset[] = [];
    let titleDeed: PropertyAsset | undefined;
    let createdPropertyId: Types.ObjectId | undefined;
    try {
      for (let i = 0; i < images.length; i++) {
        uploadedPublic.push({
          ...(await this.uploadPublicImage(images[i], detectedImages[i].format)),
          label: dto.imageLabels[i],
        });
      }
      if (deedFile && detectedDeed) {
        titleDeed = await this.evidenceAssets.uploadPrivateEvidence(
          deedFile,
          'properties/title-deeds',
          AssetClassification.PRIVATE_PROPERTY_EVIDENCE,
          detectedDeed,
        ) as PropertyAsset;
      }

      const { totalPriceMinor: _totalPriceMinor, downPaymentMinor: _downPaymentMinor, currency: _currency, totalPrice: _totalPrice, downPayment: _downPayment, ...propertyData } = dto;
      const property = await this.properties.create({ ownerId: new Types.ObjectId(ownerId), ...propertyData, ...money, images: uploadedPublic, titleDeed, status: 'pending_review' });
      createdPropertyId = property._id;
      await Promise.all([
        this.propertyTypes.updateOne({ code: dto.propertyTypeCode }, { $inc: { usageCount: 1 } }).exec(),
        this.governorates.updateOne({ code: dto.governorateCode }, { $inc: { usageCount: 1 } }).exec(),
        this.options.updateMany({ code: { $in: [dto.finishingStatusCode, dto.deliveryStatusCode, dto.paymentMethodCode] } }, { $inc: { usageCount: 1 } }).exec(),
        dto.amenityCodes.length ? this.amenities.updateMany({ code: { $in: dto.amenityCodes } }, { $inc: { usageCount: 1 } }).exec() : Promise.resolve(),
      ]);
      if (titleDeed) {
        await this.audit.logResourceAction(AuditAction.PRIVATE_EVIDENCE_UPLOADED, ownerId, property._id.toString(), 'property-title-deed');
      }
      return { message: 'تم إرسال العقار للمراجعة بنجاح', property: this.toPublic(property.toObject()) };
    } catch (error) {
      if (createdPropertyId) await this.properties.deleteOne({ _id: createdPropertyId }).exec().catch(() => undefined);
      await Promise.allSettled(uploadedPublic.map(asset => this.cloudinary.uploader.destroy(asset.publicId, { resource_type: asset.resourceType, type: 'upload', invalidate: true })));
      if (titleDeed) await this.evidenceAssets.deleteOrEnqueue([titleDeed as StoredAssetMetadata], 'property-create-failed');
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

  async downloadTitleDeedForOwner(ownerId: string, id: string, ip?: string) {
    this.assertId(id);
    const item = await this.properties.findById(id).lean().exec();
    if (!item) throw new NotFoundException({ message: 'العقار غير موجود', code: EvidenceErrorCode.NOT_FOUND });
    if (item.ownerId.toString() !== ownerId) {
      throw new ForbiddenException({ message: 'لا يمكنك الوصول إلى مستندات هذا العقار', code: EvidenceErrorCode.ACCESS_FORBIDDEN });
    }
    const asset = this.privateTitleDeed(item.titleDeed);
    const result = await this.evidenceAssets.downloadAuthenticatedAsset(asset);
    await this.audit.logResourceAction(AuditAction.PRIVATE_EVIDENCE_ACCESSED, ownerId, id, 'property-title-deed-owner-access', ip);
    return result;
  }

  async downloadTitleDeedForAdmin(id: string, actorId: string, ip?: string) {
    this.assertId(id);
    const item = await this.properties.findById(id).lean().exec();
    if (!item) throw new NotFoundException({ message: 'العقار غير موجود', code: EvidenceErrorCode.NOT_FOUND });
    const asset = this.privateTitleDeed(item.titleDeed);
    const result = await this.evidenceAssets.downloadAuthenticatedAsset(asset);
    await this.audit.logAdminResourceAction(AuditAction.PRIVATE_EVIDENCE_ACCESSED, actorId, id, 'property-title-deed-admin-access', ip);
    return result;
  }

  private assertId(id: string) { if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف العقار غير صالح'); }
  private uploadPublicImage(file: Express.Multer.File, format: 'jpg' | 'png' | 'webp' | 'pdf'): Promise<PropertyAsset> {
    return new Promise((resolve, reject) => {
      const stream = this.cloudinary.uploader.upload_stream(
        { folder: 'real-estate-auction/public/properties/images', resource_type: 'image', type: 'upload', use_filename: false, unique_filename: true, overwrite: false },
        (error, result) => error || !result
          ? reject(new ServiceUnavailableException({ message: 'تعذر رفع صورة العقار', code: EvidenceErrorCode.UPLOAD_FAILED }))
          : resolve({
              url: result.secure_url,
              publicId: result.public_id,
              resourceType: 'image',
              deliveryType: 'upload',
              classification: AssetClassification.PUBLIC_PROPERTY_MEDIA,
              format: format === 'pdf' ? undefined : format,
              bytes: file.buffer.length,
            }),
      );
      streamifier.createReadStream(file.buffer).pipe(stream);
    });
  }

  private privateTitleDeed(asset?: PropertyAsset): StoredAssetMetadata {
    if (!asset?.publicId) {
      throw new NotFoundException({ message: 'مستند ملكية العقار غير موجود', code: EvidenceErrorCode.NOT_FOUND });
    }
    return {
      publicId: asset.publicId,
      resourceType: asset.resourceType,
      deliveryType: asset.deliveryType ?? 'upload',
      classification: asset.classification ?? AssetClassification.PRIVATE_PROPERTY_EVIDENCE,
      format: asset.format,
      bytes: asset.bytes,
      secureUrl: asset.url,
    };
  }

  private publicImages(images: PropertyAsset[] = []) {
    return images.map((image) => ({ url: image.url, label: image.label }));
  }

  private toPublic(item: any) {
    const money = propertyMoneyFromStoredRecord(item);
    return { id: item._id.toString(), operationType: item.operationType, propertyTypeCode: item.propertyTypeCode, title: item.title, description: item.description, governorateCode: item.governorateCode, city: item.city, district: item.district, area: item.area, bedrooms: item.bedrooms, bathrooms: item.bathrooms, floor: item.floor, ...money, images: this.publicImages(item.images), coverImageIndex: item.coverImageIndex, hasTitleDeed: Boolean(item.titleDeed?.publicId), advertiserType: item.advertiserType, isOwnerVisible: item.isOwnerVisible !== false, status: item.status, reviewReason: item.reviewReason, reviewedAt: item.reviewedAt, createdAt: item.createdAt };
  }
  private toAdmin(item: any, detailed = false) {
    const populatedOwner = item.ownerId && typeof item.ownerId === 'object' && item.ownerId.fullName;
    const owner = populatedOwner ? { id: item.ownerId._id.toString(), fullName: item.ownerId.fullName, email: item.ownerId.email, phone: item.ownerId.phone } : undefined;
    const base = { ...this.toPublic(item), owner, reviewReason: item.reviewReason, reviewedAt: item.reviewedAt };
    return detailed ? { ...base, street: item.street, additionalAddressDetails: item.additionalAddressDetails, latitude: item.latitude, longitude: item.longitude, bedrooms: item.bedrooms, livingRooms: item.livingRooms, kitchens: item.kitchens, bathrooms: item.bathrooms, floor: item.floor, totalFloors: item.totalFloors, buildingYear: item.buildingYear, finishingStatusCode: item.finishingStatusCode, deliveryStatusCode: item.deliveryStatusCode, amenityCodes: item.amenityCodes, isPriceNegotiable: item.isPriceNegotiable, paymentMethodCode: item.paymentMethodCode, hasTitleDeed: Boolean(item.titleDeed?.publicId), advertiserType: item.advertiserType, hidePhone: item.hidePhone } : base;
  }
}
