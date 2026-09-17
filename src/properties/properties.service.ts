import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
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
import { EGP_CURRENCY, isMoneyMinorAmount, propertyMoneyFromStoredRecord } from '../common/money/money';
import { validateEvidenceFile } from '../common/uploads/evidence-file.validator';
import { EvidenceErrorCode } from '../common/errors/evidence-error-codes';
import { AssetClassification, StoredAssetMetadata } from '../config/evidence-asset.types';
import { CloudinaryAssetService } from '../config/cloudinary-asset.service';
import { PropertyRevision, PropertyRevisionDocument } from './schemas/property-revision.schema';
import { PropertyPurposeCategory, PropertyPurposeCategoryDocument } from '../property-purpose-categories/schemas/property-purpose-category.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { AccountType } from '../users/identity.types';
import { PropertyMarketingMode, PropertyRevisionModerationStatus } from './property.types';
import { PropertyErrorCode } from '../common/errors/property-error-codes';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';

const PROPERTY_IMAGE_POLICY = { kind: 'image' as const, maxBytes: 10 * 1024 * 1024, maxImagePixels: 50_000_000 };
const PROPERTY_EVIDENCE_POLICY = { kind: 'document' as const, maxBytes: 10 * 1024 * 1024, maxImagePixels: 50_000_000, allowPdf: true };

type PropertyCreateFiles = {
  images?: Express.Multer.File[];
  entranceImage?: Express.Multer.File[];
  titleDeed?: Express.Multer.File[];
};

type PropertyAttribution = {
  actorId: Types.ObjectId;
  advertiserId: Types.ObjectId;
  accountType: AccountType;
};

@Injectable()
export class PropertiesService {
  constructor(
    @InjectModel(Property.name) private readonly properties: Model<PropertyDocument>,
    @InjectModel(PropertyRevision.name) private readonly revisions: Model<PropertyRevisionDocument>,
    @InjectModel(PropertyType.name) private readonly propertyTypes: Model<PropertyTypeDocument>,
    @InjectModel(PropertyPurposeCategory.name) private readonly purposeCategories: Model<PropertyPurposeCategoryDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Amenity.name) private readonly amenities: Model<AmenityDocument>,
    @InjectModel(PropertyOption.name) private readonly options: Model<PropertyOptionDocument>,
    @InjectModel(Governorate.name) private readonly governorates: Model<GovernorateDocument>,
    @Inject(CLOUDINARY) private readonly cloudinary: typeof Cloudinary,
    private readonly evidenceAssets: CloudinaryAssetService,
    private readonly audit: AuditLogService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async create(actorId: string, dto: CreatePropertyDto, files: PropertyCreateFiles, ip?: string) {
    return this.createSelf(actorId, dto, files, ip);
  }

  async createSelf(actorId: string, dto: CreatePropertyDto, files: PropertyCreateFiles, ip?: string) {
    const attribution = await this.resolveAdvertiser(actorId, actorId, false);
    return this.createWithAttribution(attribution, dto, files, ip);
  }

  async createForAdmin(actorId: string, advertiserAccountId: string, dto: CreatePropertyDto, files: PropertyCreateFiles, ip?: string) {
    const attribution = await this.resolveAdvertiser(actorId, advertiserAccountId, true);
    return this.createWithAttribution(attribution, dto, files, ip);
  }

  private async createWithAttribution(attribution: PropertyAttribution, dto: CreatePropertyDto, files: PropertyCreateFiles, ip?: string) {
    if (!isMoneyMinorAmount(dto.totalPriceMinor, { positive: true }) || (dto.currency && dto.currency !== EGP_CURRENCY)) {
      throw new BadRequestException('بيانات السعر يجب أن تكون أعدادًا صحيحة بوحدات العملة الصغرى ضمن النطاق الآمن');
    }
    if (dto.downPaymentMinor !== undefined || dto.downPayment !== undefined || dto.paymentMethodCode !== undefined) {
      throw new BadRequestException({ message: 'حقول المقدم وطريقة السداد المفردة غير مقبولة في عقد العقار الجديد', code: PropertyErrorCode.LEGACY_INPUT_NOT_ACCEPTED });
    }
    if (!Object.values(PropertyMarketingMode).includes(dto.marketingMode)) {
      throw new BadRequestException({ message: 'وضع التسويق غير صالح', code: PropertyErrorCode.MARKETING_MODE_INVALID });
    }
    if (!Array.isArray(dto.paymentMethodCodes) || dto.paymentMethodCodes.length === 0 || new Set(dto.paymentMethodCodes).size !== dto.paymentMethodCodes.length) {
      throw new BadRequestException({ message: 'يجب اختيار طرق سداد صالحة وغير مكررة', code: PropertyErrorCode.PAYMENT_METHODS_INVALID });
    }
    const images = files?.images ?? [];
    if (!images.length) throw new BadRequestException('يجب إرفاق صورة واحدة للعقار على الأقل');
    if (images.length > 20) throw new BadRequestException({ message: 'عدد صور العقار يتجاوز الحد المسموح', code: EvidenceErrorCode.FILE_COUNT_EXCEEDED });
    if (dto.imageLabels.length !== images.length) throw new BadRequestException('عدد مسميات الصور لا يطابق عدد الصور');
    if (dto.coverImageIndex >= images.length) throw new BadRequestException('صورة الغلاف المحددة غير صالحة');
    if (dto.floor > dto.totalFloors) throw new BadRequestException('رقم الطابق لا يمكن أن يتجاوز عدد الطوابق');
    const detectedImages = images.map((image) => validateEvidenceFile(image, PROPERTY_IMAGE_POLICY));
    const entranceFile = files.entranceImage?.[0];
    const detectedEntrance = entranceFile ? validateEvidenceFile(entranceFile, PROPERTY_IMAGE_POLICY) : undefined;
    const deedFile = files.titleDeed?.[0];
    const detectedDeed = deedFile ? validateEvidenceFile(deedFile, PROPERTY_EVIDENCE_POLICY) : undefined;

    const [purpose, type, governorate, finishing, delivery, payments, amenityCount] = await Promise.all([
      this.purposeCategories.findOne({ _id: dto.purposeCategoryId, isActive: true }).lean().exec(),
      this.propertyTypes.findOne({ _id: dto.purposeSubcategoryId, isActive: true }).lean().exec(),
      this.governorates.findOne({ code: dto.governorateCode, isActive: true }).lean().exec(),
      this.options.findOne({ group: 'finishing_status', code: dto.finishingStatusCode, isActive: true }).lean().exec(),
      this.options.findOne({ group: 'delivery_status', code: dto.deliveryStatusCode, isActive: true }).lean().exec(),
      this.options.find({ group: 'payment_method', code: { $in: dto.paymentMethodCodes }, isActive: true }).lean().exec(),
      this.amenities.countDocuments({ code: { $in: dto.amenityCodes }, isActive: true }).exec(),
    ]);
    if (!purpose) throw new BadRequestException({ message: 'غرض العقار غير موجود أو غير متاح', code: PropertyErrorCode.PURPOSE_CATEGORY_INVALID });
    if (!type) throw new BadRequestException({ message: 'نوع العقار الفرعي غير موجود أو غير متاح', code: PropertyErrorCode.PURPOSE_SUBCATEGORY_INVALID });
    if (!type.purposeCategoryId || type.purposeCategoryId.toString() !== purpose._id.toString()) {
      throw new BadRequestException({ message: 'نوع العقار الفرعي لا يتبع غرض العقار المحدد', code: PropertyErrorCode.PURPOSE_HIERARCHY_MISMATCH });
    }
    if (payments.length !== dto.paymentMethodCodes.length) {
      throw new BadRequestException({ message: 'إحدى طرق السداد غير موجودة أو غير متاحة', code: PropertyErrorCode.PAYMENT_METHODS_INVALID });
    }
    const invalid = [!governorate && 'المحافظة', !finishing && 'حالة التشطيب', !delivery && 'جاهزية التسليم'].filter(Boolean);
    if (invalid.length || amenityCount !== dto.amenityCodes.length) throw new BadRequestException(`بعض الاختيارات غير موجودة أو غير متاحة: ${invalid.join('، ')}${amenityCount !== dto.amenityCodes.length ? `${invalid.length ? '، ' : ''}المميزات والخدمات` : ''}`);

    const uploadedPublic: PropertyAsset[] = [];
    let entranceImageAsset: PropertyAsset | undefined;
    let titleDeed: PropertyAsset | undefined;
    let createdPropertyId: Types.ObjectId | undefined;
    let createdRevisionId: Types.ObjectId | undefined;
    try {
      for (let i = 0; i < images.length; i++) {
        uploadedPublic.push({
          ...(await this.uploadPublicImage(images[i], detectedImages[i].format)),
          label: dto.imageLabels[i],
        });
      }
      if (entranceFile && detectedEntrance) {
        entranceImageAsset = await this.uploadPublicImage(entranceFile, detectedEntrance.format);
      }
      if (deedFile && detectedDeed) {
        titleDeed = await this.evidenceAssets.uploadPrivateEvidence(
          deedFile,
          'properties/title-deeds',
          AssetClassification.PRIVATE_PROPERTY_EVIDENCE,
          detectedDeed,
        ) as PropertyAsset;
      }

      const propertyId = new Types.ObjectId();
      const revisionId = new Types.ObjectId();
      const now = new Date();
      const legacyAdvertiserType = this.legacyAdvertiserType(attribution.accountType);
      const revisionContent = {
        propertyId,
        revisionNumber: 1,
        createdByActorId: attribution.actorId,
        operationType: dto.operationType,
        purposeCategoryId: purpose._id,
        purposeSubcategoryId: type._id,
        legacyPropertyTypeCode: type.code,
        title: dto.title,
        description: dto.description,
        governorateCode: dto.governorateCode,
        city: dto.city,
        district: dto.district,
        street: dto.street,
        additionalAddressDetails: dto.additionalAddressDetails,
        latitude: dto.latitude,
        longitude: dto.longitude,
        area: dto.area,
        bedrooms: dto.bedrooms,
        livingRooms: dto.livingRooms,
        kitchens: dto.kitchens,
        bathrooms: dto.bathrooms,
        floor: dto.floor,
        totalFloors: dto.totalFloors,
        buildingYear: dto.buildingYear,
        finishingStatusCode: dto.finishingStatusCode,
        deliveryStatusCode: dto.deliveryStatusCode,
        amenityCodes: dto.amenityCodes,
        totalPriceMinor: dto.totalPriceMinor,
        currency: EGP_CURRENCY,
        isPriceNegotiable: dto.isPriceNegotiable,
        paymentMethodCodes: [...dto.paymentMethodCodes].sort(),
        marketingMode: dto.marketingMode,
        entranceImageAsset,
        galleryMedia: uploadedPublic,
        privateEvidenceAssets: titleDeed ? [titleDeed] : [],
        coverImageIndex: dto.coverImageIndex,
        hidePhone: dto.hidePhone,
        moderationStatus: PropertyRevisionModerationStatus.PENDING_REVIEW,
        submittedAt: now,
      };
      const legacyProperty = {
        _id: propertyId,
        ownerId: attribution.advertiserId,
        advertiserAccountId: attribution.advertiserId,
        advertiserAccountTypeSnapshot: attribution.accountType,
        createdByActorId: attribution.actorId,
        pendingRevisionId: revisionId,
        revisionSequence: 1,
        propertyContractVersion: 1,
        operationType: dto.operationType,
        propertyTypeCode: type.code,
        title: dto.title,
        description: dto.description,
        governorateCode: dto.governorateCode,
        city: dto.city,
        district: dto.district,
        street: dto.street,
        additionalAddressDetails: dto.additionalAddressDetails,
        latitude: dto.latitude,
        longitude: dto.longitude,
        area: dto.area,
        bedrooms: dto.bedrooms,
        livingRooms: dto.livingRooms,
        kitchens: dto.kitchens,
        bathrooms: dto.bathrooms,
        floor: dto.floor,
        totalFloors: dto.totalFloors,
        buildingYear: dto.buildingYear,
        finishingStatusCode: dto.finishingStatusCode,
        deliveryStatusCode: dto.deliveryStatusCode,
        amenityCodes: dto.amenityCodes,
        totalPriceMinor: dto.totalPriceMinor,
        currency: EGP_CURRENCY,
        isPriceNegotiable: dto.isPriceNegotiable,
        paymentMethodCode: [...dto.paymentMethodCodes].sort()[0],
        images: uploadedPublic,
        coverImageIndex: dto.coverImageIndex,
        titleDeed,
        advertiserType: legacyAdvertiserType,
        hidePhone: dto.hidePhone,
        status: 'pending_review',
      };
      const session = await this.connection.startSession();
      let property!: PropertyDocument;
      try {
        await session.withTransaction(async () => {
          [property] = await this.properties.create([legacyProperty], { session });
          await this.revisions.create([{ _id: revisionId, ...revisionContent }], { session });
          const [purposeUsage, typeUsage, governorateUsage, optionUsage, amenityUsage] = await Promise.all([
            this.purposeCategories.updateOne({ _id: purpose._id, isActive: true }, { $inc: { usageCount: 1 } }, { session }).exec(),
            this.propertyTypes.updateOne({ _id: type._id, purposeCategoryId: purpose._id, isActive: true }, { $inc: { usageCount: 1 } }, { session }).exec(),
            this.governorates.updateOne({ code: dto.governorateCode, isActive: true }, { $inc: { usageCount: 1 } }, { session }).exec(),
            this.options.updateMany({ $or: [
              { group: 'finishing_status', code: dto.finishingStatusCode, isActive: true },
              { group: 'delivery_status', code: dto.deliveryStatusCode, isActive: true },
              { group: 'payment_method', code: { $in: dto.paymentMethodCodes }, isActive: true },
            ] }, { $inc: { usageCount: 1 } }, { session }).exec(),
            dto.amenityCodes.length ? this.amenities.updateMany({ code: { $in: dto.amenityCodes }, isActive: true }, { $inc: { usageCount: 1 } }, { session }).exec() : Promise.resolve({ matchedCount: 0 }),
          ]);
          if (purposeUsage.matchedCount !== 1 || typeUsage.matchedCount !== 1) {
            throw new BadRequestException({ message: 'تم تغيير تصنيف غرض العقار؛ أعد تحميل الخيارات', code: PropertyErrorCode.PURPOSE_HIERARCHY_MISMATCH });
          }
          if (governorateUsage.matchedCount !== 1 || optionUsage.matchedCount !== dto.paymentMethodCodes.length + 2 || amenityUsage.matchedCount !== dto.amenityCodes.length) {
            throw new BadRequestException({ message: 'تم تغيير أحد خيارات العقار؛ أعد تحميل الخيارات', code: PropertyErrorCode.CATALOG_VALUE_INVALID });
          }
        });
      } finally {
        await session.endSession();
      }
      createdPropertyId = property!._id;
      createdRevisionId = revisionId;
      if (titleDeed) {
        await this.audit.logResourceAction(AuditAction.PRIVATE_EVIDENCE_UPLOADED, attribution.actorId.toString(), property!._id.toString(), 'property-title-deed', ip);
      }
      if (!attribution.actorId.equals(attribution.advertiserId)) {
        await this.audit.logAdminResourceAction(
          AuditAction.ADMIN_PROPERTY_PROXY_CREATED,
          attribution.actorId.toString(),
          property!._id.toString(),
          `created for advertiser ${attribution.advertiserId.toString()} as ${attribution.accountType}`,
          ip,
        );
      }
      return { message: 'تم إرسال العقار للمراجعة بنجاح', property: this.toPublic({ ...property!.toObject(), pendingRevisionId: { _id: revisionId, ...revisionContent } }) };
    } catch (error) {
      if (createdPropertyId) await this.properties.deleteOne({ _id: createdPropertyId }).exec().catch(() => undefined);
      if (createdRevisionId) await this.revisions.deleteOne({ _id: createdRevisionId }).exec().catch(() => undefined);
      await Promise.allSettled(uploadedPublic.map(asset => this.cloudinary.uploader.destroy(asset.publicId, { resource_type: asset.resourceType, type: 'upload', invalidate: true })));
      if (entranceImageAsset) await this.cloudinary.uploader.destroy(entranceImageAsset.publicId, { resource_type: entranceImageAsset.resourceType, type: 'upload', invalidate: true }).catch(() => undefined);
      if (titleDeed) await this.evidenceAssets.deleteOrEnqueue([titleDeed as StoredAssetMetadata], 'property-create-failed');
      throw error;
    }
  }

  private async resolveAdvertiser(actorId: string, advertiserId: string, proxy: boolean): Promise<PropertyAttribution> {
    if (!Types.ObjectId.isValid(actorId) || !Types.ObjectId.isValid(advertiserId)) {
      throw new BadRequestException({ message: 'حساب المعلن غير صالح', code: PropertyErrorCode.ADVERTISER_INVALID });
    }
    const ids = actorId === advertiserId ? [actorId] : [actorId, advertiserId];
    const accounts = await this.users.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }).lean().exec();
    const actor = accounts.find((item) => item._id.toString() === actorId);
    const advertiser = accounts.find((item) => item._id.toString() === advertiserId);
    if (!actor || !advertiser) throw new NotFoundException({ message: 'حساب المعلن غير موجود', code: PropertyErrorCode.ADVERTISER_INVALID });
    const accountType = AuthorizationPolicyService.assertPropertyAttribution(actor, advertiser, proxy);
    return { actorId: new Types.ObjectId(actorId), advertiserId: new Types.ObjectId(advertiserId), accountType };
  }

  private legacyAdvertiserType(accountType: AccountType): 'owner' | 'broker' | 'office' {
    if (accountType === AccountType.BROKER) return 'broker';
    if (accountType === AccountType.COMPANY) return 'office';
    return 'owner';
  }

  async listMine(ownerId: string) {
    const accountId = new Types.ObjectId(ownerId);
    const items = await this.properties.find({ $or: [{ advertiserAccountId: accountId }, { advertiserAccountId: { $exists: false }, ownerId: accountId }] }).sort({ createdAt: -1 }).populate('pendingRevisionId').populate('currentPublicRevisionId').lean().exec();
    return { items: items.map(i => this.toPublic(i)) };
  }
  async getMine(ownerId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف العقار غير صالح');
    const accountId = new Types.ObjectId(ownerId);
    const item = await this.properties.findOne({ _id: id, $or: [{ advertiserAccountId: accountId }, { advertiserAccountId: { $exists: false }, ownerId: accountId }] }).populate('pendingRevisionId').populate('currentPublicRevisionId').lean().exec();
    if (!item) throw new NotFoundException('العقار غير موجود');
    return { property: this.toPublic(item) };
  }
  async listPublished(options: { page?: number; limit?: number }) {
    const page = Number.isFinite(options.page) ? Math.max(options.page!, 1) : 1;
    const limit = Number.isFinite(options.limit) ? Math.min(Math.max(options.limit!, 1), 50) : 20;
    const filter = { status: 'approved', isOwnerVisible: { $ne: false } };
    const [items, total] = await Promise.all([
      this.properties.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('currentPublicRevisionId').lean().exec(),
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
      { _id: id, $or: [{ advertiserAccountId: new Types.ObjectId(ownerId) }, { advertiserAccountId: { $exists: false }, ownerId: new Types.ObjectId(ownerId) }] },
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
      this.properties.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('ownerId', 'fullName email phone').populate('advertiserAccountId', 'fullName email phone accountType').populate('pendingRevisionId').populate('currentPublicRevisionId').lean().exec(),
      this.properties.countDocuments(filter).exec(),
    ]);
    return { items: items.map(item => this.toAdmin(item)), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getForAdmin(id: string) {
    this.assertId(id);
    const item = await this.properties.findById(id).populate('ownerId', 'fullName email phone').populate('advertiserAccountId', 'fullName email phone accountType').populate('pendingRevisionId').populate('currentPublicRevisionId').lean().exec();
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
    const accountId = new Types.ObjectId(ownerId);
    const item = await this.properties.findOne({
      _id: id,
      $or: [
        { advertiserAccountId: accountId },
        { advertiserAccountId: { $exists: false }, ownerId: accountId },
      ],
    }).lean().exec();
    if (!item) throw new NotFoundException({ message: 'العقار غير موجود', code: EvidenceErrorCode.NOT_FOUND });
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

  private effectiveRevision(item: any) {
    const candidate = item.status === 'approved' ? item.currentPublicRevisionId : item.pendingRevisionId;
    return candidate && typeof candidate === 'object' && (candidate.title || candidate.revisionNumber) ? candidate : undefined;
  }

  private toPublic(item: any) {
    const revision = this.effectiveRevision(item);
    const source = revision ?? item;
    const money = revision
      ? { totalPriceMinor: revision.totalPriceMinor, currency: revision.currency }
      : item.propertyContractVersion >= 1 && isMoneyMinorAmount(item.totalPriceMinor, { positive: true }) && item.currency === EGP_CURRENCY
        ? { totalPriceMinor: item.totalPriceMinor, currency: EGP_CURRENCY }
        : propertyMoneyFromStoredRecord(item);
    const entrance = revision?.entranceImageAsset?.url ? { url: revision.entranceImageAsset.url, label: revision.entranceImageAsset.label } : undefined;
    return {
      id: item._id.toString(),
      revisionId: revision?._id?.toString(),
      revisionNumber: revision?.revisionNumber,
      advertiserAccountId: item.advertiserAccountId?._id?.toString?.() ?? item.advertiserAccountId?.toString?.() ?? item.ownerId?._id?.toString?.() ?? item.ownerId?.toString?.(),
      advertiserAccountTypeSnapshot: item.advertiserAccountTypeSnapshot,
      createdByActorId: item.createdByActorId?.toString?.(),
      operationType: source.operationType,
      purposeCategoryId: revision?.purposeCategoryId?.toString?.(),
      purposeSubcategoryId: revision?.purposeSubcategoryId?.toString?.(),
      propertyTypeCode: source.legacyPropertyTypeCode ?? item.propertyTypeCode,
      title: source.title,
      description: source.description,
      governorateCode: source.governorateCode,
      city: source.city,
      district: source.district,
      area: source.area,
      bedrooms: source.bedrooms,
      bathrooms: source.bathrooms,
      floor: source.floor,
      ...money,
      paymentMethodCodes: revision?.paymentMethodCodes,
      marketingMode: revision?.marketingMode,
      entranceImage: entrance,
      images: this.publicImages(revision?.galleryMedia ?? item.images),
      coverImageIndex: source.coverImageIndex,
      hasTitleDeed: Boolean(revision?.privateEvidenceAssets?.length || item.titleDeed?.publicId),
      advertiserType: item.advertiserType,
      isOwnerVisible: item.isOwnerVisible !== false,
      status: revision?.moderationStatus ?? item.status,
      reviewReason: revision?.reviewReason ?? item.reviewReason,
      reviewedAt: revision?.reviewedAt ?? item.reviewedAt,
      createdAt: item.createdAt,
    };
  }
  private toAdmin(item: any, detailed = false) {
    const account = item.advertiserAccountId && typeof item.advertiserAccountId === 'object' && item.advertiserAccountId.fullName ? item.advertiserAccountId : item.ownerId;
    const populatedOwner = account && typeof account === 'object' && account.fullName;
    const owner = populatedOwner ? { id: account._id.toString(), fullName: account.fullName, email: account.email, phone: account.phone } : undefined;
    const revision = this.effectiveRevision(item);
    const source = revision ?? item;
    const base = { ...this.toPublic(item), owner, reviewReason: item.reviewReason, reviewedAt: item.reviewedAt };
    return detailed ? { ...base, street: source.street, additionalAddressDetails: source.additionalAddressDetails, latitude: source.latitude, longitude: source.longitude, bedrooms: source.bedrooms, livingRooms: source.livingRooms, kitchens: source.kitchens, bathrooms: source.bathrooms, floor: source.floor, totalFloors: source.totalFloors, buildingYear: source.buildingYear, finishingStatusCode: source.finishingStatusCode, deliveryStatusCode: source.deliveryStatusCode, amenityCodes: source.amenityCodes, isPriceNegotiable: source.isPriceNegotiable, paymentMethodCodes: revision?.paymentMethodCodes, paymentMethodCode: item.paymentMethodCode, hasTitleDeed: Boolean(revision?.privateEvidenceAssets?.length || item.titleDeed?.publicId), advertiserType: item.advertiserType, hidePhone: source.hidePhone } : base;
  }
}
