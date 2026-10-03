import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { Amenity, AmenityDocument } from '../amenities/schemas/amenity.schema';
import { Governorate, GovernorateDocument } from '../governorates/schemas/governorate.schema';
import { City, CityDocument } from '../governorates/schemas/city.schema';
import { PropertyOption, PropertyOptionDocument } from '../property-options/schemas/property-option.schema';
import { PropertyType, PropertyTypeDocument } from '../property-types/schemas/property-type.schema';
import { CreatePropertyDto } from './dto/create-property.dto';
import { ListPublishedPropertiesDto } from './dto/list-published-properties.dto';
import { GetFilterMetadataDto } from './dto/get-filter-metadata.dto';
import { facetMetadataForPropertyTypeCode } from './property-search-facets';
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
import { slotTag } from './media-profiles';
import { buildSpecifications, catalogReferences, deprecatedFlatFields, effectiveSpec, isPinnedRecord, type Specifications } from './property-specifications';
import { PropertyFormDefinitionVersion, type PropertyFormDefinitionVersionDocument } from '../property-form-definitions/schemas/property-form-definition-version.schema';
import { PropertyFormDefinition, type PropertyFormDefinitionDocument } from '../property-form-definitions/schemas/property-form-definition.schema';
import { LEGACY_RESIDENTIAL_CONTENT_HASH, type FormOperationType, type MediaProfile } from '../property-form-definitions/property-form-definition.constants';
import { LEGACY_ATTRIBUTE_KEYS, LEGACY_SPEC_FIELDS } from '../property-attributes/property-attribute.constants';
import { parseAttributes, propertyAttributesInvalid, propertyAttributesMalformed, validateAgainstVersion, type NormalizedAttributes, type ParsedAttributes } from '../common/validators/property-attributes';
import { FormDefinitionInvalidReason, assertAmenitySelection, approvedFacets, assertDraftMedia, assertDynamicPin, assertListingEnabled, assertMediaComplete, assertUsableVersion, carriedAttributes, catalogCandidates, classifyFormWrite, clientUpgradeRequired, currentPublishedForm, evaluateMedia, formDefinitionInvalid, formVersionOutdated, isListingEnabled, legacyAttributeInput, toParsedAttributes, type FormState, type FormVersionRecord, type FormWriteMode, type PropertyFacetValues } from './property-form-write';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';
import { IdempotencyService, canonicalize, sha256 } from '../common/idempotency/idempotency.service';
import { hasClearGovernorateConflict, isPointInsideEgypt } from '../common/validators/egypt-location.validator';
import { propertyDecisionEvent } from '../outbox/outbox-events';
import { OutboxService } from '../outbox/outbox.service';
import { PropertySubcategoriesInvalidReason, canonicalPropertyTypeOrder, normalizeSelectedPropertyTypeIds, selectedPropertyTypeIds, subcategoriesInvalid, toObjectIds } from './property-classification';

const PROPERTY_IMAGE_POLICY = { kind: 'image' as const, maxBytes: 10 * 1024 * 1024, maxImagePixels: 50_000_000 };
const PROPERTY_EVIDENCE_POLICY = { kind: 'document' as const, maxBytes: 10 * 1024 * 1024, maxImagePixels: 50_000_000, allowPdf: true };

/**
 * PropertyRevision fields read by the public projection chain
 * (`hydratePublicListings` -> `toMarketplacePublic` -> `projectProperty` / `publicImages`).
 * Fields `projectProperty` reads but `toMarketplacePublic` strips (reviewReason, reviewedAt,
 * decisionVersion, version) are deliberately not loaded. Extend this list whenever a public
 * projection starts reading another revision field.
 */
export const PUBLIC_REVISION_PROJECTION_FIELDS = [
  'revisionNumber', 'title', 'description', 'operationType',
  'purposeCategoryId', 'purposeSubcategoryId', 'purposeSubcategoryIds', 'legacyPropertyTypeCode',
  'governorateCode', 'city', 'district', 'area', 'bedrooms', 'bathrooms', 'floor',
  'totalPriceMinor', 'currency', 'paymentMethodCodes', 'marketingMode',
  'galleryMedia', 'entranceImageAsset', 'coverImageIndex', 'moderationStatus',
  // DPF-016: pinned revisions derive the deprecated flat spec fields from their attributes.
  'formDefinitionVersionId', 'attributes',
  // Phase 11: selected amenity codes, resolved to public catalog metadata by `toMarketplacePublic`.
  'amenityCodes',
] as const;
const PUBLIC_REVISION_SELECT = PUBLIC_REVISION_PROJECTION_FIELDS.join(' ');
type PropertyCreateFiles = {
  images?: Express.Multer.File[];
  titleDeed?: Express.Multer.File[];
};

/** The PRIMARY type's form a write is validated against and pinned to (DPF-020). */
type ResolvedWriteForm = {
  definitionId: Types.ObjectId;
  versionId: Types.ObjectId;
  version: number;
  contentHash: string;
  attributes: NormalizedAttributes;
  mediaProfile: MediaProfile;
  /** Catalog codes used by `attributes`, for the usage increment. */
  catalogReferences: Array<{ group: string; code: string }>;
};

/** Media profile and effective attributes that drive photo completeness (DPF-022). */
type MediaForm = { mediaProfile: MediaProfile; attributes: Readonly<Record<string, unknown>> };

/** Phase 11: one amenity as rendered in a public property detail response. */
type PublicAmenityView = { code: string; nameAr: string; nameEn: string; iconKey: string; category: string; sortOrder: number };
type PublicAmenity = Omit<PublicAmenityView, 'sortOrder'>;

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
    private readonly outbox: OutboxService,
    @Optional() private readonly idempotency?: IdempotencyService,
    @Optional() @InjectModel(PropertyFormDefinitionVersion.name) private readonly formVersions?: Model<PropertyFormDefinitionVersionDocument>,
    @Optional() @InjectModel(PropertyFormDefinition.name) private readonly formDefinitions?: Model<PropertyFormDefinitionDocument>,
  ) {}

  /** Digest of everything that defines a create/revision request, including file bytes. */
  private requestFingerprint(target: string, dto: CreatePropertyDto, files: PropertyCreateFiles): string {
    const digest = (list?: Express.Multer.File[]) =>
      (list ?? []).map((file) => `${file.fieldname}:${file.mimetype}:${sha256(file.buffer)}`);
    // The selected-type set is order-insensitive: one logical selection, one fingerprint.
    const identity: Record<string, unknown> = dto.purposeSubcategoryIds === undefined ? { ...dto } : { ...dto, purposeSubcategoryIds: canonicalPropertyTypeOrder(dto.purposeSubcategoryIds) };
    // The form pin is part of the DTO; the attribute map is fingerprinted by
    // content, so key order and whitespace in the JSON do not change it.
    if (dto.attributes !== undefined) {
      const parsed = parseAttributes(dto.attributes);
      identity.attributes = parsed.ok ? { parsed: { ...parsed.attributes } } : { raw: dto.attributes };
    }
    return sha256(canonicalize({ target, dto: identity, images: digest(files?.images), titleDeed: digest(files?.titleDeed) }));
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
    // Frozen §B1/§H5 form transport rules, before any database access.
    const formMode = classifyFormWrite(dto as unknown as Record<string, unknown>);
    if (!Object.values(PropertyMarketingMode).includes(dto.marketingMode)) {
      throw new BadRequestException({ message: 'وضع التسويق غير صالح', code: PropertyErrorCode.MARKETING_MODE_INVALID });
    }
    if (!Array.isArray(dto.paymentMethodCodes) || dto.paymentMethodCodes.length === 0 || new Set(dto.paymentMethodCodes).size !== dto.paymentMethodCodes.length) {
      throw new BadRequestException({ message: 'يجب اختيار طرق سداد صالحة وغير مكررة', code: PropertyErrorCode.PAYMENT_METHODS_INVALID });
    }
    // A draft may be saved without its presentation photos; completeness is
    // enforced when it is submitted (DPF-022, frozen §I).
    const images = files?.images ?? [];
    if (images.length > 20) throw new BadRequestException({ message: 'عدد صور العقار يتجاوز الحد المسموح', code: EvidenceErrorCode.FILE_COUNT_EXCEEDED });
    if (dto.imageLabels.length !== images.length) throw new BadRequestException('عدد مسميات الصور لا يطابق عدد الصور');
    if (!Array.isArray(dto.imageSlotIds) || dto.imageSlotIds.length !== images.length || new Set(dto.imageSlotIds).size !== dto.imageSlotIds.length) {
      throw new BadRequestException({ message: 'تصنيفات صور العقار غير صالحة', code: EvidenceErrorCode.REQUIRED_PHOTO_SLOTS_MISSING });
    }
    if (images.length ? dto.coverImageIndex >= images.length : dto.coverImageIndex !== 0) {
      throw new BadRequestException('صورة الغلاف المحددة غير صالحة');
    }
    // Legacy clients keep today's exact message; the form's cross-field rule also covers it.
    if (formMode === 'legacy' && dto.floor !== undefined && dto.totalFloors !== undefined && dto.floor > dto.totalFloors) {
      throw new BadRequestException('رقم الطابق لا يمكن أن يتجاوز عدد الطوابق');
    }
    const detectedImages = images.map((image) => validateEvidenceFile(image, PROPERTY_IMAGE_POLICY));
    const deedFile = files.titleDeed?.[0];
    const detectedDeed = deedFile ? validateEvidenceFile(deedFile, PROPERTY_EVIDENCE_POLICY) : undefined;

    const [purpose, type, governorate, finishing, delivery, payments, amenityCount] = await Promise.all([
      this.purposeCategories.findOne({ _id: dto.purposeCategoryId, isActive: true }).lean().exec(),
      this.propertyTypes.findOne({ _id: dto.purposeSubcategoryId, isActive: true }).lean().exec(),
      this.governorates.findOne({ code: dto.governorateCode, isActive: true }).lean().exec(),
      // Legacy clients keep today's catalog error; dynamic catalog values go through the form validator.
      formMode === 'legacy' && dto.finishingStatusCode !== undefined ? this.options.findOne({ group: 'finishing_status', code: dto.finishingStatusCode, isActive: true }).lean().exec() : undefined,
      formMode === 'legacy' && dto.deliveryStatusCode !== undefined ? this.options.findOne({ group: 'delivery_status', code: dto.deliveryStatusCode, isActive: true }).lean().exec() : undefined,
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
    const selectedTypeIds = await this.resolveSelectedPropertyTypeIds(dto, purpose._id, type, existingProperty, existingDraft);
    if (governorate && !city && !legacyCityAllowed) {
      throw new BadRequestException({ message: 'المدينة غير موجودة أو لا تتبع المحافظة المحددة', code: PropertyErrorCode.CATALOG_VALUE_INVALID });
    }
    if (governorate && hasClearGovernorateConflict(dto.latitude, dto.longitude, dto.governorateCode)) {
      throw new BadRequestException({ message: 'إحداثيات العقار لا تتوافق مع المحافظة المحددة', code: 'PROPERTY_LOCATION_GOVERNORATE_MISMATCH' });
    }
    if (payments.length !== dto.paymentMethodCodes.length) {
      throw new BadRequestException({ message: 'إحدى طرق السداد غير موجودة أو غير متاحة', code: PropertyErrorCode.PAYMENT_METHODS_INVALID });
    }
    const invalid = [
      !governorate && 'المحافظة',
      formMode === 'legacy' && dto.finishingStatusCode !== undefined && !finishing && 'حالة التشطيب',
      formMode === 'legacy' && dto.deliveryStatusCode !== undefined && !delivery && 'جاهزية التسليم',
    ].filter(Boolean);
    if (invalid.length || amenityCount !== dto.amenityCodes.length) throw new BadRequestException(`بعض الاختيارات غير موجودة أو غير متاحة: ${invalid.join('، ')}${amenityCount !== dto.amenityCodes.length ? `${invalid.length ? '، ' : ''}المميزات والخدمات` : ''}`);
    // The legacy lookups above already proved these codes active; the form validator reuses that.
    const knownActiveCatalog = [
      ...(finishing ? [{ group: 'finishing_status', code: dto.finishingStatusCode! }] : []),
      ...(delivery ? [{ group: 'delivery_status', code: dto.deliveryStatusCode! }] : []),
    ];
    const form = await this.resolveWriteForm(dto, formMode, selectedTypeIds, type._id, knownActiveCatalog, existingProperty, existingDraft);
    // Frozen §I draft rules for the primary form's media profile: valid slot ids,
    // no reused content across required slots, no completeness requirement.
    assertDraftMedia(evaluateMedia(form.mediaProfile, form.attributes, dto.imageSlotIds.map((slotId, index) => ({ slotId, digest: sha256(images[index].buffer) }))));

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
          tagCode: slotTag(form.mediaProfile, dto.imageSlotIds[i]),
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
        purposeSubcategoryIds: selectedTypeIds,
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
        // Frozen §A5: every new revision is pinned to its PRIMARY type's form;
        // the legacy flat spec fields are never written on pinned revisions.
        formDefinitionId: form.definitionId,
        formDefinitionVersionId: form.versionId,
        formDefinitionVersion: form.version,
        formContentHash: form.contentHash,
        attributes: form.attributes,
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
        purposeSubcategoryIds: selectedTypeIds,
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
        // New aggregates no longer carry the legacy spec fields (frozen §A5); reads use the revision.
        area: dto.area,
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
            // A legacy draft re-saved as a pinned one drops its flat spec fields.
            for (const field of LEGACY_SPEC_FIELDS) replacement[field] = undefined;
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
            // One increment per selected type (the primary is in the set exactly once).
            this.propertyTypes.updateMany({ _id: { $in: selectedTypeIds }, purposeCategoryId: purpose._id, isActive: true }, { $inc: { usageCount: 1 } }, { session }).exec(),
            this.governorates.updateOne({ code: dto.governorateCode, isActive: true }, { $inc: { usageCount: 1 } }, { session }).exec(),
            city
              ? this.cities.updateOne({ _id: city._id, governorateId: governorate!._id, isActive: true }, { $inc: { usageCount: 1 } }, { session }).exec()
              : Promise.resolve({ matchedCount: legacyCityAllowed ? 1 : 0 }),
            // Catalog-backed attribute values (the form's finishing/delivery codes) plus payment methods.
            this.options.updateMany({ $or: [
              ...form.catalogReferences.map(({ group, code }) => ({ group, code, isActive: true })),
              { group: 'payment_method', code: { $in: dto.paymentMethodCodes }, isActive: true },
            ] }, { $inc: { usageCount: 1 } }, { session }).exec(),
            dto.amenityCodes.length ? this.amenities.updateMany({ code: { $in: dto.amenityCodes }, isActive: true }, { $inc: { usageCount: 1 } }, { session }).exec() : Promise.resolve({ matchedCount: 0 }),
          ]);
          if (purposeUsage.matchedCount !== 1 || typeUsage.matchedCount !== selectedTypeIds.length) {
            throw new BadRequestException({ message: 'تم تغيير تصنيف غرض العقار؛ أعد تحميل الخيارات', code: PropertyErrorCode.PURPOSE_HIERARCHY_MISMATCH });
          }
          if (governorateUsage.matchedCount !== 1 || cityUsage.matchedCount !== 1 || optionUsage.matchedCount !== dto.paymentMethodCodes.length + form.catalogReferences.length || amenityUsage.matchedCount !== dto.amenityCodes.length) {
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

  /**
   * Full type selection for a write (DPF-005). An explicit `purposeSubcategoryIds`
   * is validated and canonicalized. Without it (a pre-multi-type client), an edit
   * whose primary is unchanged keeps the latest revision's other selected types
   * that are still valid; any other request selects only the primary.
   */
  private async resolveSelectedPropertyTypeIds(dto: CreatePropertyDto, purposeId: unknown, primary: { _id: unknown }, existingProperty?: any, existingDraft?: any): Promise<Types.ObjectId[]> {
    const primaryId = String(primary._id).toLowerCase();
    if (dto.purposeSubcategoryIds !== undefined) {
      const selected = normalizeSelectedPropertyTypeIds(primaryId, dto.purposeSubcategoryIds);
      await this.assertAdditionalPropertyTypes(selected.filter((id) => id !== primaryId), purposeId);
      return toObjectIds(selected);
    }
    const previous = existingDraft ?? (existingProperty
      ? await this.revisions.findOne({ propertyId: existingProperty._id }).sort({ revisionNumber: -1 }).select({ purposeSubcategoryId: 1, purposeSubcategoryIds: 1 }).lean().exec()
      : undefined);
    const carried = previous && String(previous.purposeSubcategoryId).toLowerCase() === primaryId
      ? canonicalPropertyTypeOrder(selectedPropertyTypeIds(previous)).filter((id) => id !== primaryId)
      : [];
    const stillValid = carried.length
      ? new Set((await this.propertyTypes.find({ _id: { $in: carried }, isActive: true, purposeCategoryId: purposeId }).lean().exec()).map((item) => item._id.toString()))
      : new Set<string>();
    // Amendment §5.9: carried types must still pass rules 3-4 (rule 4: listing-enabled).
    const carriedValid = carried.filter((id) => stillValid.has(id));
    const formState = carriedValid.length ? await this.loadFormState(carriedValid) : undefined;
    return toObjectIds(canonicalPropertyTypeOrder([primaryId, ...carriedValid.filter((id) => isListingEnabled(id, formState!))]));
  }

  /**
   * FormDefinition heads of the given property types and the versions they
   * point to, plus any extra version ids (a pinned or submitted version).
   */
  private async loadFormState(typeIds: readonly string[], versionIds: readonly string[] = [], session?: ClientSession): Promise<FormState> {
    if (!this.formDefinitions || !this.formVersions) throw new Error('PropertyFormDefinition models are not registered');
    const inSession = <T extends { session(value: ClientSession): T }>(query: T): T => (session ? query.session(session) : query);
    const heads = typeIds.length
      ? await inSession(this.formDefinitions.find({ purposeSubcategoryId: { $in: toObjectIds([...new Set(typeIds.map((value) => value.toLowerCase()))]) } })).lean().exec()
      : [];
    const ids = [...new Set([
      ...heads.map((head) => head.currentVersionId).filter(Boolean).map((value) => String(value).toLowerCase()),
      ...versionIds.map((value) => String(value).toLowerCase()),
    ])].filter((value) => /^[a-f0-9]{24}$/.test(value));
    const versions = ids.length ? await inSession(this.formVersions.find({ _id: { $in: toObjectIds(ids) } })).lean().exec() : [];
    return {
      headByType: new Map(heads.map((head) => [String(head.purposeSubcategoryId).toLowerCase(), head as any])),
      versionById: new Map(versions.map((version) => [String(version._id).toLowerCase(), version as unknown as FormVersionRecord])),
    };
  }

  /** `group:code` of every candidate that is an active catalog option now; `known` needs no lookup. */
  private async activeCatalogCodes(candidates: Array<{ group: string; code: string }>, known: Array<{ group: string; code: string }> = [], session?: ClientSession): Promise<Set<string>> {
    const active = new Set(known.map(({ group, code }) => `${group}:${code}`));
    const unknown = candidates.filter(({ group, code }) => !active.has(`${group}:${code}`));
    if (unknown.length) {
      const lookup = this.options.find({ isActive: true, $or: unknown.map(({ group, code }) => ({ group, code })) });
      if (session) lookup.session(session);
      for (const option of await lookup.lean().exec()) active.add(`${option.group}:${option.code}`);
    }
    return active;
  }

  /**
   * DPF-020: the PRIMARY type's form for a create or draft save, and the
   * validated attributes to pin. Dynamic writes must name the current
   * published version (frozen §B1, §C); legacy writes are mapped onto the
   * current version when it is legacy-writable (frozen §H4). Every other
   * selected type must be listing-enabled (amendment rule 4) and never
   * contributes fields.
   */
  private async resolveWriteForm(
    dto: CreatePropertyDto,
    mode: FormWriteMode,
    selectedTypeIds: readonly Types.ObjectId[],
    primaryTypeId: unknown,
    knownActiveCatalog: Array<{ group: string; code: string }>,
    existingProperty?: any,
    existingDraft?: any,
  ): Promise<ResolvedWriteForm> {
    const primary = String(primaryTypeId).toLowerCase();
    const selected = canonicalPropertyTypeOrder(selectedTypeIds);
    const operationType = dto.operationType as FormOperationType;
    const state = await this.loadFormState(selected, mode === 'dynamic' ? [dto.formDefinitionVersionId!] : []);
    let current;
    let input: ParsedAttributes;
    let carried: ParsedAttributes = Object.create(null);
    if (mode === 'dynamic') {
      current = assertDynamicPin(dto, state.versionById.get(String(dto.formDefinitionVersionId).toLowerCase()), primary, state);
      const parsed = parseAttributes(dto.attributes);
      if ('reason' in parsed) throw propertyAttributesMalformed(parsed.reason);
      input = parsed.attributes;
    } else {
      current = currentPublishedForm(primary, state);
      if (current.version.legacyWritable !== true) throw clientUpgradeRequired(primary);
      assertUsableVersion(current.version, primary);
      input = legacyAttributeInput(dto as unknown as Record<string, unknown>, current.version);
      carried = carriedAttributes(await this.carryForwardSource(primary, current.head._id, current.version, existingProperty, existingDraft), current.version, operationType, input);
    }
    assertListingEnabled(selected.filter((typeId) => typeId !== primary), state);
    assertAmenitySelection(current.version, dto.amenityCodes);

    const validate = async (attributes: ParsedAttributes) => {
      const active = await this.activeCatalogCodes(catalogCandidates(current.version, attributes), knownActiveCatalog);
      return validateAgainstVersion(current.version, operationType, attributes, (group, code) => active.has(`${group}:${code}`));
    };
    const merged = (extra: ParsedAttributes) => Object.assign(Object.create(null), extra, input) as ParsedAttributes;
    let result = await validate(merged(carried));
    if ('fieldErrors' in result) {
      // A carried value the old client cannot see is dropped rather than blocking the write.
      const failedCarried = result.fieldErrors.map((error) => error.key).filter((key) => Object.prototype.hasOwnProperty.call(carried, key));
      if (failedCarried.length) {
        for (const key of failedCarried) delete carried[key];
        result = await validate(merged(carried));
      }
    }
    if ('fieldErrors' in result) throw propertyAttributesInvalid(String(current.version._id), result.fieldErrors);
    return {
      definitionId: new Types.ObjectId(String(current.head._id)),
      versionId: new Types.ObjectId(String(current.version._id)),
      version: current.version.version!,
      contentHash: current.version.contentHash!,
      attributes: result.attributes,
      mediaProfile: current.version.mediaProfile,
      catalogReferences: catalogCandidates(current.version, result.attributes),
    };
  }

  /**
   * Frozen §H4 carry-forward source: the property's draft, else its current
   * public revision, when it is pinned to the same primary type's definition.
   * Only loaded when the current version has non-legacy fields to carry.
   */
  private async carryForwardSource(primary: string, definitionId: unknown, version: FormVersionRecord, existingProperty?: any, existingDraft?: any): Promise<Record<string, unknown> | undefined> {
    if (!existingProperty || !version.fields.some((field) => !LEGACY_ATTRIBUTE_KEYS.includes(field.key))) return undefined;
    const previous = existingDraft ?? (existingProperty.currentPublicRevisionId
      ? await this.revisions.findOne({ _id: existingProperty.currentPublicRevisionId, propertyId: existingProperty._id }).select({ purposeSubcategoryId: 1, formDefinitionId: 1, formDefinitionVersionId: 1, attributes: 1 }).lean().exec()
      : undefined);
    if (!previous || !isPinnedRecord(previous) || String(previous.purposeSubcategoryId).toLowerCase() !== primary || String(previous.formDefinitionId).toLowerCase() !== String(definitionId).toLowerCase()) return undefined;
    return previous.attributes as Record<string, unknown>;
  }

  /**
   * DPF-021 submit: every selected type still listing-enabled, the PRIMARY
   * type's pinned version still current (409 otherwise, never an automatic
   * upgrade), and the attributes re-validated against it with live catalog
   * codes. A legacy draft saved before pinning submits only while the current
   * version is still the legacy form it was written for.
   */
  private async submissionForm(revision: any, session: ClientSession): Promise<MediaForm> {
    const primary = String(revision.purposeSubcategoryId).toLowerCase();
    const selected = canonicalPropertyTypeOrder(selectedPropertyTypeIds(revision));
    const pinned = isPinnedRecord(revision);
    const state = await this.loadFormState(selected, pinned ? [String(revision.formDefinitionVersionId)] : [], session);
    const current = currentPublishedForm(primary, state);
    assertListingEnabled(selected.filter((typeId) => typeId !== primary), state);
    let stored: Record<string, unknown>;
    if (pinned) {
      if (String(revision.formDefinitionId).toLowerCase() !== String(current.head._id).toLowerCase()) {
        throw formDefinitionInvalid(FormDefinitionInvalidReason.DEFINITION_MISMATCH, { purposeSubcategoryId: primary });
      }
      if (String(revision.formDefinitionVersionId).toLowerCase() !== String(current.version._id).toLowerCase()) {
        throw formVersionOutdated(current, { versionId: revision.formDefinitionVersionId, version: revision.formDefinitionVersion });
      }
      if (revision.formContentHash !== current.version.contentHash || revision.formDefinitionVersion !== current.version.version) {
        throw formDefinitionInvalid(FormDefinitionInvalidReason.CONTENT_HASH_MISMATCH, { purposeSubcategoryId: primary });
      }
      stored = revision.attributes ?? {};
    } else {
      if (current.version.contentHash !== LEGACY_RESIDENTIAL_CONTENT_HASH) throw formVersionOutdated(current, null);
      stored = effectiveSpec(revision).attributes;
    }
    assertUsableVersion(current.version, primary);
    const parsed = toParsedAttributes(stored);
    const active = await this.activeCatalogCodes(catalogCandidates(current.version, parsed), [], session);
    const result = validateAgainstVersion(current.version, revision.operationType, parsed, (group, code) => active.has(`${group}:${code}`));
    if ('fieldErrors' in result) throw propertyAttributesInvalid(String(current.version._id), result.fieldErrors);
    assertAmenitySelection(current.version, revision.amenityCodes ?? []);
    return { mediaProfile: current.version.mediaProfile, attributes: result.attributes };
  }

  /**
   * Frozen §C approve: structure only, against the pinned version, which may
   * have been superseded meanwhile (no currency or catalog-active check). A
   * legacy revision is read through the legacy adapter, as today.
   */
  private async approvalForm(revision: any, session: ClientSession): Promise<MediaForm> {
    if (!isPinnedRecord(revision)) return { mediaProfile: 'residential_rooms', attributes: effectiveSpec(revision).attributes };
    const primary = String(revision.purposeSubcategoryId).toLowerCase();
    const state = await this.loadFormState([], [String(revision.formDefinitionVersionId)], session);
    const version = state.versionById.get(String(revision.formDefinitionVersionId).toLowerCase());
    if (!version) throw formDefinitionInvalid(FormDefinitionInvalidReason.VERSION_NOT_FOUND, { purposeSubcategoryId: primary });
    if (version.state === 'draft') throw formDefinitionInvalid(FormDefinitionInvalidReason.VERSION_NOT_PUBLISHED, { purposeSubcategoryId: primary });
    if (String(version.purposeSubcategoryId).toLowerCase() !== primary) throw formDefinitionInvalid(FormDefinitionInvalidReason.SUBCATEGORY_MISMATCH, { purposeSubcategoryId: primary });
    if (String(version.definitionId).toLowerCase() !== String(revision.formDefinitionId).toLowerCase()) throw formDefinitionInvalid(FormDefinitionInvalidReason.DEFINITION_MISMATCH, { purposeSubcategoryId: primary });
    if (revision.formContentHash !== version.contentHash || revision.formDefinitionVersion !== version.version) {
      throw formDefinitionInvalid(FormDefinitionInvalidReason.CONTENT_HASH_MISMATCH, { purposeSubcategoryId: primary });
    }
    assertUsableVersion(version, primary);
    const result = validateAgainstVersion(version, revision.operationType, toParsedAttributes(revision.attributes), () => true);
    if ('fieldErrors' in result) throw propertyAttributesInvalid(String(version._id), result.fieldErrors);
    assertAmenitySelection(version, revision.amenityCodes ?? []);
    return { mediaProfile: version.mediaProfile, attributes: effectiveSpec(revision).attributes };
  }

  /**
   * Approval publishes the revision's classification, so additional types that
   * became inactive, moved purpose or lost their published form since submit
   * must not survive into the public revision. The primary type's pinned form
   * keeps its own frozen approval rules (`approvalForm`).
   */
  private async assertAdditionalTypesStillAvailable(revision: any, session: ClientSession) {
    const primary = String(revision.purposeSubcategoryId).toLowerCase();
    const additional = canonicalPropertyTypeOrder(selectedPropertyTypeIds(revision)).filter((typeId) => typeId !== primary);
    if (!additional.length) return;
    await this.assertAdditionalPropertyTypes(additional, revision.purposeCategoryId, session);
    assertListingEnabled(additional, await this.loadFormState(additional, [], session));
  }

  /** Non-primary selected types must exist, be active and belong to the listing's purpose. */
  private async assertAdditionalPropertyTypes(additionalIds: string[], purposeId: unknown, session?: ClientSession) {
    if (!additionalIds.length) return;
    const lookup = this.propertyTypes.find({ _id: { $in: additionalIds } });
    if (session) lookup.session(session);
    const byId = new Map((await lookup.lean().exec()).map((item) => [item._id.toString(), item]));
    const inactive = additionalIds.filter((id) => !byId.get(id)?.isActive);
    if (inactive.length) throw subcategoriesInvalid(PropertySubcategoriesInvalidReason.INACTIVE, { invalidIds: inactive });
    const mismatched = additionalIds.filter((id) => byId.get(id)!.purposeCategoryId?.toString() !== String(purposeId));
    if (mismatched.length) {
      throw new BadRequestException({ message: 'نوع العقار الفرعي لا يتبع غرض العقار المحدد', code: PropertyErrorCode.PURPOSE_HIERARCHY_MISMATCH, details: { invalidIds: mismatched } });
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
      items: await this.withOwnerSpecifications(items.map(i => ({ ...i, draftRevision: latest.get(i._id.toString()) }))),
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
    const [owned] = await this.withOwnerSpecifications([{ ...item, draftRevision }]);
    return { property: { ...owned, revisions: revisions.map(revision => this.revisionSummary(revision)) } };
  }
  async listPublished(query: ListPublishedPropertiesDto = {}) {
    const { filter: dimensionFilter, sort, page, limit } = await this.buildPublicListingQuery(query);
    const filter = { ...this.publicVisibilityFilter(), ...dimensionFilter };
    const [items, total] = await Promise.all([
      this.properties.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).populate({ path: 'currentPublicRevisionId', select: PUBLIC_REVISION_SELECT }).lean().exec(),
      this.properties.countDocuments(filter).exec(),
    ]);
    return {
      items: await this.hydratePublicListings(items),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * `GET /properties/filter-metadata` (Phase 9). Returns only the promoted
   * facets applicable to the given primary type, in a fixed deterministic
   * order. No type given -> no non-residential facets (`[]`); an unknown
   * type follows the same public-catalog error convention `buildPublicListingQuery`
   * already uses for an invalid `purposeSubcategoryId`.
   */
  async getFilterMetadata(query: GetFilterMetadataDto) {
    if (!query.purposeSubcategoryId) return { facets: [] };
    const type = await this.propertyTypes.findById(query.purposeSubcategoryId).lean().exec();
    if (!type) throw new BadRequestException({ message: 'نوع العقار الفرعي غير موجود', code: PropertyErrorCode.PURPOSE_SUBCATEGORY_INVALID });
    return { facets: facetMetadataForPropertyTypeCode(type.code) };
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
      // DPF-007: matches listings that selected this type as primary or additional.
      // Relies on migration 022 having backfilled purposeSubcategoryIds.
      filter.purposeSubcategoryIds = subcategory._id;
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

    // Phase 9 (Search & Facets): explicit predicates on `Property.facets` for
    // the 7 approved promoted keys only — never a generic attr.*/JSON filter.
    // A facet irrelevant to the resolved type is not rejected; it simply
    // matches nothing (no listing of another type ever has that facet key).
    if (query.shopFloorLevel) filter['facets.shopFloorLevel'] = query.shopFloorLevel;
    if (query.commercialUseTypes?.length) filter['facets.commercialUseTypes'] = { $in: query.commercialUseTypes };
    if (query.powerSource) filter['facets.powerSource'] = query.powerSource;
    if (query.industrialUseType) filter['facets.industrialUseType'] = query.industrialUseType;
    if (query.soilType) filter['facets.soilType'] = query.soilType;
    if (query.waterSource) filter['facets.waterSource'] = query.waterSource;

    if (query.minBuiltAreaSqm !== undefined || query.maxBuiltAreaSqm !== undefined) {
      if (query.minBuiltAreaSqm !== undefined && query.maxBuiltAreaSqm !== undefined && query.minBuiltAreaSqm > query.maxBuiltAreaSqm) {
        throw new BadRequestException({ message: 'الحد الأدنى للمساحة المبنية أكبر من الحد الأقصى المحدد', code: PropertyErrorCode.FACET_RANGE_INVALID });
      }
      filter['facets.builtAreaSqm'] = {
        ...(query.minBuiltAreaSqm !== undefined ? { $gte: query.minBuiltAreaSqm } : {}),
        ...(query.maxBuiltAreaSqm !== undefined ? { $lte: query.maxBuiltAreaSqm } : {}),
      };
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
    const subcategoryIds = currentRevisions.flatMap(revision => selectedPropertyTypeIds(revision));
    const paymentCodes = currentRevisions.flatMap(revision => revision?.paymentMethodCodes ?? []);
    const [governorates, propertyTypes, purposes, paymentMethods, amenityCatalog] = await Promise.all([
      this.governorates.find({ code: { $in: [...new Set(currentRevisions.map((revision, index) => revision?.governorateCode ?? items[index].governorateCode))] } }).lean().exec(),
      this.propertyTypes.find({ $or: [{ _id: { $in: subcategoryIds } }, { code: { $in: [...new Set(currentRevisions.map((revision, index) => revision?.legacyPropertyTypeCode ?? items[index].propertyTypeCode))] } }] }).lean().exec(),
      this.purposeCategories.find({ _id: { $in: purposeIds } }).lean().exec(),
      this.options.find({ group: 'payment_method', code: { $in: paymentCodes } }).lean().exec(),
      this.publicAmenityCatalog(),
    ]);
    const governorateNames = new Map(governorates.map(item => [item.code, item.nameAr]));
    const propertyTypeNames = new Map(propertyTypes.map(item => [item.code, item.nameAr]));
    const propertyTypesById = new Map(propertyTypes.map(item => [item._id.toString(), item]));
    const purposeNames = new Map(purposes.map(item => [item._id.toString(), item.nameAr]));
    const paymentNames = new Map(paymentMethods.map(item => [item.code, item.nameAr]));
    return items.map(item => {
      const revision = this.populatedRevision(item.currentPublicRevisionId);
      return {
        ...this.toMarketplacePublic(item, amenityCatalog),
        governorateNameAr: governorateNames.get(revision?.governorateCode ?? item.governorateCode) ?? (revision?.governorateCode ?? item.governorateCode),
        purposeCategoryNameAr: revision?.purposeCategoryId ? purposeNames.get(revision.purposeCategoryId.toString()) : undefined,
        propertyTypeNameAr: revision?.purposeSubcategoryId ? propertyTypesById.get(revision.purposeSubcategoryId.toString())?.nameAr : (propertyTypeNames.get(item.propertyTypeCode) ?? item.propertyTypeCode),
        propertyTypes: this.propertyTypesView(revision, propertyTypesById),
        paymentMethodNamesAr: (revision?.paymentMethodCodes ?? []).map((code: string) => paymentNames.get(code)).filter(Boolean),
      };
    });
  }

  async getPublished(id: string) {
    this.assertId(id);
    const item = await this.properties.findOne({ _id: id, ...this.publicVisibilityFilter() }).populate('currentPublicRevisionId').lean().exec();
    if (!item || !this.populatedRevision(item.currentPublicRevisionId)) throw new NotFoundException('العقار غير موجود');
    const revision = this.populatedRevision(item.currentPublicRevisionId)!;
    const selectedTypeIds = selectedPropertyTypeIds(revision);
    const [purpose, types, governorate, paymentMethods, amenityCatalog] = await Promise.all([
      revision.purposeCategoryId ? this.purposeCategories.findById(revision.purposeCategoryId).lean().exec() : undefined,
      selectedTypeIds.length ? this.propertyTypes.find({ _id: { $in: selectedTypeIds } }).lean().exec() : [],
      this.governorates.findOne({ code: revision.governorateCode }).lean().exec(),
      this.options.find({ group: 'payment_method', code: { $in: revision.paymentMethodCodes ?? [] } }).lean().exec(),
      this.publicAmenityCatalog(),
    ]);
    const typesById = new Map<string, any>(types.map((value: any): [string, any] => [value._id.toString(), value]));
    const [specifications] = await this.specificationsFor([revision]);
    return { property: {
      ...this.toMarketplacePublic(item, amenityCatalog),
      specifications,
      purposeCategoryNameAr: purpose?.nameAr,
      propertyTypeNameAr: (revision.purposeSubcategoryId ? typesById.get(revision.purposeSubcategoryId.toString())?.nameAr : undefined) ?? revision.legacyPropertyTypeCode,
      governorateNameAr: governorate?.nameAr ?? revision.governorateCode,
      paymentMethodNamesAr: paymentMethods.map(item => item.nameAr),
      propertyTypes: this.propertyTypesView(revision, typesById),
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
    // Set-membership form of "not hidden by the owner" / "not archived or admin-hidden".
    // Equivalent to { $ne: false } / { $nin: [archived, admin_hidden] } for boolean and
    // three-valued enum fields (null also matches a missing field, as before), but the
    // point intervals let MongoDB merge index ranges to serve the listing sort (Phase 13).
    // The integrity check PROPERTY_VISIBILITY_FIELD_INVALID guards that equivalence.
    return {
      status: 'approved',
      isOwnerVisible: { $in: [true, null] },
      lifecycleStatus: { $in: [PropertyLifecycleStatus.ACTIVE, null] },
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
    const items = await this.properties.find({ _id: { $in: validIds }, ...this.publicVisibilityFilter() }).populate({ path: 'currentPublicRevisionId', select: PUBLIC_REVISION_SELECT }).lean().exec();
    const hydrated = await this.hydratePublicListings(items);
    return new Map(hydrated.map((item) => [item.id, item]));
  }

  async updateOwnerVisibility(ownerId: string, id: string, isVisible: boolean) {
    this.assertId(id);
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
    const primaryTypeId = String(revision.purposeSubcategoryId).toLowerCase();
    await this.assertAdditionalPropertyTypes(canonicalPropertyTypeOrder(selectedPropertyTypeIds(revision)).filter((id) => id !== primaryTypeId), purpose._id, session);
    if (paymentCount !== paymentMethodCodes.length) throw new BadRequestException({ message: 'إحدى طرق السداد غير متاحة', code: PropertyErrorCode.PAYMENT_METHODS_INVALID });
    const form = await this.submissionForm(revision, session);
    if (revision.marketingMode === PropertyMarketingMode.SELF_SERVICE) {
      this.assertPresentationMediaComplete(revision, form, 'submit');
    }
  }

  /**
   * Presentation completeness (frozen §I): SELF_SERVICE against the PRIMARY
   * form's media profile and the revision's effective attributes;
   * PLATFORM_MANAGED needs one photo, unchanged. Without `form` the revision
   * is a legacy one (residential_rooms over its flat fields).
   */
  private assertPresentationMediaComplete(revision: any, form?: MediaForm, stage: 'submit' | 'approval' = 'approval') {
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
    if (!form && isPinnedRecord(revision)) throw new Error('A pinned revision needs its form to check media completeness');
    const resolved = form ?? { mediaProfile: 'residential_rooms' as MediaProfile, attributes: effectiveSpec(revision).attributes };
    const entries = (revision.galleryMedia ?? []).map((asset: PropertyAsset) => ({ slotId: asset.slotId, digest: asset.contentDigest }));
    assertMediaComplete(evaluateMedia(resolved.mediaProfile, resolved.attributes, entries), stage);
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
    return slotTag('residential_rooms', slotId);
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
    const classified = items.map(item => this.populatedRevision(item.pendingRevisionId) ?? this.effectiveRevision(item, true));
    const [types, mediaProfiles] = await Promise.all([
      this.propertyTypes.find({ _id: { $in: classified.flatMap(revision => selectedPropertyTypeIds(revision)) } }).lean().exec(),
      this.mediaProfilesFor(items.map(item => this.populatedRevision(item.pendingRevisionId))),
    ]);
    const typesById = new Map(types.map(value => [value._id.toString(), value]));
    return {
      items: items.map((item, index) => ({ ...this.toAdmin(item, false, mediaProfiles), propertyTypes: this.propertyTypesView(classified[index], typesById) })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getForAdmin(id: string) {
    this.assertId(id);
    const item = await this.properties.findById(id).populate('ownerId', 'fullName email phone').populate('advertiserAccountId', 'fullName email phone accountType').populate('pendingRevisionId').populate('currentPublicRevisionId').lean().exec();
    if (!item) throw new NotFoundException('العقار غير موجود');
    const revisions = await this.revisions.find({ propertyId: item._id }).sort({ revisionNumber: -1 }).lean().exec();
    const [purposes, types, payments] = await Promise.all([
      this.purposeCategories.find({ _id: { $in: revisions.map(revision => revision.purposeCategoryId).filter(Boolean) } }).lean().exec(),
      this.propertyTypes.find({ _id: { $in: revisions.flatMap(revision => selectedPropertyTypeIds(revision)) } }).lean().exec(),
      this.options.find({ group: 'payment_method', code: { $in: revisions.flatMap(revision => revision.paymentMethodCodes ?? []) } }).lean().exec(),
    ]);
    const purposeNames = new Map(purposes.map(value => [value._id.toString(), value.nameAr]));
    const typesById = new Map(types.map(value => [value._id.toString(), value]));
    const paymentNames = new Map(payments.map(value => [value.code, value.nameAr]));
    const [revisionSpecifications, mediaProfiles] = await Promise.all([
      this.specificationsFor(revisions),
      this.mediaProfilesFor([...revisions, this.populatedRevision(item.pendingRevisionId)]),
    ]);
    const specificationsById = new Map(revisions.map((revision, index) => [revision._id.toString(), revisionSpecifications[index]]));
    const present = (revision: any) => {
      const result = this.revisionAdmin(revision, mediaProfiles);
      if (!result) return undefined;
      return {
        ...result,
        specifications: specificationsById.get(revision._id.toString()),
        purposeCategoryNameAr: revision.purposeCategoryId ? purposeNames.get(revision.purposeCategoryId.toString()) : undefined,
        propertyTypeNameAr: revision.purposeSubcategoryId ? typesById.get(revision.purposeSubcategoryId.toString())?.nameAr : revision.legacyPropertyTypeCode,
        propertyTypes: this.propertyTypesView(revision, typesById),
        paymentMethodNamesAr: (revision.paymentMethodCodes ?? []).map((code: string) => paymentNames.get(code)).filter(Boolean),
      };
    };
    const reviewed = this.populatedRevision(item.pendingRevisionId) ?? this.effectiveRevision(item, true);
    return { property: { ...this.toAdmin(item, true, mediaProfiles), propertyTypes: this.propertyTypesView(reviewed, typesById), revisions: revisions.map(present), currentPublicRevision: present(this.populatedRevision(item.currentPublicRevisionId)), pendingRevision: present(this.populatedRevision(item.pendingRevisionId)) } };
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
        let facets: PropertyFacetValues = {};
        if (status === 'approved') {
          const approvalCandidate = await this.revisions.findOne({ _id: revisionId, propertyId: property._id, moderationStatus: PropertyRevisionModerationStatus.PENDING_REVIEW, decisionVersion: version }).session(session).lean().exec();
          if (!approvalCandidate) throw new ConflictException({ message: 'سبق اتخاذ قرار أو تغير إصدار النسخة', code: PropertyErrorCode.REVISION_VERSION_CONFLICT });
          await this.assertAdditionalTypesStillAvailable(approvalCandidate, session);
          const form = await this.approvalForm(approvalCandidate, session);
          this.assertPresentationMediaComplete(approvalCandidate, form);
          // DPF-023: promoted facets of the approved revision's effective attributes (primary form only).
          facets = approvedFacets(form.attributes);
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
          aggregateUpdate.$set.purposeSubcategoryIds = selectedPropertyTypeIds(revision);
          aggregateUpdate.$set.propertyTypeCode = revision.legacyPropertyTypeCode;
          aggregateUpdate.$set.governorateCode = revision.governorateCode;
          aggregateUpdate.$set.city = revision.city;
          aggregateUpdate.$set.district = revision.district;
          aggregateUpdate.$set.area = revision.area;
          aggregateUpdate.$set.totalPriceMinor = revision.totalPriceMinor;
          aggregateUpdate.$set.currency = revision.currency;
          // Frozen §A6/§G4: the whole facets object is replaced; nothing applicable means no facets.
          if (Object.keys(facets).length) aggregateUpdate.$set.facets = facets;
          else aggregateUpdate.$unset.facets = 1;
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
        const advertiserAccountId = (property.advertiserAccountId ?? property.ownerId).toString();
        await this.outbox.recordRequired(propertyDecisionEvent({
          propertyId: id,
          revisionId,
          occurredAt: now,
          decision: status,
          decisionVersion: version + 1,
          advertiserAccountId,
        }), session);
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

  /**
   * DPF-016 `specifications` for each record (a revision, or an aggregate that
   * has none). Pinned versions are batch-loaded by id; catalog labels are
   * looked up live (PD-6). Legacy records never touch the version collection.
   */
  private async specificationsFor(records: any[]): Promise<Array<Specifications | undefined>> {
    const pinnedIds = [...new Set(records.filter(isPinnedRecord).map((record) => String(record.formDefinitionVersionId)))];
    const versions = pinnedIds.length && this.formVersions
      ? await this.formVersions.find({ _id: { $in: pinnedIds } }, { fields: 1, mediaProfile: 1 }).lean().exec()
      : [];
    const versionById = new Map<string, any>(versions.map((version: any) => [String(version._id), version]));
    const pinnedVersionOf = (record: any) => (isPinnedRecord(record) ? versionById.get(String(record.formDefinitionVersionId)) : undefined);
    const specs = records.map((record) => (record ? effectiveSpec(record, pinnedVersionOf(record)) : undefined));
    const references = records.flatMap((record, index) => (specs[index] ? catalogReferences(specs[index]!, pinnedVersionOf(record)) : []));
    const options = references.length
      ? await this.options.find({ group: { $in: [...new Set(references.map((reference) => reference.catalogGroup))] }, code: { $in: [...new Set(references.map((reference) => reference.code))] } }).lean().exec()
      : [];
    const labels = new Map(options.map((option) => [`${option.group}:${option.code}`, option.nameAr]));
    return records.map((record, index) => (specs[index] ? buildSpecifications(specs[index]!, pinnedVersionOf(record), (group, code) => labels.get(`${group}:${code}`)) : undefined));
  }

  /** Every selected type for presentation: the primary first, then catalog order. */
  private propertyTypesView(revision: any, typesById: Map<string, any>) {
    if (!revision) return [];
    const primaryId = revision.purposeSubcategoryId?.toString();
    return selectedPropertyTypeIds(revision)
      .map((value) => {
        const id = String(value);
        const type = typesById.get(id);
        return {
          id, code: type?.code ?? (id === primaryId ? revision.legacyPropertyTypeCode : undefined), nameAr: type?.nameAr, iconKey: type?.iconKey,
          isPrimary: id === primaryId, sortOrder: type?.sortOrder ?? Number.MAX_SAFE_INTEGER,
        };
      })
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ sortOrder: _sortOrder, ...view }) => view);
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

  /** Media profile of each pinned revision's version, keyed by version id (legacy revisions need none). */
  private async mediaProfilesFor(revisions: any[]): Promise<Map<string, MediaProfile>> {
    const ids = [...new Set(revisions.filter(isPinnedRecord).map((revision) => String(revision.formDefinitionVersionId)))];
    if (!ids.length || !this.formVersions) return new Map();
    const versions = await this.formVersions.find({ _id: { $in: ids } }, { mediaProfile: 1 }).lean().exec();
    return new Map(versions.map((version: any) => [String(version._id), version.mediaProfile as MediaProfile]));
  }

  /**
   * Admin review completeness (frozen §D #12) for the PRIMARY form's media
   * profile. SELF_SERVICE: the profile's required slots and minimum;
   * PLATFORM_MANAGED: one photo, as today.
   */
  private mediaCompletenessView(revision: any, mediaProfiles?: ReadonlyMap<string, MediaProfile>) {
    const media = revision.galleryMedia ?? [];
    const photoCount = media.length;
    const mediaProfile = isPinnedRecord(revision) ? mediaProfiles?.get(String(revision.formDefinitionVersionId)) ?? null : 'residential_rooms';
    if (revision.marketingMode !== PropertyMarketingMode.SELF_SERVICE) {
      return { mediaProfile, requiredPhotoSlots: [], missingPhotoSlots: [], minimumPhotoCount: 1, photoCount, complete: photoCount >= 1 };
    }
    // The pinned version could not be loaded (an integrity failure): never report complete.
    if (!mediaProfile) return { mediaProfile: null, requiredPhotoSlots: [], missingPhotoSlots: [], minimumPhotoCount: null, photoCount, complete: false };
    const evaluation = evaluateMedia(mediaProfile, effectiveSpec(revision).attributes, media.map((asset: PropertyAsset) => ({ slotId: asset.slotId, digest: asset.contentDigest })));
    return {
      mediaProfile,
      requiredPhotoSlots: evaluation.requiredPhotoSlots,
      missingPhotoSlots: evaluation.missingPhotoSlots,
      minimumPhotoCount: Math.max(evaluation.requiredPhotoSlots.length, evaluation.minPhotos),
      photoCount,
      complete: !evaluation.missingPhotoSlots.length && photoCount >= evaluation.minPhotos,
    };
  }

  private revisionAdmin(revision: any, mediaProfiles?: ReadonlyMap<string, MediaProfile>) {
    if (!revision) return undefined;
    const flat = deprecatedFlatFields(revision);
    const spec = effectiveSpec(revision);
    return {
      ...this.revisionSummary(revision),
      title: revision.title,
      description: revision.description,
      purposeCategoryId: revision.purposeCategoryId?.toString?.(),
      purposeSubcategoryId: revision.purposeSubcategoryId?.toString?.(),
      purposeSubcategoryIds: selectedPropertyTypeIds(revision).map(String),
      propertyTypeCode: revision.legacyPropertyTypeCode,
      governorateCode: revision.governorateCode,
      city: revision.city,
      district: revision.district,
      area: revision.area,
      bedrooms: flat.bedrooms,
      livingRooms: flat.livingRooms,
      kitchens: flat.kitchens,
      bathrooms: flat.bathrooms,
      attributes: spec.attributes,
      formDefinitionVersionId: spec.formDefinitionVersionId,
      formDefinitionVersion: spec.formDefinitionVersion,
      totalPriceMinor: revision.totalPriceMinor,
      currency: revision.currency,
      paymentMethodCodes: revision.paymentMethodCodes,
      marketingMode: revision.marketingMode,
      images: this.publicImages(this.revisionPublicImages(revision)),
      mediaCompleteness: this.mediaCompletenessView(revision, mediaProfiles),
      privateEvidence: this.privateEvidenceDescriptors(revision, {}),
    };
  }

  /**
   * Phase 11: buyer-facing amenities, resolved from the revision-owned
   * `amenityCodes` against the current amenity catalog (not filtered by
   * `isActive`, so a code that was selected while active and later archived
   * still renders correctly with its current label/icon/category instead of
   * silently disappearing from a property that already has it — the same
   * "hard-delete blocked while referenced" invariant the catalog already
   * enforces keeps this safe: a still-selected code's document is never
   * removed). A code with no matching catalog document at all (never
   * possible in practice, but not assumed) is silently dropped rather than
   * breaking the read. Deterministic order matches the public catalog list's
   * own sort (category, then sortOrder, then nameAr).
   */
  private toMarketplacePublic(item: any, amenityCatalog?: ReadonlyMap<string, PublicAmenityView>) {
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
      amenityCodes: rawAmenityCodes,
      ...safe
    } = projected;
    return { ...safe, amenities: this.resolvePublicAmenities(rawAmenityCodes, amenityCatalog) };
  }

  /** The full amenity catalog (active and inactive), for resolving `amenityCodes` into public display metadata. The catalog is small enough that fetching it whole, once per read, is simpler than a per-code lookup. */
  private async publicAmenityCatalog(): Promise<Map<string, PublicAmenityView>> {
    const items = await this.amenities.find({}).lean().exec();
    return new Map(items.map((item: any) => [item.code, { code: item.code, nameAr: item.nameAr, nameEn: item.nameEn, iconKey: item.iconKey, category: item.category, sortOrder: item.sortOrder ?? 0 }]));
  }

  private resolvePublicAmenities(codes: readonly string[] | undefined, catalog?: ReadonlyMap<string, PublicAmenityView>): PublicAmenity[] {
    if (!codes?.length || !catalog) return [];
    const seen = new Set<string>();
    const resolved: PublicAmenityView[] = [];
    for (const code of codes) {
      if (seen.has(code)) continue;
      const entry = catalog.get(code);
      if (!entry) continue;
      seen.add(code);
      resolved.push(entry);
    }
    return resolved.sort((a, b) => (a.category !== b.category ? a.category.localeCompare(b.category) : a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.nameAr.localeCompare(b.nameAr)))
      .map(({ sortOrder: _sortOrder, ...publicAmenity }) => publicAmenity);
  }

  /** Owner projections plus `specifications` of the revision the owner sees (pending, draft, else public). */
  private async withOwnerSpecifications(items: any[]) {
    const specifications = await this.specificationsFor(items.map((item) => this.effectiveRevision(item, true) ?? item));
    return items.map((item, index) => ({ ...this.toOwner(item), specifications: specifications[index] }));
  }

  private toOwner(item: any) {
    const result = this.projectProperty(item, true);
    const revision = this.effectiveRevision(item, true);
    const spec = effectiveSpec(revision ?? item);
    // Legacy: today's revision-then-aggregate fallback. Pinned: the pinned attributes only.
    const flat = isPinnedRecord(revision) ? deprecatedFlatFields(revision) : undefined;
    const legacy = (field: string) => (flat ? flat[field] : revision?.[field] ?? item[field]);
    return {
      ...result,
      street: revision?.street ?? item.street,
      additionalAddressDetails: revision?.additionalAddressDetails ?? item.additionalAddressDetails,
      latitude: revision?.latitude ?? item.latitude,
      longitude: revision?.longitude ?? item.longitude,
      livingRooms: legacy('livingRooms'),
      kitchens: legacy('kitchens'),
      totalFloors: legacy('totalFloors'),
      buildingYear: legacy('buildingYear'),
      finishingStatusCode: legacy('finishingStatusCode'),
      deliveryStatusCode: legacy('deliveryStatusCode'),
      amenityCodes: revision?.amenityCodes ?? item.amenityCodes,
      // DPF-016: effective values and the pin (null for legacy).
      attributes: spec.attributes,
      formDefinitionVersionId: spec.formDefinitionVersionId,
      formDefinitionVersion: spec.formDefinitionVersion,
      isPriceNegotiable: revision?.isPriceNegotiable ?? item.isPriceNegotiable,
      hidePhone: revision?.hidePhone ?? item.hidePhone,
      privateEvidence: this.privateEvidenceDescriptors(revision, item),
      hasTitleDeed: Boolean(revision?.privateEvidenceAssets?.length || item.titleDeed?.publicId),
    };
  }

  private projectProperty(item: any, includePending: boolean) {
    const revision = this.effectiveRevision(item, includePending);
    const source = revision ?? item;
    const flat = deprecatedFlatFields(source);
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
      purposeSubcategoryIds: revision ? selectedPropertyTypeIds(revision).map(String) : undefined,
      propertyTypeCode: source.legacyPropertyTypeCode ?? item.propertyTypeCode,
      title: source.title,
      description: source.description,
      governorateCode: source.governorateCode,
      city: source.city,
      district: source.district,
      area: source.area,
      bedrooms: flat.bedrooms,
      bathrooms: flat.bathrooms,
      floor: flat.floor,
      ...money,
      paymentMethodCodes: revision?.paymentMethodCodes,
      marketingMode: revision?.marketingMode,
      images: this.publicImages(this.revisionPublicImages(revision, item.images)),
      coverImageIndex: source.coverImageIndex,
      amenityCodes: source.amenityCodes,
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
  private toAdmin(item: any, detailed = false, mediaProfiles?: ReadonlyMap<string, MediaProfile>) {
    const account = item.advertiserAccountId && typeof item.advertiserAccountId === 'object' && item.advertiserAccountId.fullName ? item.advertiserAccountId : item.ownerId;
    const populatedOwner = account && typeof account === 'object' && account.fullName;
    const owner = populatedOwner ? { id: account._id.toString(), fullName: account.fullName, email: account.email, phone: account.phone } : undefined;
    const revision = this.effectiveRevision(item, true);
    const pending = this.populatedRevision(item.pendingRevisionId);
    const source = pending ?? revision ?? item;
    const pendingProjection = pending ? this.revisionAdmin(pending, mediaProfiles) : undefined;
    const base = { ...this.toOwner(item), ...(pendingProjection ? { ...pendingProjection, revisionId: pendingProjection.id } : {}), id: item._id.toString(), owner, status: pending ? PropertyRevisionModerationStatus.PENDING_REVIEW : (revision?.moderationStatus ?? item.status), reviewReason: pending?.reviewReason ?? item.reviewReason, reviewedAt: pending?.reviewedAt ?? item.reviewedAt };
    const flat = deprecatedFlatFields(source);
    return detailed ? { ...base, street: source.street, additionalAddressDetails: source.additionalAddressDetails, latitude: source.latitude, longitude: source.longitude, bedrooms: flat.bedrooms, livingRooms: flat.livingRooms, kitchens: flat.kitchens, bathrooms: flat.bathrooms, floor: flat.floor, totalFloors: flat.totalFloors, buildingYear: flat.buildingYear, finishingStatusCode: flat.finishingStatusCode, deliveryStatusCode: flat.deliveryStatusCode, amenityCodes: source.amenityCodes, isPriceNegotiable: source.isPriceNegotiable, paymentMethodCodes: revision?.paymentMethodCodes, paymentMethodCode: item.paymentMethodCode, advertiserType: item.advertiserType, hidePhone: source.hidePhone } : base;
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
