import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { Amenity, AmenityDocument } from '../amenities/schemas/amenity.schema';
import { Governorate, GovernorateDocument } from '../governorates/schemas/governorate.schema';
import { City, CityDocument } from '../governorates/schemas/city.schema';
import { PropertyOption, PropertyOptionDocument } from '../property-options/schemas/property-option.schema';
import { PropertyType, PropertyTypeDocument } from '../property-types/schemas/property-type.schema';
import { CreatePropertyDto } from './dto/create-property.dto';
import { ListPublishedPropertiesDto } from './dto/list-published-properties.dto';
import { Property, PropertyAsset, PropertyDocument } from './schemas/property.schema';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { EGP_CURRENCY, isMoneyMinorAmount, propertyMoneyFromStoredRecord } from '../common/money/money';
import { DetectedEvidenceFile, validateEvidenceFile } from '../common/uploads/evidence-file.validator';
import { EvidenceErrorCode } from '../common/errors/evidence-error-codes';
import { AssetClassification, StoredAssetMetadata } from '../config/evidence-asset.types';
import { CloudinaryAssetService } from '../config/cloudinary-asset.service';
import { PropertyRevision, PropertyRevisionDocument } from './schemas/property-revision.schema';
import { PropertyPurposeCategory, PropertyPurposeCategoryDocument } from '../property-purpose-categories/schemas/property-purpose-category.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { AccountType } from '../users/identity.types';
import { PropertyLifecycleStatus, PropertyMarketingMode, PropertyMediaOrigin, PropertyMediaTagCode, PropertyRevisionModerationStatus } from './property.types';
import { PropertyErrorCode } from '../common/errors/property-error-codes';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';
import { PropertyAuctionLockService } from './property-auction-lock.service';
import { IdempotencyService, canonicalize, sha256 } from '../common/idempotency/idempotency.service';
import { hasClearGovernorateConflict, isPointInsideEgypt } from '../common/validators/egypt-location.validator';

const PROPERTY_IMAGE_POLICY = { kind: 'image' as const, maxBytes: 10 * 1024 * 1024, maxImagePixels: 50_000_000 };
const PROPERTY_EVIDENCE_POLICY = { kind: 'document' as const, maxBytes: 10 * 1024 * 1024, maxImagePixels: 50_000_000, allowPdf: true };

type PropertyCreateFiles = {
  images?: Express.Multer.File[];
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
    @InjectModel(City.name) private readonly cities: Model<CityDocument>,
    private readonly evidenceAssets: CloudinaryAssetService,
    private readonly audit: AuditLogService,
    @InjectConnection() private readonly connection: Connection,
    private readonly auctionLock: PropertyAuctionLockService,
    @Optional() private readonly idempotency?: IdempotencyService,
  ) {}

  /** Digest of everything that defines a create/revision request, including file bytes. */
  private requestFingerprint(target: string, dto: CreatePropertyDto, files: PropertyCreateFiles): string {
    const digest = (list?: Express.Multer.File[]) =>
      (list ?? []).map((file) => `${file.fieldname}:${file.mimetype}:${sha256(file.buffer)}`);
    return sha256(canonicalize({ target, dto, images: digest(files?.images), titleDeed: digest(files?.titleDeed) }));
  }

  async create(actorId: string, dto: CreatePropertyDto, files: PropertyCreateFiles, ip?: string) {
    return this.createSelf(actorId, dto, files, ip);
  }

  async createSelf(actorId: string, dto: CreatePropertyDto, files: PropertyCreateFiles, ip?: string, idempotencyKey?: string) {
    const run = async () => {
      const attribution = await this.resolveAdvertiser(actorId, actorId, false);
      return this.createWithAttribution(attribution, dto, files, ip);
    };
    if (!this.idempotency) return run();
    return this.idempotency.execute(
      { scope: 'property.create', accountId: actorId, key: idempotencyKey, fingerprint: () => this.requestFingerprint('new', dto, files) },
      run,
    );
  }

  async createForAdmin(actorId: string, advertiserAccountId: string, dto: CreatePropertyDto, files: PropertyCreateFiles, ip?: string) {
    const attribution = await this.resolveAdvertiser(actorId, advertiserAccountId, true);
    return this.createWithAttribution(attribution, dto, files, ip);
  }

  async createDraftRevision(actorId: string, propertyId: string, dto: CreatePropertyDto, files: PropertyCreateFiles, ip?: string, idempotencyKey?: string) {
    this.assertId(propertyId);
    if (!this.idempotency) return this.createDraftRevisionOnce(actorId, propertyId, dto, files, ip);
    return this.idempotency.execute(
      { scope: 'property.revision', accountId: actorId, key: idempotencyKey, fingerprint: () => this.requestFingerprint(propertyId, dto, files) },
      () => this.createDraftRevisionOnce(actorId, propertyId, dto, files, ip),
    );
  }

  private async createDraftRevisionOnce(actorId: string, propertyId: string, dto: CreatePropertyDto, files: PropertyCreateFiles, ip?: string) {
    await this.auctionLock.assertUnlocked(propertyId);
    const accountId = new Types.ObjectId(actorId);
    const property = await this.properties.findOne({ _id: propertyId, lifecycleStatus: { $nin: [PropertyLifecycleStatus.ARCHIVED, PropertyLifecycleStatus.ADMIN_HIDDEN] }, $or: [{ advertiserAccountId: accountId }, { advertiserAccountId: { $exists: false }, ownerId: accountId }] }).lean().exec();
    if (!property) throw new NotFoundException('العقار غير موجود أو غير قابل للتعديل');
    if (property.pendingRevisionId) throw new ConflictException({ message: 'يوجد تعديل قيد المراجعة بالفعل', code: PropertyErrorCode.PENDING_REVISION_EXISTS });
    const existingDraft = await this.revisions.findOne({ propertyId: property._id, moderationStatus: PropertyRevisionModerationStatus.DRAFT }).exec();
    const attribution = await this.resolveAdvertiser(actorId, (property.advertiserAccountId ?? property.ownerId).toString(), false);
    return this.createWithAttribution(attribution, dto, files, ip, property, existingDraft);
  }

  async createDraftRevisionForAdmin(actorId: string, propertyId: string, dto: CreatePropertyDto, files: PropertyCreateFiles, ip?: string) {
    this.assertId(propertyId);
    await this.auctionLock.assertUnlocked(propertyId);
    const property = await this.properties.findOne({ _id: propertyId, lifecycleStatus: { $nin: [PropertyLifecycleStatus.ARCHIVED, PropertyLifecycleStatus.ADMIN_HIDDEN] } }).lean().exec();
    if (!property) throw new NotFoundException('العقار غير موجود أو غير قابل للتعديل');
    if (property.pendingRevisionId) throw new ConflictException({ message: 'توجد نسخة قيد المراجعة بالفعل', code: PropertyErrorCode.PENDING_REVISION_EXISTS });
    const existingDraft = await this.revisions.findOne({ propertyId: property._id, moderationStatus: PropertyRevisionModerationStatus.DRAFT }).exec();
    const advertiserId = (property.advertiserAccountId ?? property.ownerId).toString();
    const attribution = await this.resolveAdvertiser(actorId, advertiserId, true);
    return this.createWithAttribution(attribution, dto, files, ip, property, existingDraft);
  }

  private async createWithAttribution(attribution: PropertyAttribution, dto: CreatePropertyDto, files: PropertyCreateFiles, ip?: string, existingProperty?: any, existingDraft?: any) {
    if (!isPointInsideEgypt(dto.latitude, dto.longitude)) {
      throw new BadRequestException({ message: 'يجب أن يكون موقع العقار داخل مصر', code: 'PROPERTY_LOCATION_OUTSIDE_EGYPT' });
    }
    if (existingDraft && dto.expectedRevisionVersion !== (existingDraft.decisionVersion ?? 0)) {
      throw new ConflictException({ message: 'تغيرت المسودة؛ أعد تحميل العقار قبل الحفظ', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
    }
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
    const customerPhotosRequired = dto.marketingMode === PropertyMarketingMode.SELF_SERVICE;
    if (customerPhotosRequired && !images.length) {
      throw new BadRequestException({ message: 'صور العقار مطلوبة عند اختيار التسويق الذاتي', code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING });
    }
    if (images.length > 20) throw new BadRequestException({ message: 'عدد صور العقار يتجاوز الحد المسموح', code: EvidenceErrorCode.FILE_COUNT_EXCEEDED });
    if (dto.imageLabels.length !== images.length) throw new BadRequestException('عدد مسميات الصور لا يطابق عدد الصور');
    if (!Array.isArray(dto.imageSlotIds) || dto.imageSlotIds.length !== images.length || new Set(dto.imageSlotIds).size !== dto.imageSlotIds.length) {
      throw new BadRequestException({ message: 'تصنيفات صور العقار غير صالحة', code: EvidenceErrorCode.REQUIRED_PHOTO_SLOTS_MISSING });
    }
    const requiredPhotoSlots = this.requiredPhotoSlots(dto);
    const suppliedPhotoSlots = new Set(dto.imageSlotIds);
    const missingPhotoSlots = requiredPhotoSlots.filter((slotId) => !suppliedPhotoSlots.has(slotId));
    const invalidPhotoSlots = dto.imageSlotIds.filter((slotId) => !requiredPhotoSlots.includes(slotId) && !/^additional_[1-9]\d*$/.test(slotId));
    if ((customerPhotosRequired && missingPhotoSlots.length) || invalidPhotoSlots.length) {
      throw new BadRequestException({
        message: 'يجب استكمال جميع فئات صور العقار المطلوبة',
        code: EvidenceErrorCode.REQUIRED_PHOTO_SLOTS_MISSING,
        missingPhotoSlots,
        invalidPhotoSlots,
      });
    }
    const seenRequiredPhotoContent = new Map<string, string>();
    const duplicatePhotoSlots: string[] = [];
    for (const slotId of requiredPhotoSlots.filter(slotId => suppliedPhotoSlots.has(slotId))) {
      const index = dto.imageSlotIds.indexOf(slotId);
      const digest = createHash('sha256').update(images[index].buffer).digest('hex');
      const firstSlot = seenRequiredPhotoContent.get(digest);
      if (firstSlot) duplicatePhotoSlots.push(firstSlot, slotId);
      else seenRequiredPhotoContent.set(digest, slotId);
    }
    if (duplicatePhotoSlots.length) {
      throw new BadRequestException({
        message: 'يجب استخدام صورة مستقلة لكل قسم مطلوب',
        code: EvidenceErrorCode.PHOTO_SLOT_MEDIA_DUPLICATED,
        duplicatePhotoSlots: [...new Set(duplicatePhotoSlots)],
      });
    }
    if (images.length ? dto.coverImageIndex >= images.length : dto.coverImageIndex !== 0) {
      throw new BadRequestException('صورة الغلاف المحددة غير صالحة');
    }
    if (dto.floor > dto.totalFloors) throw new BadRequestException('رقم الطابق لا يمكن أن يتجاوز عدد الطوابق');
    const detectedImages = images.map((image) => validateEvidenceFile(image, PROPERTY_IMAGE_POLICY));
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
    const city = governorate
      ? await this.cities.findOne({ governorateId: governorate._id, nameAr: dto.city.trim(), isActive: true }).lean().exec()
      : null;
    const storedLegacyCity = existingDraft?.city ?? existingProperty?.city;
    const legacyCityAllowed = Boolean(existingProperty && typeof storedLegacyCity === 'string' && storedLegacyCity.trim() === dto.city.trim());
    if (!purpose) throw new BadRequestException({ message: 'غرض العقار غير موجود أو غير متاح', code: PropertyErrorCode.PURPOSE_CATEGORY_INVALID });
    if (!type) throw new BadRequestException({ message: 'نوع العقار الفرعي غير موجود أو غير متاح', code: PropertyErrorCode.PURPOSE_SUBCATEGORY_INVALID });
    if (!type.purposeCategoryId || type.purposeCategoryId.toString() !== purpose._id.toString()) {
      throw new BadRequestException({ message: 'نوع العقار الفرعي لا يتبع غرض العقار المحدد', code: PropertyErrorCode.PURPOSE_HIERARCHY_MISMATCH });
    }
    if (governorate && !city && !legacyCityAllowed) {
      throw new BadRequestException({ message: 'المدينة غير موجودة أو لا تتبع المحافظة المحددة', code: PropertyErrorCode.CATALOG_VALUE_INVALID });
    }
    if (governorate && hasClearGovernorateConflict(dto.latitude, dto.longitude, dto.governorateCode)) {
      throw new BadRequestException({ message: 'إحداثيات العقار لا تتوافق مع المحافظة المحددة', code: 'PROPERTY_LOCATION_GOVERNORATE_MISMATCH' });
    }
    if (payments.length !== dto.paymentMethodCodes.length) {
      throw new BadRequestException({ message: 'إحدى طرق السداد غير موجودة أو غير متاحة', code: PropertyErrorCode.PAYMENT_METHODS_INVALID });
    }
    const invalid = [!governorate && 'المحافظة', !finishing && 'حالة التشطيب', !delivery && 'جاهزية التسليم'].filter(Boolean);
    if (invalid.length || amenityCount !== dto.amenityCodes.length) throw new BadRequestException(`بعض الاختيارات غير موجودة أو غير متاحة: ${invalid.join('، ')}${amenityCount !== dto.amenityCodes.length ? `${invalid.length ? '، ' : ''}المميزات والخدمات` : ''}`);

    const uploadedPublic: PropertyAsset[] = [];
    let titleDeed: PropertyAsset | undefined;
    let createdPropertyId: Types.ObjectId | undefined;
    let createdRevisionId: Types.ObjectId | undefined;
    try {
      for (let i = 0; i < images.length; i++) {
        uploadedPublic.push({
          ...(await this.uploadPublicImage(images[i], detectedImages[i])),
          label: dto.imageLabels[i],
          slotId: dto.imageSlotIds[i],
          tagCode: this.mediaTagFromGuidedSlot(dto.imageSlotIds[i]),
          origin: PropertyMediaOrigin.ADVERTISER,
          sortOrder: i,
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

      const propertyId = existingProperty?._id ?? new Types.ObjectId();
      const revisionId = existingDraft?._id ?? new Types.ObjectId();
      const now = new Date();
      const revisionNumber = existingDraft?.revisionNumber ?? (existingProperty ? (existingProperty.revisionSequence ?? 1) + 1 : 1);
      const legacyAdvertiserType = this.legacyAdvertiserType(attribution.accountType);
      const revisionContent = {
        propertyId,
        revisionNumber,
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
        galleryMedia: uploadedPublic,
        privateEvidenceAssets: titleDeed ? [titleDeed] : [],
        coverImageIndex: dto.coverImageIndex,
        hidePhone: dto.hidePhone,
        moderationStatus: PropertyRevisionModerationStatus.DRAFT,
        decisionVersion: 0,
      };
      const legacyProperty = {
        _id: propertyId,
        ownerId: attribution.advertiserId,
        advertiserAccountId: attribution.advertiserId,
        advertiserAccountTypeSnapshot: attribution.accountType,
        createdByActorId: attribution.actorId,
        revisionSequence: 1,
        lifecycleStatus: PropertyLifecycleStatus.ACTIVE,
        lifecycleVersion: 0,
        propertyContractVersion: 1,
        operationType: dto.operationType,
        purposeCategoryId: purpose._id,
        purposeSubcategoryId: type._id,
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
          if (existingProperty && !existingDraft) {
            property = await this.properties.findOneAndUpdate(
              { _id: propertyId, revisionSequence: existingProperty.revisionSequence, pendingRevisionId: { $exists: false }, lifecycleStatus: { $nin: [PropertyLifecycleStatus.ARCHIVED, PropertyLifecycleStatus.ADMIN_HIDDEN] } },
              { $inc: { revisionSequence: 1 } },
              { new: true, session },
            ).exec() as PropertyDocument;
            if (!property) throw new ConflictException({ message: 'تغير العقار أثناء إنشاء المسودة', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
          } else if (!existingProperty) {
            [property] = await this.properties.create([legacyProperty], { session });
          } else {
            property = existingProperty as PropertyDocument;
          }
          if (existingDraft) {
            const replacement = { ...revisionContent } as any;
            delete replacement.propertyId;
            delete replacement.revisionNumber;
            delete replacement.createdByActorId;
            delete replacement.decisionVersion;
            const draftDocument = await this.revisions.findOne({ _id: revisionId, propertyId, moderationStatus: PropertyRevisionModerationStatus.DRAFT, decisionVersion: existingDraft.decisionVersion ?? 0 }).session(session).exec();
            if (!draftDocument) throw new ConflictException({ message: 'تغيرت المسودة أثناء الحفظ', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
            draftDocument.supersededAssets.push(...(draftDocument.galleryMedia ?? []), ...(draftDocument.privateEvidenceAssets ?? []));
            draftDocument.set(replacement);
            draftDocument.decisionVersion = (draftDocument.decisionVersion ?? 0) + 1;
            await draftDocument.save({ session });
          } else {
            await this.revisions.create([{ _id: revisionId, ...revisionContent }], { session });
          }
          const [purposeUsage, typeUsage, governorateUsage, cityUsage, optionUsage, amenityUsage] = await Promise.all([
            this.purposeCategories.updateOne({ _id: purpose._id, isActive: true }, { $inc: { usageCount: 1 } }, { session }).exec(),
            this.propertyTypes.updateOne({ _id: type._id, purposeCategoryId: purpose._id, isActive: true }, { $inc: { usageCount: 1 } }, { session }).exec(),
            this.governorates.updateOne({ code: dto.governorateCode, isActive: true }, { $inc: { usageCount: 1 } }, { session }).exec(),
            city
              ? this.cities.updateOne({ _id: city._id, governorateId: governorate!._id, isActive: true }, { $inc: { usageCount: 1 } }, { session }).exec()
              : Promise.resolve({ matchedCount: legacyCityAllowed ? 1 : 0 }),
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
          if (governorateUsage.matchedCount !== 1 || cityUsage.matchedCount !== 1 || optionUsage.matchedCount !== dto.paymentMethodCodes.length + 2 || amenityUsage.matchedCount !== dto.amenityCodes.length) {
            throw new BadRequestException({ message: 'تم تغيير أحد خيارات العقار؛ أعد تحميل الخيارات', code: PropertyErrorCode.CATALOG_VALUE_INVALID });
          }
          if (!existingProperty) await this.audit.logRequired({ action: AuditAction.PROPERTY_CREATED, actorUserId: attribution.actorId.toString(), targetResourceId: propertyId.toString(), reason: 'property aggregate created', ip, metadata: { advertiserAccountId: attribution.advertiserId.toString(), revisionId: revisionId.toString(), revisionNumber } }, session);
          await this.audit.logRequired({ action: existingDraft ? AuditAction.PROPERTY_REVISION_DRAFT_UPDATED : AuditAction.PROPERTY_REVISION_CREATED, actorUserId: attribution.actorId.toString(), targetResourceId: propertyId.toString(), reason: existingDraft ? 'property draft revision updated' : 'property revision created', ip, metadata: { revisionId: revisionId.toString(), revisionNumber, state: 'draft', versionBefore: existingDraft?.decisionVersion ?? undefined, versionAfter: existingDraft ? (existingDraft.decisionVersion ?? 0) + 1 : 0 } }, session);
        });
      } finally {
        await session.endSession();
      }
      createdPropertyId = existingProperty ? undefined : property!._id;
      createdRevisionId = existingDraft ? undefined : revisionId;
      await this.audit.logResourceAction(
        AuditAction.PROPERTY_MEDIA_UPLOADED,
        attribution.actorId.toString(),
        property!._id.toString(),
        `revision:${revisionId.toString()}:public:${uploadedPublic.length}:private:${titleDeed ? 1 : 0}`,
        ip,
      );
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
      const aggregateObject = typeof property!.toObject === 'function' ? property!.toObject() : property!;
      return { message: 'تم حفظ مسودة العقار بنجاح', property: { ...this.toOwner(aggregateObject), revisionId: revisionId.toString(), revisionNumber, revisionVersion: existingDraft ? (existingDraft.decisionVersion ?? 0) + 1 : 0, status: PropertyRevisionModerationStatus.DRAFT } };
    } catch (error) {
      if (createdPropertyId) await this.properties.deleteOne({ _id: createdPropertyId }).exec().catch(() => undefined);
      if (createdRevisionId) await this.revisions.deleteOne({ _id: createdRevisionId }).exec().catch(() => undefined);
      await this.evidenceAssets.deleteOrEnqueue(
        [...uploadedPublic, titleDeed] as Array<StoredAssetMetadata | undefined>,
        'property-create-failed',
      );
      if ((error as { code?: number })?.code === 11000) {
        throw new ConflictException({ message: 'تغيرت نسخ العقار أثناء الحفظ', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
      }
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

  private requiredPhotoSlots(dto: Pick<CreatePropertyDto, 'livingRooms' | 'bedrooms' | 'kitchens' | 'bathrooms'>): string[] {
    return [
      'exterior',
      'entrance',
      ...Array.from({ length: dto.livingRooms }, (_, index) => `living_${index + 1}`),
      ...Array.from({ length: dto.bedrooms }, (_, index) => `bedroom_${index + 1}`),
      ...Array.from({ length: dto.kitchens }, (_, index) => `kitchen_${index + 1}`),
      ...Array.from({ length: dto.bathrooms }, (_, index) => `bathroom_${index + 1}`),
    ];
  }

  async listMine(ownerId: string, options: { page?: number; limit?: number } = {}) {
    const accountId = new Types.ObjectId(ownerId);
    const page = Number.isFinite(options.page) ? Math.max(options.page!, 1) : 1;
    const limit = Number.isFinite(options.limit) ? Math.min(Math.max(options.limit!, 1), 50) : 20;
    const filter = { $or: [{ advertiserAccountId: accountId }, { advertiserAccountId: { $exists: false }, ownerId: accountId }] };
    const [items, total] = await Promise.all([
      this.properties.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('pendingRevisionId').populate('currentPublicRevisionId').lean().exec(),
      this.properties.countDocuments(filter).exec(),
    ]);
    const revisions = await this.revisions.find({ propertyId: { $in: items.map(item => item._id) }, moderationStatus: { $in: [PropertyRevisionModerationStatus.DRAFT, PropertyRevisionModerationStatus.REJECTED] } }).sort({ revisionNumber: -1 }).lean().exec();
    const latest = new Map<string, any>();
    for (const revision of revisions) if (!latest.has(revision.propertyId.toString())) latest.set(revision.propertyId.toString(), revision);
    return {
      items: items.map(i => this.toOwner({ ...i, draftRevision: latest.get(i._id.toString()) })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
  async getMine(ownerId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف العقار غير صالح');
    const accountId = new Types.ObjectId(ownerId);
    const item = await this.properties.findOne({ _id: id, $or: [{ advertiserAccountId: accountId }, { advertiserAccountId: { $exists: false }, ownerId: accountId }] }).populate('pendingRevisionId').populate('currentPublicRevisionId').lean().exec();
    if (!item) throw new NotFoundException('العقار غير موجود');
    const revisions = await this.revisions.find({ propertyId: item._id }).sort({ revisionNumber: -1 }).lean().exec();
    const draftRevision = revisions.find(revision => [PropertyRevisionModerationStatus.DRAFT, PropertyRevisionModerationStatus.REJECTED].includes(revision.moderationStatus));
    return { property: { ...this.toOwner({ ...item, draftRevision }), revisions: revisions.map(revision => this.revisionSummary(revision)) } };
  }
  async listPublished(query: ListPublishedPropertiesDto = {}) {
    const { filter: dimensionFilter, sort, page, limit } = await this.buildPublicListingQuery(query);
    const filter = { ...this.publicVisibilityFilter(), ...dimensionFilter };
    const [items, total] = await Promise.all([
      this.properties.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).populate('currentPublicRevisionId').lean().exec(),
      this.properties.countDocuments(filter).exec(),
    ]);
    return {
      items: await this.hydratePublicListings(items),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Parses and validates the public search/filter query (MAZAD-021) into a
   * Mongo filter fragment, sort spec and clamped pagination. Kept separate
   * from `listPublished` so the pure parts (bounds clamping, price-range and
   * sort resolution) are trivially unit-testable, while the catalog-hierarchy
   * checks that need a DB round trip stay async.
   */
  private async buildPublicListingQuery(query: ListPublishedPropertiesDto) {
    const page = Number.isFinite(query.page) ? Math.max(query.page!, 1) : 1;
    const limit = Number.isFinite(query.limit) ? Math.min(Math.max(query.limit!, 1), 50) : 20;
    const filter: Record<string, unknown> = {};

    if (query.operationType) filter.operationType = query.operationType;

    if (query.purposeSubcategoryId) {
      const subcategory = await this.propertyTypes.findById(query.purposeSubcategoryId).lean().exec();
      if (!subcategory) throw new BadRequestException({ message: 'نوع العقار الفرعي غير موجود', code: PropertyErrorCode.PURPOSE_SUBCATEGORY_INVALID });
      if (query.purposeCategoryId && (!subcategory.purposeCategoryId || subcategory.purposeCategoryId.toString() !== query.purposeCategoryId)) {
        throw new BadRequestException({ message: 'نوع العقار الفرعي لا يتبع غرض العقار المحدد', code: PropertyErrorCode.PURPOSE_HIERARCHY_MISMATCH });
      }
      filter.purposeSubcategoryId = subcategory._id;
      if (!query.purposeCategoryId && subcategory.purposeCategoryId) filter.purposeCategoryId = subcategory.purposeCategoryId;
    } else if (query.purposeCategoryId) {
      const exists = await this.purposeCategories.exists({ _id: query.purposeCategoryId }).exec();
      if (!exists) throw new BadRequestException({ message: 'غرض العقار غير موجود', code: PropertyErrorCode.PURPOSE_CATEGORY_INVALID });
      filter.purposeCategoryId = new Types.ObjectId(query.purposeCategoryId);
    }

    if (query.governorateCode) filter.governorateCode = query.governorateCode;
    if (query.city) filter.city = { $regex: `^${this.escapeRegExp(query.city)}$`, $options: 'i' };

    if (query.minPriceMinor !== undefined || query.maxPriceMinor !== undefined) {
      if (query.minPriceMinor !== undefined && query.maxPriceMinor !== undefined && query.minPriceMinor > query.maxPriceMinor) {
        throw new BadRequestException({ message: 'الحد الأدنى للسعر أكبر من الحد الأقصى المحدد', code: PropertyErrorCode.PRICE_RANGE_INVALID });
      }
      filter.totalPriceMinor = {
        ...(query.minPriceMinor !== undefined ? { $gte: query.minPriceMinor } : {}),
        ...(query.maxPriceMinor !== undefined ? { $lte: query.maxPriceMinor } : {}),
      };
    }

    if (query.q) {
      const escaped = this.escapeRegExp(query.q);
      filter.$or = ['title', 'city', 'district'].map(field => ({ [field]: { $regex: escaped, $options: 'i' } }));
    }

    const sort: Record<string, 1 | -1> =
      query.sort === 'price_asc' ? { totalPriceMinor: 1, _id: 1 }
      : query.sort === 'price_desc' ? { totalPriceMinor: -1, _id: -1 }
      : { createdAt: -1, _id: -1 };

    return { filter, sort, page, limit };
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async hydratePublicListings(items: any[]) {
    if (!items.length) return [];
    const currentRevisions = items.map(item => this.populatedRevision(item.currentPublicRevisionId));
    const purposeIds = currentRevisions.map(revision => revision?.purposeCategoryId).filter(Boolean);
    const subcategoryIds = currentRevisions.map(revision => revision?.purposeSubcategoryId).filter(Boolean);
    const paymentCodes = currentRevisions.flatMap(revision => revision?.paymentMethodCodes ?? []);
    const [governorates, propertyTypes, purposes, paymentMethods] = await Promise.all([
      this.governorates.find({ code: { $in: [...new Set(currentRevisions.map((revision, index) => revision?.governorateCode ?? items[index].governorateCode))] } }).lean().exec(),
      this.propertyTypes.find({ $or: [{ _id: { $in: subcategoryIds } }, { code: { $in: [...new Set(currentRevisions.map((revision, index) => revision?.legacyPropertyTypeCode ?? items[index].propertyTypeCode))] } }] }).lean().exec(),
      this.purposeCategories.find({ _id: { $in: purposeIds } }).lean().exec(),
      this.options.find({ group: 'payment_method', code: { $in: paymentCodes } }).lean().exec(),
    ]);
    const governorateNames = new Map(governorates.map(item => [item.code, item.nameAr]));
    const propertyTypeNames = new Map(propertyTypes.map(item => [item.code, item.nameAr]));
    const propertyTypeNamesById = new Map(propertyTypes.map(item => [item._id.toString(), item.nameAr]));
    const purposeNames = new Map(purposes.map(item => [item._id.toString(), item.nameAr]));
    const paymentNames = new Map(paymentMethods.map(item => [item.code, item.nameAr]));
    return items.map(item => {
      const revision = this.populatedRevision(item.currentPublicRevisionId);
      return {
        ...this.toMarketplacePublic(item),
        governorateNameAr: governorateNames.get(revision?.governorateCode ?? item.governorateCode) ?? (revision?.governorateCode ?? item.governorateCode),
        purposeCategoryNameAr: revision?.purposeCategoryId ? purposeNames.get(revision.purposeCategoryId.toString()) : undefined,
        propertyTypeNameAr: revision?.purposeSubcategoryId ? propertyTypeNamesById.get(revision.purposeSubcategoryId.toString()) : (propertyTypeNames.get(item.propertyTypeCode) ?? item.propertyTypeCode),
        paymentMethodNamesAr: (revision?.paymentMethodCodes ?? []).map((code: string) => paymentNames.get(code)).filter(Boolean),
      };
    });
  }

  async getPublished(id: string) {
    this.assertId(id);
    const item = await this.properties.findOne({ _id: id, ...this.publicVisibilityFilter() }).populate('currentPublicRevisionId').lean().exec();
    if (!item || !this.populatedRevision(item.currentPublicRevisionId)) throw new NotFoundException('العقار غير موجود');
    const revision = this.populatedRevision(item.currentPublicRevisionId)!;
    const [purpose, type, governorate, paymentMethods] = await Promise.all([
      revision.purposeCategoryId ? this.purposeCategories.findById(revision.purposeCategoryId).lean().exec() : undefined,
      revision.purposeSubcategoryId ? this.propertyTypes.findById(revision.purposeSubcategoryId).lean().exec() : undefined,
      this.governorates.findOne({ code: revision.governorateCode }).lean().exec(),
      this.options.find({ group: 'payment_method', code: { $in: revision.paymentMethodCodes ?? [] } }).lean().exec(),
    ]);
    return { property: {
      ...this.toMarketplacePublic(item),
      purposeCategoryNameAr: purpose?.nameAr,
      propertyTypeNameAr: type?.nameAr ?? revision.legacyPropertyTypeCode,
      governorateNameAr: governorate?.nameAr ?? revision.governorateCode,
      paymentMethodNamesAr: paymentMethods.map(item => item.nameAr),
    } };
  }

  /**
   * The single gate every public-facing property query shares: approved,
   * owner-visible, not archived/admin-hidden, and carrying a current public
   * revision. Centralized so `listPublished`, `getPublished` and the
   * favorites read paths (MAZAD-022) can never drift apart on what "public"
   * means — a property that stops meeting this must stop being reachable
   * through any of them, even if a user had previously favorited it.
   */
  private publicVisibilityFilter() {
    return {
      status: 'approved',
      isOwnerVisible: { $ne: false },
      lifecycleStatus: { $nin: [PropertyLifecycleStatus.ARCHIVED, PropertyLifecycleStatus.ADMIN_HIDDEN] },
      currentPublicRevisionId: { $exists: true },
    };
  }

  /** Cheap existence+visibility check used to validate a favorite target (MAZAD-022). */
  async isPubliclyVisible(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const exists = await this.properties.exists({ _id: id, ...this.publicVisibilityFilter() }).exec();
    return Boolean(exists);
  }

  /**
   * Safe public projections for a set of property ids (MAZAD-022 favorites
   * listing), keyed by property id. Ids that no longer pass
   * `publicVisibilityFilter` (hidden, archived, rejected, deleted, ...) are
   * simply absent from the result — the caller must not assume every
   * requested id comes back.
   */
  async getPublicProjectionsByIds(ids: string[]): Promise<Map<string, ReturnType<PropertiesService['toMarketplacePublic']>>> {
    const validIds = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id));
    if (!validIds.length) return new Map();
    const items = await this.properties.find({ _id: { $in: validIds }, ...this.publicVisibilityFilter() }).populate('currentPublicRevisionId').lean().exec();
    const hydrated = await this.hydratePublicListings(items);
    return new Map(hydrated.map((item) => [item.id, item]));
  }

  async updateOwnerVisibility(ownerId: string, id: string, isVisible: boolean) {
    this.assertId(id);
    await this.auctionLock.assertUnlocked(id);
    const item = await this.properties.findOneAndUpdate(
      { _id: id, $or: [{ advertiserAccountId: new Types.ObjectId(ownerId) }, { advertiserAccountId: { $exists: false }, ownerId: new Types.ObjectId(ownerId) }] },
      { isOwnerVisible: isVisible },
      { new: true, runValidators: true },
    ).lean().exec();
    if (!item) throw new NotFoundException('العقار غير موجود');
    return { message: isVisible ? 'تم إظهار العقار للمستخدمين' : 'تم إخفاء العقار عن المستخدمين', property: this.toOwner(item) };
  }

  async updateLifecycle(ownerId: string, id: string, status: PropertyLifecycleStatus.ACTIVE | PropertyLifecycleStatus.ARCHIVED, version: number, ip?: string) {
    this.assertId(id);
    await this.auctionLock.assertUnlocked(id);
    const accountId = new Types.ObjectId(ownerId);
    const now = new Date();
    const session = await this.connection.startSession();
    try {
      let item: any;
      await session.withTransaction(async () => {
        item = await this.properties.findOneAndUpdate(
          { _id: id, $and: [{ $or: [{ lifecycleVersion: version }, ...(version === 0 ? [{ lifecycleVersion: { $exists: false } }] : [])] }, { $or: [{ advertiserAccountId: accountId }, { advertiserAccountId: { $exists: false }, ownerId: accountId }] }] },
          { $set: { lifecycleStatus: status, isOwnerVisible: status === PropertyLifecycleStatus.ACTIVE, archivedAt: status === PropertyLifecycleStatus.ARCHIVED ? now : undefined }, $inc: { lifecycleVersion: 1 } },
          { new: true, runValidators: true, session },
        ).lean().exec();
        if (!item) throw new ConflictException({ message: 'تغيرت حالة العقار؛ أعد تحميله', code: PropertyErrorCode.STATE_CONFLICT });
        await this.audit.logRequired({ action: status === PropertyLifecycleStatus.ARCHIVED ? AuditAction.PROPERTY_ARCHIVED : AuditAction.PROPERTY_RESTORED, actorUserId: ownerId, targetResourceId: id, reason: `property lifecycle ${status}`, ip, metadata: { beforeVersion: version, afterVersion: version + 1, afterState: status } }, session);
      });
      return { message: status === PropertyLifecycleStatus.ARCHIVED ? 'تم إيقاف العقار' : 'تمت إعادة إظهار العقار', property: this.toOwner(item) };
    } finally { await session.endSession(); }
  }

  async forceLifecycleForAdmin(id: string, status: PropertyLifecycleStatus.ACTIVE | PropertyLifecycleStatus.ADMIN_HIDDEN, version: number, reason: string | undefined, actor: string, ip?: string) {
    this.assertId(id);
    if (status === PropertyLifecycleStatus.ADMIN_HIDDEN && !reason?.trim()) throw new BadRequestException({ message: 'سبب الإخفاء الإداري مطلوب', code: PropertyErrorCode.REVIEW_REASON_REQUIRED });
    await this.auctionLock.assertUnlocked(id);
    const session = await this.connection.startSession();
    try {
      let item: any;
      await session.withTransaction(async () => {
        item = await this.properties.findOneAndUpdate(
          { _id: id, $or: [{ lifecycleVersion: version }, ...(version === 0 ? [{ lifecycleVersion: { $exists: false } }] : [])] },
          { $set: { lifecycleStatus: status, isOwnerVisible: status === PropertyLifecycleStatus.ACTIVE, lifecycleReason: reason?.trim() }, $inc: { lifecycleVersion: 1 } },
          { new: true, runValidators: true, session },
        ).lean().exec();
        if (!item) throw new ConflictException({ message: 'تغيرت حالة العقار؛ أعد تحميله', code: PropertyErrorCode.STATE_CONFLICT });
        await this.audit.logRequired({ action: status === PropertyLifecycleStatus.ADMIN_HIDDEN ? AuditAction.PROPERTY_ADMIN_HIDDEN : AuditAction.PROPERTY_ADMIN_RESTORED, actorUserId: actor, targetResourceId: id, reason: reason?.trim() ?? `property lifecycle ${status}`, ip, metadata: { beforeVersion: version, afterVersion: version + 1, afterState: status } }, session);
      });
      return { message: status === PropertyLifecycleStatus.ADMIN_HIDDEN ? 'تم إخفاء العقار إداريًا' : 'تمت إعادة العقار', property: this.toAdmin(item, true) };
    } finally { await session.endSession(); }
  }

  async submitRevision(ownerId: string, propertyId: string, revisionId: string, version: number, ip?: string, idempotencyKey?: string) {
    this.assertId(propertyId); this.assertId(revisionId);
    if (!this.idempotency) return this.submitRevisionOnce(ownerId, propertyId, revisionId, version, ip);
    return this.idempotency.execute(
      { scope: 'property.submit', accountId: ownerId, key: idempotencyKey, fingerprint: () => sha256(canonicalize({ propertyId, revisionId, version })) },
      () => this.submitRevisionOnce(ownerId, propertyId, revisionId, version, ip),
    );
  }

  private async submitRevisionOnce(ownerId: string, propertyId: string, revisionId: string, version: number, ip?: string) {
    const accountId = new Types.ObjectId(ownerId);
    const session = await this.connection.startSession();
    try {
      let submitted: any;
      await session.withTransaction(async () => {
        const property = await this.properties.findOne({ _id: propertyId, lifecycleStatus: { $ne: PropertyLifecycleStatus.ARCHIVED }, $or: [{ advertiserAccountId: accountId }, { advertiserAccountId: { $exists: false }, ownerId: accountId }] }).session(session).exec();
        if (!property) throw new NotFoundException('العقار غير موجود');
        if (property.pendingRevisionId) throw new ConflictException({ message: 'يوجد تعديل قيد المراجعة بالفعل', code: PropertyErrorCode.PENDING_REVISION_EXISTS });
        const candidate = await this.revisions.findOne({ _id: revisionId, propertyId: property._id, moderationStatus: PropertyRevisionModerationStatus.DRAFT, decisionVersion: version }).session(session).lean().exec();
        if (!candidate) throw new ConflictException({ message: 'المسودة تغيرت أو لم تعد قابلة للإرسال', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
        await this.validateRevisionForSubmission(candidate, session);
        const revision = await this.revisions.findOneAndUpdate(
          { _id: revisionId, propertyId: property._id, moderationStatus: PropertyRevisionModerationStatus.DRAFT, decisionVersion: version },
          { $set: { moderationStatus: PropertyRevisionModerationStatus.PENDING_REVIEW, submittedAt: new Date() }, $inc: { decisionVersion: 1 } },
          { new: true, session, runValidators: true },
        ).exec();
        if (!revision) throw new ConflictException({ message: 'المسودة تغيرت أو لم تعد قابلة للإرسال', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
        const linked = await this.properties.updateOne(
          { _id: property._id, pendingRevisionId: { $exists: false } },
          { $set: { pendingRevisionId: revision._id, status: property.currentPublicRevisionId ? 'approved' : 'pending_review' } },
          { session },
        ).exec();
        if (linked.modifiedCount !== 1) throw new ConflictException({ message: 'يوجد تعديل قيد المراجعة بالفعل', code: PropertyErrorCode.PENDING_REVISION_EXISTS });
        await this.audit.logRequired({ action: AuditAction.PROPERTY_REVISION_SUBMITTED, actorUserId: ownerId, targetResourceId: propertyId, reason: 'property revision submitted', ip, metadata: { revisionId, revisionNumber: revision.revisionNumber, beforeState: 'draft', afterState: 'pending_review', versionBefore: version, versionAfter: version + 1 } }, session);
        submitted = revision;
      });
      return { message: 'تم إرسال العقار للمراجعة بنجاح', revision: this.revisionSummary(submitted) };
    } finally { await session.endSession(); }
  }

  private async validateRevisionForSubmission(revision: any, session: any) {
    if (!isMoneyMinorAmount(revision.totalPriceMinor, { positive: true }) || revision.currency !== EGP_CURRENCY) {
      throw new BadRequestException({ message: 'بيانات السعر غير صالحة', code: PropertyErrorCode.STATE_CONFLICT });
    }
    if (!Object.values(PropertyMarketingMode).includes(revision.marketingMode)) {
      throw new BadRequestException({ message: 'وضع التسويق غير صالح', code: PropertyErrorCode.MARKETING_MODE_INVALID });
    }
    const paymentMethodCodes = revision.paymentMethodCodes ?? [];
    if (!paymentMethodCodes.length || new Set(paymentMethodCodes).size !== paymentMethodCodes.length) {
      throw new BadRequestException({ message: 'طرق السداد غير صالحة', code: PropertyErrorCode.PAYMENT_METHODS_INVALID });
    }
    const [purpose, type, paymentCount] = await Promise.all([
      this.purposeCategories.findOne({ _id: revision.purposeCategoryId, isActive: true }).session(session).lean().exec(),
      this.propertyTypes.findOne({ _id: revision.purposeSubcategoryId, isActive: true }).session(session).lean().exec(),
      this.options.countDocuments({ group: 'payment_method', code: { $in: paymentMethodCodes }, isActive: true }).session(session).exec(),
    ]);
    if (!purpose || !type || !type.purposeCategoryId || type.purposeCategoryId.toString() !== purpose._id.toString()) {
      throw new BadRequestException({ message: 'تصنيف غرض العقار غير صالح', code: PropertyErrorCode.PURPOSE_HIERARCHY_MISMATCH });
    }
    if (paymentCount !== paymentMethodCodes.length) throw new BadRequestException({ message: 'إحدى طرق السداد غير متاحة', code: PropertyErrorCode.PAYMENT_METHODS_INVALID });
    if (revision.marketingMode === PropertyMarketingMode.SELF_SERVICE) {
      this.assertPresentationMediaComplete(revision);
    }
  }

  private assertPresentationMediaComplete(revision: any) {
    if (revision.marketingMode === PropertyMarketingMode.PLATFORM_MANAGED) {
      if (!(revision.galleryMedia ?? []).length) {
        throw new BadRequestException({
          message: 'يجب إضافة صورة واحدة للعقار على الأقل قبل الاعتماد',
          code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING,
          minimumPhotoCount: 1,
        });
      }
      return;
    }
    const required = this.requiredPhotoSlots(revision);
    const supplied = new Set((revision.galleryMedia ?? []).map((asset: PropertyAsset) => asset.slotId));
    const missingPhotoSlots = required.filter(slot => !supplied.has(slot));
    if (missingPhotoSlots.length) {
      throw new BadRequestException({
        message: 'لا يمكن نشر العقار قبل استكمال صور العرض المطلوبة',
        code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING,
        missingPhotoSlots,
      });
    }
  }

  async addPlatformMediaForAdmin(id: string, revisionId: string, tagCode: PropertyMediaTagCode, version: number, file: Express.Multer.File | undefined, actor: string, ip?: string) {
    this.assertId(id); this.assertId(revisionId);
    if (!file) throw new BadRequestException({ message: 'صورة العقار مطلوبة', code: EvidenceErrorCode.NOT_FOUND });
    const detected = validateEvidenceFile(file, PROPERTY_IMAGE_POLICY);
    const candidate = await this.platformManagedPendingRevision(id, revisionId, version);
    if ((candidate.galleryMedia ?? []).length >= 20) throw new BadRequestException({ message: 'عدد صور العقار يتجاوز الحد المسموح', code: EvidenceErrorCode.FILE_COUNT_EXCEEDED });
    const contentDigest = createHash('sha256').update(file.buffer).digest('hex');
    const mediaId = randomUUID();
    const uploaded = { ...(await this.uploadPublicImage(file, detected)), mediaId, tagCode, origin: PropertyMediaOrigin.PLATFORM, sortOrder: (candidate.galleryMedia ?? []).length, contentDigest };
    const galleryMedia = [...(candidate.galleryMedia ?? []), uploaded];
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const updated = await this.revisions.findOneAndUpdate(
          { _id: revisionId, propertyId: new Types.ObjectId(id), moderationStatus: PropertyRevisionModerationStatus.PENDING_REVIEW, marketingMode: PropertyMarketingMode.PLATFORM_MANAGED, decisionVersion: version },
          { $set: { galleryMedia }, $inc: { decisionVersion: 1 } },
          { new: true, session, runValidators: true, overwriteImmutable: true },
        ).exec();
        if (!updated) throw new ConflictException({ message: 'تم تحديث هذه النسخة بواسطة مراجع آخر', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
        await this.audit.logRequired({
          action: AuditAction.PROPERTY_MEDIA_UPLOADED,
          actorUserId: actor,
          targetResourceId: id,
          reason: 'uploaded platform-managed property media',
          ip,
          metadata: { propertyId: id, revisionId, mediaId, tagCode, versionBefore: version, versionAfter: version + 1 },
        }, session);
      });
    } catch (error) {
      await this.evidenceAssets.deleteOrEnqueue([uploaded as StoredAssetMetadata], `property-media-update-failed:${revisionId}:${mediaId}`);
      throw error;
    } finally { await session.endSession(); }
    return this.getForAdmin(id);
  }

  async replacePlatformMediaForAdmin(id: string, revisionId: string, mediaId: string, tagCode: PropertyMediaTagCode, version: number, file: Express.Multer.File | undefined, actor: string, ip?: string) {
    this.assertId(id); this.assertId(revisionId);
    if (!file) throw new BadRequestException({ message: 'صورة العقار مطلوبة', code: EvidenceErrorCode.NOT_FOUND });
    const detected = validateEvidenceFile(file, PROPERTY_IMAGE_POLICY);
    const candidate = await this.platformManagedPendingRevision(id, revisionId, version);
    const existingIndex = this.platformMediaIndex(candidate.galleryMedia ?? [], mediaId);
    if (existingIndex < 0) throw new NotFoundException({ message: 'صورة العقار غير موجودة', code: EvidenceErrorCode.NOT_FOUND });
    const existing = candidate.galleryMedia[existingIndex];
    const uploaded = { ...(await this.uploadPublicImage(file, detected)), mediaId: existing.mediaId ?? randomUUID(), tagCode, origin: PropertyMediaOrigin.PLATFORM, sortOrder: existing.sortOrder ?? existingIndex, contentDigest: createHash('sha256').update(file.buffer).digest('hex') };
    const galleryMedia = [...candidate.galleryMedia];
    galleryMedia[existingIndex] = uploaded;
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const updated = await this.revisions.findOneAndUpdate(
          { _id: revisionId, propertyId: new Types.ObjectId(id), moderationStatus: PropertyRevisionModerationStatus.PENDING_REVIEW, marketingMode: PropertyMarketingMode.PLATFORM_MANAGED, decisionVersion: version },
          { $set: { galleryMedia }, $inc: { decisionVersion: 1 } },
          { new: true, session, runValidators: true, overwriteImmutable: true },
        ).exec();
        if (!updated) throw new ConflictException({ message: 'تم تحديث هذه النسخة بواسطة مراجع آخر', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
        await this.audit.logRequired({ action: AuditAction.PROPERTY_MEDIA_REPLACED, actorUserId: actor, targetResourceId: id, reason: 'replaced platform-managed property media', ip, metadata: { propertyId: id, revisionId, mediaId, tagCode, versionBefore: version, versionAfter: version + 1 } }, session);
      });
    } catch (error) {
      await this.evidenceAssets.deleteOrEnqueue([uploaded as StoredAssetMetadata], `property-media-replace-failed:${revisionId}:${mediaId}`);
      throw error;
    } finally { await session.endSession(); }
    await this.evidenceAssets.deleteOrEnqueue([existing as StoredAssetMetadata], `property-media-replaced:${revisionId}:${mediaId}`);
    return this.getForAdmin(id);
  }

  async updatePlatformMediaForAdmin(id: string, revisionId: string, mediaId: string, update: { tagCode?: PropertyMediaTagCode; sortOrder?: number; version: number }, actor: string, ip?: string) {
    this.assertId(id); this.assertId(revisionId);
    if (update.tagCode === undefined && update.sortOrder === undefined) throw new BadRequestException({ message: 'لم يتم تحديد تعديل للصورة', code: PropertyErrorCode.STATE_CONFLICT });
    const candidate = await this.platformManagedPendingRevision(id, revisionId, update.version);
    const existingIndex = this.platformMediaIndex(candidate.galleryMedia ?? [], mediaId);
    if (existingIndex < 0) throw new NotFoundException({ message: 'صورة العقار غير موجودة', code: EvidenceErrorCode.NOT_FOUND });
    const ordered = [...candidate.galleryMedia].sort((a, b) => (a.sortOrder ?? candidate.galleryMedia.indexOf(a)) - (b.sortOrder ?? candidate.galleryMedia.indexOf(b)));
    const currentIndex = ordered.findIndex((asset, index) => this.platformMediaIdentifier(asset, index) === mediaId || asset === candidate.galleryMedia[existingIndex]);
    const [asset] = ordered.splice(currentIndex, 1);
    if (update.tagCode !== undefined) asset.tagCode = update.tagCode;
    ordered.splice(Math.min(update.sortOrder ?? currentIndex, ordered.length), 0, asset);
    const galleryMedia = ordered.map((item, sortOrder) => ({ ...item, sortOrder }));
    await this.persistPlatformMediaMutation(id, revisionId, update.version, galleryMedia, actor, ip, 'updated platform-managed property media', { mediaId, tagCode: update.tagCode, sortOrder: update.sortOrder });
    return this.getForAdmin(id);
  }

  async removePlatformMediaForAdmin(id: string, revisionId: string, mediaId: string, version: number, actor: string, ip?: string) {
    this.assertId(id); this.assertId(revisionId);
    const candidate = await this.platformManagedPendingRevision(id, revisionId, version);
    const existingIndex = this.platformMediaIndex(candidate.galleryMedia ?? [], mediaId);
    if (existingIndex < 0) throw new NotFoundException({ message: 'صورة العقار غير موجودة', code: EvidenceErrorCode.NOT_FOUND });
    const existing = candidate.galleryMedia[existingIndex];
    const galleryMedia = candidate.galleryMedia.filter((_asset: PropertyAsset, index: number) => index !== existingIndex).map((asset: PropertyAsset, sortOrder: number) => ({ ...asset, sortOrder }));
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const updated = await this.revisions.findOneAndUpdate(
          { _id: revisionId, propertyId: new Types.ObjectId(id), moderationStatus: PropertyRevisionModerationStatus.PENDING_REVIEW, marketingMode: PropertyMarketingMode.PLATFORM_MANAGED, decisionVersion: version },
          { $set: { galleryMedia }, $inc: { decisionVersion: 1 } },
          { new: true, session, runValidators: true, overwriteImmutable: true },
        ).exec();
        if (!updated) throw new ConflictException({ message: 'تم تحديث هذه النسخة بواسطة مراجع آخر', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
        await this.audit.logRequired({ action: AuditAction.PROPERTY_MEDIA_REMOVED, actorUserId: actor, targetResourceId: id, reason: 'removed platform-managed property media', ip, metadata: { propertyId: id, revisionId, mediaId, versionBefore: version, versionAfter: version + 1 } }, session);
      });
    } finally { await session.endSession(); }
    await this.evidenceAssets.deleteOrEnqueue([existing as StoredAssetMetadata], `property-media-removed:${revisionId}:${mediaId}`);
    return this.getForAdmin(id);
  }

  async downloadPublicMediaForAdmin(id: string, revisionId: string, mediaId: string, actor: string, ip?: string) {
    this.assertId(id); this.assertId(revisionId);
    const revision = await this.revisions.findOne({ _id: revisionId, propertyId: new Types.ObjectId(id) }).lean().exec();
    const assetIndex = revision ? this.platformMediaIndex(revision.galleryMedia ?? [], mediaId) : -1;
    const asset = assetIndex >= 0 ? revision.galleryMedia[assetIndex] : undefined;
    if (!asset?.publicId) throw new NotFoundException({ message: 'صورة العقار غير موجودة', code: EvidenceErrorCode.NOT_FOUND });
    const result = await this.evidenceAssets.downloadAuthenticatedAsset({ ...asset, secureUrl: asset.url } as StoredAssetMetadata);
    await this.audit.logResourceAction(AuditAction.PROPERTY_MEDIA_ACCESSED, actor, id, `property-media-admin-access:${revisionId}:${mediaId}`, ip);
    return result;
  }

  private platformMediaIdentifier(asset: PropertyAsset, index: number) {
    return asset.mediaId ?? asset.slotId ?? `legacy-${index}`;
  }

  private platformMediaIndex(media: PropertyAsset[], mediaId: string) {
    return media.findIndex((asset, index) => this.platformMediaIdentifier(asset, index) === mediaId);
  }

  private mediaTagFromGuidedSlot(slotId?: string): PropertyMediaTagCode {
    if (slotId === 'exterior') return PropertyMediaTagCode.EXTERIOR;
    if (slotId === 'entrance') return PropertyMediaTagCode.ENTRANCE;
    if (slotId?.startsWith('living_')) return PropertyMediaTagCode.LIVING_ROOM;
    if (slotId?.startsWith('bedroom_')) return PropertyMediaTagCode.BEDROOM;
    if (slotId?.startsWith('kitchen_')) return PropertyMediaTagCode.KITCHEN;
    if (slotId?.startsWith('bathroom_')) return PropertyMediaTagCode.BATHROOM;
    return PropertyMediaTagCode.OTHER;
  }

  private async persistPlatformMediaMutation(id: string, revisionId: string, version: number, galleryMedia: PropertyAsset[], actor: string, ip: string | undefined, reason: string, metadata: Record<string, unknown>) {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const updated = await this.revisions.findOneAndUpdate(
          { _id: revisionId, propertyId: new Types.ObjectId(id), moderationStatus: PropertyRevisionModerationStatus.PENDING_REVIEW, marketingMode: PropertyMarketingMode.PLATFORM_MANAGED, decisionVersion: version },
          { $set: { galleryMedia }, $inc: { decisionVersion: 1 } },
          { new: true, session, runValidators: true, overwriteImmutable: true },
        ).exec();
        if (!updated) throw new ConflictException({ message: 'تم تحديث هذه النسخة بواسطة مراجع آخر', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
        await this.audit.logRequired({ action: AuditAction.PROPERTY_MEDIA_UPDATED, actorUserId: actor, targetResourceId: id, reason, ip, metadata: { propertyId: id, revisionId, ...metadata, versionBefore: version, versionAfter: version + 1 } }, session);
      });
    } finally { await session.endSession(); }
  }

  private async platformManagedPendingRevision(id: string, revisionId: string, version: number) {
    const property = await this.properties.findOne({ _id: id, pendingRevisionId: new Types.ObjectId(revisionId) }).lean().exec();
    if (!property) throw new ConflictException({ message: 'هذه النسخة ليست النسخة الحالية قيد المراجعة', code: PropertyErrorCode.REVISION_NOT_PENDING });
    const revision = await this.revisions.findOne({ _id: revisionId, propertyId: property._id, moderationStatus: PropertyRevisionModerationStatus.PENDING_REVIEW, marketingMode: PropertyMarketingMode.PLATFORM_MANAGED, decisionVersion: version }).lean().exec();
    if (!revision) throw new ConflictException({ message: 'النسخة غير قابلة لتعديل صور المنصة أو تغير إصدارها', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
    return revision;
  }
  async listForAdmin(options: { page?: number; limit?: number; status?: string; search?: string }) {
    const page = Math.max(options.page || 1, 1);
    const limit = Math.min(Math.max(options.limit || 20, 1), 100);
    const filter: any = {};
    if (options.status && options.status !== 'all') {
      if (!['pending_review', 'approved', 'rejected', 'archived', 'admin_hidden'].includes(options.status)) throw new BadRequestException('حالة العقار غير صالحة');
      if (options.status === 'pending_review') filter.pendingRevisionId = { $exists: true };
      else if (options.status === 'archived' || options.status === 'admin_hidden') filter.lifecycleStatus = options.status;
      else filter.status = options.status;
    }
    if (options.search?.trim()) {
      const escaped = this.escapeRegExp(options.search.trim());
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
    const revisions = await this.revisions.find({ propertyId: item._id }).sort({ revisionNumber: -1 }).lean().exec();
    const [purposes, types, payments] = await Promise.all([
      this.purposeCategories.find({ _id: { $in: revisions.map(revision => revision.purposeCategoryId).filter(Boolean) } }).lean().exec(),
      this.propertyTypes.find({ _id: { $in: revisions.map(revision => revision.purposeSubcategoryId).filter(Boolean) } }).lean().exec(),
      this.options.find({ group: 'payment_method', code: { $in: revisions.flatMap(revision => revision.paymentMethodCodes ?? []) } }).lean().exec(),
    ]);
    const purposeNames = new Map(purposes.map(value => [value._id.toString(), value.nameAr]));
    const typeNames = new Map(types.map(value => [value._id.toString(), value.nameAr]));
    const paymentNames = new Map(payments.map(value => [value.code, value.nameAr]));
    const present = (revision: any) => {
      const result = this.revisionAdmin(revision);
      if (!result) return undefined;
      return {
        ...result,
        purposeCategoryNameAr: revision.purposeCategoryId ? purposeNames.get(revision.purposeCategoryId.toString()) : undefined,
        propertyTypeNameAr: revision.purposeSubcategoryId ? typeNames.get(revision.purposeSubcategoryId.toString()) : revision.legacyPropertyTypeCode,
        paymentMethodNamesAr: (revision.paymentMethodCodes ?? []).map((code: string) => paymentNames.get(code)).filter(Boolean),
      };
    };
    return { property: { ...this.toAdmin(item, true), revisions: revisions.map(present), currentPublicRevision: present(this.populatedRevision(item.currentPublicRevisionId)), pendingRevision: present(this.populatedRevision(item.pendingRevisionId)) } };
  }

  async reviewForAdmin(id: string, revisionId: string, version: number, status: 'approved' | 'rejected', reason: string | undefined, actor: string, ip?: string) {
    this.assertId(id); this.assertId(revisionId);
    const normalizedReason = reason?.trim();
    if (status === 'rejected' && !normalizedReason) throw new BadRequestException({ message: 'سبب الرفض مطلوب', code: PropertyErrorCode.REVIEW_REASON_REQUIRED });
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const property = await this.properties.findOne({ _id: id, pendingRevisionId: new Types.ObjectId(revisionId) }).session(session).exec();
        if (!property) throw new ConflictException({ message: 'هذه النسخة ليست النسخة الحالية قيد المراجعة', code: PropertyErrorCode.REVISION_NOT_PENDING });
        if (status === 'approved') {
          const approvalCandidate = await this.revisions.findOne({ _id: revisionId, propertyId: property._id, moderationStatus: PropertyRevisionModerationStatus.PENDING_REVIEW, decisionVersion: version }).session(session).lean().exec();
          if (!approvalCandidate) throw new ConflictException({ message: 'سبق اتخاذ قرار أو تغير إصدار النسخة', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
          this.assertPresentationMediaComplete(approvalCandidate);
        }
        const now = new Date();
        const revision = await this.revisions.findOneAndUpdate(
          { _id: revisionId, propertyId: property._id, moderationStatus: PropertyRevisionModerationStatus.PENDING_REVIEW, decisionVersion: version },
          { $set: { moderationStatus: status, reviewReason: normalizedReason, reviewedBy: new Types.ObjectId(actor), reviewedAt: now }, $inc: { decisionVersion: 1 } },
          { new: true, session, runValidators: true },
        ).exec();
        if (!revision) throw new ConflictException({ message: 'سبق اتخاذ قرار أو تغير إصدار النسخة', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
        const aggregateUpdate: any = { $unset: { pendingRevisionId: 1 }, $set: { status, reviewReason: normalizedReason, reviewedBy: new Types.ObjectId(actor), reviewedAt: now } };
        if (status === 'approved') {
          aggregateUpdate.$set.currentPublicRevisionId = revision._id;
          aggregateUpdate.$set.status = 'approved';
          aggregateUpdate.$set.isOwnerVisible = true;
          if (!property.publishedAt) aggregateUpdate.$set.publishedAt = now;
          // Keep the property-level search/filter fields in sync with the
          // revision that just became the public one: reads already prefer the
          // populated revision over these (see `projectProperty`), but the
          // public listing query (MAZAD-021) filters/sorts on the `properties`
          // collection directly for performance, so it needs a fresh copy.
          aggregateUpdate.$set.operationType = revision.operationType;
          aggregateUpdate.$set.purposeCategoryId = revision.purposeCategoryId;
          aggregateUpdate.$set.purposeSubcategoryId = revision.purposeSubcategoryId;
          aggregateUpdate.$set.propertyTypeCode = revision.legacyPropertyTypeCode;
          aggregateUpdate.$set.governorateCode = revision.governorateCode;
          aggregateUpdate.$set.city = revision.city;
          aggregateUpdate.$set.district = revision.district;
          aggregateUpdate.$set.totalPriceMinor = revision.totalPriceMinor;
          aggregateUpdate.$set.currency = revision.currency;
        } else if (property.currentPublicRevisionId) aggregateUpdate.$set.status = 'approved';
        const aggregate = await this.properties.updateOne({ _id: property._id, pendingRevisionId: revision._id }, aggregateUpdate, { session }).exec();
        if (aggregate.modifiedCount !== 1) throw new ConflictException({ message: 'تغيرت حالة العقار أثناء المراجعة', code: PropertyErrorCode.STATE_CONFLICT });
        await this.audit.logRequired({
          action: status === 'approved' ? AuditAction.PROPERTY_REVISION_APPROVED : AuditAction.PROPERTY_REVISION_REJECTED,
          actorUserId: actor,
          targetResourceId: id,
          reason: `${status} property revision ${revisionId}`,
          ip,
          metadata: { propertyId: id, revisionId, revisionNumber: revision.revisionNumber, beforeState: 'pending_review', afterState: status, versionBefore: version, versionAfter: version + 1, rejectionReason: normalizedReason },
        }, session);
      });
      return this.getForAdmin(id);
    } finally { await session.endSession(); }
  }

  async downloadPrivateEvidenceForOwner(ownerId: string, id: string, revisionId: string | undefined, evidenceIndex: number, ip?: string) {
    this.assertId(id);
    const accountId = new Types.ObjectId(ownerId);
    const item = await this.properties.findOne({
      _id: id,
      $or: [
        { advertiserAccountId: accountId },
        { advertiserAccountId: { $exists: false }, ownerId: accountId },
      ],
    }).populate('pendingRevisionId').populate('currentPublicRevisionId').lean().exec();
    if (!item) throw new NotFoundException({ message: 'العقار غير موجود', code: EvidenceErrorCode.NOT_FOUND });
    const revision = revisionId ? await this.revisions.findOne({ _id: revisionId, propertyId: item._id }).lean().exec() : undefined;
    const asset = revisionId ? this.privateEvidenceAsset({ pendingRevisionId: revision }, revisionId, evidenceIndex) : this.privateEvidenceAsset(item, undefined, evidenceIndex);
    const result = await this.evidenceAssets.downloadAuthenticatedAsset(asset);
    await this.audit.logResourceAction(AuditAction.PRIVATE_EVIDENCE_ACCESSED, ownerId, id, `property-evidence-owner-access:${revisionId ?? 'legacy'}:${evidenceIndex}`, ip);
    return result;
  }

  async downloadTitleDeedForOwner(ownerId: string, id: string, ip?: string) {
    return this.downloadPrivateEvidenceForOwner(ownerId, id, undefined, 0, ip);
  }

  async downloadPrivateEvidenceForAdmin(id: string, revisionId: string | undefined, evidenceIndex: number, actorId: string, ip?: string) {
    this.assertId(id);
    const item = await this.properties.findById(id).populate('pendingRevisionId').populate('currentPublicRevisionId').lean().exec();
    if (!item) throw new NotFoundException({ message: 'العقار غير موجود', code: EvidenceErrorCode.NOT_FOUND });
    const revision = revisionId ? await this.revisions.findOne({ _id: revisionId, propertyId: item._id }).lean().exec() : undefined;
    const asset = revisionId ? this.privateEvidenceAsset({ pendingRevisionId: revision }, revisionId, evidenceIndex) : this.privateEvidenceAsset(item, undefined, evidenceIndex);
    const result = await this.evidenceAssets.downloadAuthenticatedAsset(asset);
    await this.audit.logAdminResourceAction(AuditAction.PRIVATE_EVIDENCE_ACCESSED, actorId, id, `property-evidence-admin-access:${revisionId ?? 'legacy'}:${evidenceIndex}`, ip);
    return result;
  }

  async downloadTitleDeedForAdmin(id: string, actorId: string, ip?: string) {
    return this.downloadPrivateEvidenceForAdmin(id, undefined, 0, actorId, ip);
  }

  private assertId(id: string) { if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف العقار غير صالح'); }
  private async uploadPublicImage(
    file: Express.Multer.File,
    detected: DetectedEvidenceFile,
  ): Promise<PropertyAsset> {
    const stored = await this.evidenceAssets.uploadPublicPropertyMedia(file, detected);
    return { ...stored, url: stored.secureUrl, contentDigest: createHash('sha256').update(file.buffer).digest('hex') };
  }

  private privateEvidenceAsset(item: any, revisionId?: string, index = 0): StoredAssetMetadata {
    const candidates = [item.pendingRevisionId, item.currentPublicRevisionId]
      .filter((value) => value && typeof value === 'object');
    const revision = revisionId
      ? candidates.find((value) => value._id?.toString() === revisionId)
      : candidates[0];
    if (revisionId && !revision) {
      throw new NotFoundException({ message: 'ملف إثبات العقار غير موجود', code: EvidenceErrorCode.NOT_FOUND });
    }
    const asset = revision?.privateEvidenceAssets?.[index] ?? (index === 0 ? item.titleDeed : undefined);
    if (!asset?.publicId) {
      throw new NotFoundException({ message: 'ملف إثبات العقار غير موجود', code: EvidenceErrorCode.NOT_FOUND });
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
    return images
      .map((image, index) => ({
        url: image.url,
        label: image.label,
        slotId: image.slotId,
        id: this.platformMediaIdentifier(image, index),
        tagCode: image.tagCode ?? this.mediaTagFromGuidedSlot(image.slotId),
        order: image.sortOrder ?? index,
        origin: image.origin ?? (image.slotId ? PropertyMediaOrigin.ADVERTISER : undefined),
      }))
      .sort((a, b) => a.order - b.order);
  }

  private revisionPublicImages(revision: any, legacyImages: PropertyAsset[] = []) {
    if (!revision) return legacyImages;
    const media = [...(revision.galleryMedia ?? [])];
    const historicalEntrance = revision.entranceImageAsset;
    if (historicalEntrance?.publicId && !media.some((asset) => asset.publicId === historicalEntrance.publicId)) {
      media.push(historicalEntrance);
    }
    return media;
  }

  private effectiveRevision(item: any, includePending: boolean) {
    const candidate = includePending
      ? (item.pendingRevisionId ?? item.draftRevision ?? item.currentPublicRevisionId)
      : item.currentPublicRevisionId;
    return candidate && typeof candidate === 'object' && (candidate.title || candidate.revisionNumber) ? candidate : undefined;
  }

  private populatedRevision(value: any) {
    return value && typeof value === 'object' && (value.title || value.revisionNumber) ? value : undefined;
  }

  private revisionSummary(revision: any) {
    if (!revision) return undefined;
    return {
      id: revision._id?.toString?.(),
      revisionNumber: revision.revisionNumber,
      status: revision.moderationStatus,
      version: revision.decisionVersion ?? revision.version ?? 0,
      submittedAt: revision.submittedAt,
      reviewedAt: revision.reviewedAt,
      reviewReason: revision.reviewReason,
    };
  }

  private revisionAdmin(revision: any) {
    if (!revision) return undefined;
    const guided = revision.marketingMode === PropertyMarketingMode.SELF_SERVICE;
    const requiredPhotoSlots = guided ? this.requiredPhotoSlots(revision) : [];
    const suppliedPhotoSlots = new Set((revision.galleryMedia ?? []).map((asset: PropertyAsset) => asset.slotId));
    const photoCount = (revision.galleryMedia ?? []).length;
    return {
      ...this.revisionSummary(revision),
      title: revision.title,
      description: revision.description,
      purposeCategoryId: revision.purposeCategoryId?.toString?.(),
      purposeSubcategoryId: revision.purposeSubcategoryId?.toString?.(),
      propertyTypeCode: revision.legacyPropertyTypeCode,
      governorateCode: revision.governorateCode,
      city: revision.city,
      district: revision.district,
      area: revision.area,
      bedrooms: revision.bedrooms,
      livingRooms: revision.livingRooms,
      kitchens: revision.kitchens,
      bathrooms: revision.bathrooms,
      totalPriceMinor: revision.totalPriceMinor,
      currency: revision.currency,
      paymentMethodCodes: revision.paymentMethodCodes,
      marketingMode: revision.marketingMode,
      images: this.publicImages(this.revisionPublicImages(revision)),
      mediaCompleteness: {
        requiredPhotoSlots,
        missingPhotoSlots: requiredPhotoSlots.filter(slotId => !suppliedPhotoSlots.has(slotId)),
        minimumPhotoCount: guided ? requiredPhotoSlots.length : 1,
        photoCount,
        complete: guided ? requiredPhotoSlots.every(slotId => suppliedPhotoSlots.has(slotId)) : photoCount >= 1,
      },
      privateEvidence: this.privateEvidenceDescriptors(revision, {}),
    };
  }

  private toMarketplacePublic(item: any) {
    const projected = this.projectProperty(item, false);
    const {
      advertiserAccountId: _advertiserAccountId,
      advertiserAccountTypeSnapshot: _advertiserAccountTypeSnapshot,
      createdByActorId: _createdByActorId,
      revisionId: _revisionId,
      revisionVersion: _revisionVersion,
      lifecycleVersion: _lifecycleVersion,
      pendingRevisionId: _pendingRevisionId,
      currentPublicRevisionId: _currentPublicRevisionId,
      reviewReason: _reviewReason,
      reviewedAt: _reviewedAt,
      ...safe
    } = projected;
    return safe;
  }

  private toOwner(item: any) {
    const result = this.projectProperty(item, true);
    const revision = this.effectiveRevision(item, true);
    return {
      ...result,
      street: revision?.street ?? item.street,
      additionalAddressDetails: revision?.additionalAddressDetails ?? item.additionalAddressDetails,
      latitude: revision?.latitude ?? item.latitude,
      longitude: revision?.longitude ?? item.longitude,
      livingRooms: revision?.livingRooms ?? item.livingRooms,
      kitchens: revision?.kitchens ?? item.kitchens,
      totalFloors: revision?.totalFloors ?? item.totalFloors,
      buildingYear: revision?.buildingYear ?? item.buildingYear,
      finishingStatusCode: revision?.finishingStatusCode ?? item.finishingStatusCode,
      deliveryStatusCode: revision?.deliveryStatusCode ?? item.deliveryStatusCode,
      amenityCodes: revision?.amenityCodes ?? item.amenityCodes,
      isPriceNegotiable: revision?.isPriceNegotiable ?? item.isPriceNegotiable,
      hidePhone: revision?.hidePhone ?? item.hidePhone,
      privateEvidence: this.privateEvidenceDescriptors(revision, item),
      hasTitleDeed: Boolean(revision?.privateEvidenceAssets?.length || item.titleDeed?.publicId),
    };
  }

  private projectProperty(item: any, includePending: boolean) {
    const revision = this.effectiveRevision(item, includePending);
    const source = revision ?? item;
    const money = revision
      ? { totalPriceMinor: revision.totalPriceMinor, currency: revision.currency }
      : item.propertyContractVersion >= 1 && isMoneyMinorAmount(item.totalPriceMinor, { positive: true }) && item.currency === EGP_CURRENCY
        ? { totalPriceMinor: item.totalPriceMinor, currency: EGP_CURRENCY }
        : propertyMoneyFromStoredRecord(item);
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
      images: this.publicImages(this.revisionPublicImages(revision, item.images)),
      coverImageIndex: source.coverImageIndex,
      advertiserType: item.advertiserType,
      isOwnerVisible: item.isOwnerVisible !== false,
      status: revision?.moderationStatus ?? item.status,
      reviewReason: revision?.reviewReason ?? item.reviewReason,
      reviewedAt: revision?.reviewedAt ?? item.reviewedAt,
      revisionVersion: revision?.decisionVersion ?? revision?.version ?? 0,
      lifecycleStatus: item.lifecycleStatus ?? PropertyLifecycleStatus.ACTIVE,
      lifecycleVersion: item.lifecycleVersion ?? 0,
      currentPublicRevisionId: item.currentPublicRevisionId?._id?.toString?.() ?? item.currentPublicRevisionId?.toString?.(),
      pendingRevisionId: item.pendingRevisionId?._id?.toString?.() ?? item.pendingRevisionId?.toString?.(),
      createdAt: item.createdAt,
    };
  }
  private toAdmin(item: any, detailed = false) {
    const account = item.advertiserAccountId && typeof item.advertiserAccountId === 'object' && item.advertiserAccountId.fullName ? item.advertiserAccountId : item.ownerId;
    const populatedOwner = account && typeof account === 'object' && account.fullName;
    const owner = populatedOwner ? { id: account._id.toString(), fullName: account.fullName, email: account.email, phone: account.phone } : undefined;
    const revision = this.effectiveRevision(item, true);
    const pending = this.populatedRevision(item.pendingRevisionId);
    const source = pending ?? revision ?? item;
    const pendingProjection = pending ? this.revisionAdmin(pending) : undefined;
    const base = { ...this.toOwner(item), ...(pendingProjection ? { ...pendingProjection, revisionId: pendingProjection.id } : {}), id: item._id.toString(), owner, status: pending ? PropertyRevisionModerationStatus.PENDING_REVIEW : (revision?.moderationStatus ?? item.status), reviewReason: pending?.reviewReason ?? item.reviewReason, reviewedAt: pending?.reviewedAt ?? item.reviewedAt };
    return detailed ? { ...base, street: source.street, additionalAddressDetails: source.additionalAddressDetails, latitude: source.latitude, longitude: source.longitude, bedrooms: source.bedrooms, livingRooms: source.livingRooms, kitchens: source.kitchens, bathrooms: source.bathrooms, floor: source.floor, totalFloors: source.totalFloors, buildingYear: source.buildingYear, finishingStatusCode: source.finishingStatusCode, deliveryStatusCode: source.deliveryStatusCode, amenityCodes: source.amenityCodes, isPriceNegotiable: source.isPriceNegotiable, paymentMethodCodes: revision?.paymentMethodCodes, paymentMethodCode: item.paymentMethodCode, advertiserType: item.advertiserType, hidePhone: source.hidePhone } : base;
  }

  private privateEvidenceDescriptors(revision: any, item: any) {
    const assets = revision?.privateEvidenceAssets ?? (item.titleDeed?.publicId ? [item.titleDeed] : []);
    return assets.map((asset: PropertyAsset, index: number) => ({
      id: String(index),
      label: asset.label ?? (index === 0 ? 'مستند الملكية' : `مستند خاص ${index + 1}`),
      contentType: asset.format === 'pdf' ? 'application/pdf' : `image/${asset.format === 'jpg' ? 'jpeg' : asset.format ?? 'jpeg'}`,
      revisionId: revision?._id?.toString?.(),
    }));
  }
}
