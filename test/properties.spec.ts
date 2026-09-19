import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PropertiesService } from '../src/properties/properties.service';
import { AssetClassification } from '../src/config/evidence-asset.types';
import { AccountType, BrokerStatus } from '../src/users/identity.types';
import { PropertyMarketingMode, PropertyMediaTagCode } from '../src/properties/property.types';
import { PropertyErrorCode } from '../src/common/errors/property-error-codes';

const query = (value: unknown) => {
  const chain: any = { lean: () => ({ exec: jest.fn().mockResolvedValue(value) }) };
  chain.populate = () => chain;
  return chain;
};
const validPng = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000000000000000000049454e4400000000', 'hex');

describe('property publishing validation', () => {
  const userId = '64b000000000000000000001';
  const adminId = '64b000000000000000000002';
  const categoryId = '64b000000000000000000010';
  const subcategoryId = '64b000000000000000000011';
  const requiredPhotoSlots = [
    'exterior', 'entrance', 'living_1', 'bedroom_1', 'bedroom_2', 'bedroom_3',
    'kitchen_1', 'bathroom_1', 'bathroom_2',
  ];
  const validFiles = () => ({
    images: requiredPhotoSlots.map((_, index) => ({ mimetype: 'image/png', buffer: Buffer.concat([validPng, Buffer.from([index])]) } as any)),
  });
  const dto: any = {
    operationType: 'sale', purposeCategoryId: categoryId, purposeSubcategoryId: subcategoryId, title: 'شقة ممتازة للبيع',
    description: 'وصف تفصيلي صالح للعقار المعروض للبيع', governorateCode: 'cairo',
    city: 'القاهرة', district: 'التجمع', latitude: 30, longitude: 31, area: 150,
    bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2,
    totalFloors: 5, buildingYear: 2020, finishingStatusCode: 'fully_finished',
    deliveryStatusCode: 'immediate', amenityCodes: ['elevator'], totalPriceMinor: 100000000,
    currency: 'EGP', isPriceNegotiable: true, paymentMethodCodes: ['cash'], marketingMode: PropertyMarketingMode.SELF_SERVICE,
    imageLabels: requiredPhotoSlots, imageSlotIds: requiredPhotoSlots,
    coverImageIndex: 0, advertiserType: 'broker', hidePhone: false,
  };

  function service(overrides: Record<string, unknown> = {}) {
    const instance = Object.create(PropertiesService.prototype) as any;
    Object.assign(instance, {
      users: { find: jest.fn().mockReturnValue(query([{ _id: { toString: () => userId }, systemRole: 'USER', accountType: AccountType.USER, accountStatus: 'ACTIVE' }])) },
      purposeCategories: { findOne: jest.fn().mockReturnValue(query({ _id: { toString: () => categoryId } })), updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ matchedCount: 1 }) }) },
      propertyTypes: { findOne: jest.fn().mockReturnValue(query({ _id: { toString: () => subcategoryId }, code: 'apartment', purposeCategoryId: { toString: () => categoryId } })), updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ matchedCount: 1 }) }) },
      governorates: { findOne: jest.fn().mockReturnValue(query({ code: 'cairo' })) },
      options: { findOne: jest.fn().mockReturnValue(query({ code: 'valid' })), find: jest.fn().mockReturnValue(query([{ code: 'cash' }])) },
      amenities: { countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(1) }) },
      auctionLock: { assertUnlocked: jest.fn().mockResolvedValue(undefined) },
      properties: {}, cloudinary: {}, ...overrides,
    });
    return instance as PropertiesService;
  }

  it('rejects a missing image before catalog lookup or upload', async () => {
    await expect(service().create(userId, dto, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not require customer public photos for PLATFORM_MANAGED drafts', async () => {
    const instance = service({ purposeCategories: { findOne: jest.fn().mockReturnValue(query(null)) } });
    await expect(instance.create(userId, { ...dto, marketingMode: PropertyMarketingMode.PLATFORM_MANAGED, imageLabels: [], imageSlotIds: [], coverImageIndex: 0 }, {}))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.PURPOSE_CATEGORY_INVALID }) });
  });

  it('rejects a stale draft update before replacing media', async () => {
    const instance = service() as any;
    await expect(instance.createWithAttribution(
      { actorId: { toString: () => userId }, advertiserId: { toString: () => userId }, accountType: AccountType.USER },
      { ...dto, expectedRevisionVersion: 1 },
      validFiles(),
      undefined,
      { _id: { toString: () => '64b000000000000000000099' } },
      { decisionVersion: 2 },
    )).rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.REVISION_VERSION_CONFLICT }) });
  });

  it.each(requiredPhotoSlots)('rejects submission when required photo slot %s is missing', async (missingSlot) => {
    const suppliedSlots = requiredPhotoSlots.filter((slot) => slot !== missingSlot);
    await expect(service().create(userId, {
      ...dto,
      imageLabels: suppliedSlots,
      imageSlotIds: suppliedSlots,
    }, {
      images: suppliedSlots.map(() => ({ mimetype: 'image/png', buffer: validPng } as any)),
    })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'PROPERTY_REQUIRED_PHOTO_SLOTS_MISSING',
        missingPhotoSlots: [missingSlot],
      }),
    });
  });

  it('requires exterior and entrance to use distinct photo content', async () => {
    const files = validFiles();
    files.images[1].buffer = files.images[0].buffer;
    await expect(service().create(userId, dto, files)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'PROPERTY_PHOTO_SLOT_MEDIA_DUPLICATED',
        duplicatePhotoSlots: ['exterior', 'entrance'],
      }),
    });
  });

  it('rejects excessive public image count before upload', async () => {
    const images = Array.from({ length: 21 }, () => ({ mimetype: 'image/png', buffer: Buffer.from('x') } as any));
    await expect(service().create(userId, { ...dto, imageLabels: Array(21).fill('x'), imageSlotIds: Array.from({ length: 21 }, (_, index) => `additional_${index + 1}`) }, { images }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'EVIDENCE_FILE_COUNT_EXCEEDED' }) });
  });

  it('rejects a disabled or unknown catalog value before uploading assets', async () => {
    const upload = jest.fn();
    const instance = service({
      propertyTypes: { findOne: jest.fn().mockReturnValue(query(null)) },
      upload,
    }) as any;
    await expect(instance.create(userId, dto, validFiles())).rejects.toThrow('نوع العقار');
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects inconsistent price and building values', async () => {
    await expect(service().create(userId, { ...dto, downPaymentMinor: 200000000 }, {
      images: [{ mimetype: 'image/jpeg', buffer: Buffer.from('image') } as any],
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.LEGACY_INPUT_NOT_ACCEPTED }) });
  });

  it.each([
    [AccountType.USER, undefined],
    [AccountType.BROKER, BrokerStatus.APPROVED],
    [AccountType.COMPANY, undefined],
  ])('derives self attribution for %s without trusting advertiserType', async (accountType, brokerStatus) => {
    const instance = service({
      users: { find: jest.fn().mockReturnValue(query([{ _id: { toString: () => userId }, systemRole: 'USER', accountType, accountStatus: 'ACTIVE', brokerStatus }])) },
    }) as any;
    await expect(instance.resolveAdvertiser(userId, userId, false)).resolves.toMatchObject({ accountType });
  });

  it.each([AccountType.USER, AccountType.BROKER, AccountType.COMPANY])('allows Admin proxy attribution to %s', async (accountType) => {
    const targetId = '64b000000000000000000003';
    const instance = service({ users: { find: jest.fn().mockReturnValue(query([
      { _id: { toString: () => adminId }, systemRole: 'ADMIN', accountType: AccountType.USER, accountStatus: 'ACTIVE' },
      { _id: { toString: () => targetId }, systemRole: 'USER', accountType, accountStatus: 'ACTIVE', brokerStatus: accountType === AccountType.BROKER ? BrokerStatus.APPROVED : undefined },
    ])) } }) as any;
    await expect(instance.resolveAdvertiser(adminId, targetId, true)).resolves.toMatchObject({ accountType });
  });

  it('allows SUPER_ADMIN proxy creation but denies cross-account proxying by a marketplace USER', async () => {
    const targetId = '64b000000000000000000003';
    const accounts = (role: string) => query([
      { _id: { toString: () => adminId }, systemRole: role, accountStatus: 'ACTIVE' },
      { _id: { toString: () => targetId }, systemRole: 'USER', accountType: AccountType.COMPANY, accountStatus: 'ACTIVE' },
    ]);
    await expect((service({ users: { find: jest.fn().mockReturnValue(accounts('SUPER_ADMIN')) } }) as any).resolveAdvertiser(adminId, targetId, true))
      .resolves.toMatchObject({ accountType: AccountType.COMPANY });
    await expect((service({ users: { find: jest.fn().mockReturnValue(accounts('USER')) } }) as any).resolveAdvertiser(adminId, targetId, true))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires an approved broker before deriving BROKER attribution', async () => {
    const instance = service({ users: { find: jest.fn().mockReturnValue(query([{ _id: { toString: () => userId }, systemRole: 'USER', accountType: AccountType.BROKER, accountStatus: 'ACTIVE', brokerStatus: BrokerStatus.PENDING }])) } }) as any;
    await expect(instance.resolveAdvertiser(userId, userId, false)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('prevents an Admin account from becoming the advertiser', async () => {
    const instance = service({ users: { find: jest.fn().mockReturnValue(query([{ _id: { toString: () => adminId }, systemRole: 'ADMIN', accountStatus: 'ACTIVE' }])) } }) as any;
    await expect(instance.resolveAdvertiser(adminId, adminId, false)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects duplicate payment methods and an invalid marketing mode before upload', async () => {
    await expect(service().create(userId, { ...dto, paymentMethodCodes: ['cash', 'cash'] }, { images: [{ mimetype: 'image/png', buffer: validPng } as any] }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.PAYMENT_METHODS_INVALID }) });
    await expect(service().create(userId, { ...dto, marketingMode: 'UNKNOWN' }, { images: [{ mimetype: 'image/png', buffer: validPng } as any] }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.MARKETING_MODE_INVALID }) });
  });

  it('rejects a child under the wrong purpose parent', async () => {
    const instance = service({
      propertyTypes: { findOne: jest.fn().mockReturnValue(query({ _id: { toString: () => subcategoryId }, code: 'apartment', purposeCategoryId: { toString: () => '64b000000000000000000099' } })) },
    }) as any;
    await expect(instance.create(userId, dto, validFiles()))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.PURPOSE_HIERARCHY_MISMATCH }) });
  });

  it('rejects missing/inactive purpose parents and children', async () => {
    const files = validFiles();
    await expect(service({ purposeCategories: { findOne: jest.fn().mockReturnValue(query(null)) } }).create(userId, dto, files))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.PURPOSE_CATEGORY_INVALID }) });
    await expect(service({ propertyTypes: { findOne: jest.fn().mockReturnValue(query(null)) } }).create(userId, dto, files))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.PURPOSE_SUBCATEGORY_INVALID }) });
  });

  it('rejects empty, unknown, or inactive payment-method selections', async () => {
    const files = validFiles();
    await expect(service().create(userId, { ...dto, paymentMethodCodes: [] }, files))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.PAYMENT_METHODS_INVALID }) });
    const instance = service({ options: { findOne: jest.fn().mockReturnValue(query({ code: 'valid' })), find: jest.fn().mockReturnValue(query([])) } });
    await expect(instance.create(userId, dto, files))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.PAYMENT_METHODS_INVALID }) });
  });

  it('creates PLATFORM_MANAGED draft with zero advertiser photos and preserves classified SELF_SERVICE media', async () => {
    const propertyId = { toString: () => '64b000000000000000000099' };
    const revisionCreate = jest.fn().mockResolvedValue([]);
    const propertyCreate = jest.fn().mockImplementation(async ([value]: any[]) => [{
      ...value,
      _id: propertyId,
      toObject: () => ({ ...value, _id: propertyId, createdAt: new Date() }),
    }]);
    const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
    const instance = service({
      properties: { create: propertyCreate, deleteOne: jest.fn().mockReturnValue({ exec: jest.fn() }) },
      revisions: { create: revisionCreate, deleteOne: jest.fn().mockReturnValue({ exec: jest.fn() }) },
      connection: { startSession: jest.fn().mockResolvedValue(session) },
      governorates: { findOne: jest.fn().mockReturnValue(query({ code: 'cairo' })), updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ matchedCount: 1 }) }) },
      options: {
        findOne: jest.fn().mockReturnValue(query({ code: 'valid' })),
        find: jest.fn().mockReturnValue(query([{ code: 'cash' }, { code: 'mortgage' }])),
        updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ matchedCount: 4 }) }),
      },
      amenities: {
        countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(1) }),
        updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ matchedCount: 1 }) }),
      },
      audit: { logResourceAction: jest.fn(), logRequired: jest.fn() },
      cloudinary: { uploader: { destroy: jest.fn() } },
      evidenceAssets: { deleteOrEnqueue: jest.fn() },
    }) as any;
    instance.uploadPublicImage = jest.fn().mockImplementation(() => {
      const index = instance.uploadPublicImage.mock.calls.length;
      return Promise.resolve({ url: `https://cdn.example/photo-${index}.jpg`, publicId: `photo-${index}`, resourceType: 'image', deliveryType: 'upload', classification: AssetClassification.PUBLIC_PROPERTY_MEDIA });
    });

    const managedResult = await instance.create(userId, {
      ...dto,
      marketingMode: PropertyMarketingMode.PLATFORM_MANAGED,
      paymentMethodCodes: ['mortgage', 'cash'],
      imageLabels: [],
      imageSlotIds: [],
      coverImageIndex: 0,
    }, {});
    expect(revisionCreate).toHaveBeenNthCalledWith(1, [expect.objectContaining({
      marketingMode: PropertyMarketingMode.PLATFORM_MANAGED,
      galleryMedia: [],
      privateEvidenceAssets: [],
    })], expect.objectContaining({ session }));
    expect(managedResult.property.images).toEqual([]);

    const result = await instance.create(userId, { ...dto, advertiserType: 'broker', advertiserAccountId: '64b000000000000000000099', paymentMethodCodes: ['mortgage', 'cash'] }, validFiles());

    expect(propertyCreate).toHaveBeenCalledWith([expect.objectContaining({
      advertiserAccountTypeSnapshot: AccountType.USER,
      advertiserType: 'owner',
      revisionSequence: 1,
    })], expect.objectContaining({ session }));
    expect(revisionCreate).toHaveBeenCalledWith([expect.objectContaining({
      revisionNumber: 1,
      moderationStatus: 'draft',
      paymentMethodCodes: ['cash', 'mortgage'],
      marketingMode: PropertyMarketingMode.SELF_SERVICE,
      galleryMedia: expect.arrayContaining(requiredPhotoSlots.map((slotId) => expect.objectContaining({ slotId }))),
      privateEvidenceAssets: [],
    })], expect.objectContaining({ session }));
    expect(result.property).not.toHaveProperty('entranceImage');
    expect(result.property.images).toHaveLength(requiredPhotoSlots.length);
    expect(result.property.images[0]).toMatchObject({ slotId: 'exterior' });
  });

  it('lets only the owner hide a property without changing review status', async () => {
    const item = {
      _id: { toString: () => '64b000000000000000000099' },
      status: 'approved', isOwnerVisible: false, totalPriceMinor: 100000000,
      downPaymentMinor: 0, currency: 'EGP', images: [],
    };
    const lean = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(item) });
    const findOneAndUpdate = jest.fn().mockReturnValue({ lean });
    const instance = service({ properties: { findOneAndUpdate } }) as any;

    const result = await instance.updateOwnerVisibility(
      '64b000000000000000000001',
      '64b000000000000000000099',
      false,
    );

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: '64b000000000000000000099' }),
      { isOwnerVisible: false },
      expect.objectContaining({ new: true }),
    );
    expect(result.property.status).toBe('approved');
    expect(result.property.isOwnerVisible).toBe(false);
  });

  it('never exposes private evidence or provider identifiers in public/Admin DTOs', () => {
    const instance = service() as any;
    const stored = {
      _id: { toString: () => '64b000000000000000000099' },
      ownerId: { _id: { toString: () => '64b000000000000000000001' }, fullName: 'Owner' },
      totalPriceMinor: 1000,
      downPaymentMinor: 0,
      currency: 'EGP',
      images: [{ url: 'https://cdn.example/image.jpg', publicId: 'provider-id', resourceType: 'image', label: 'front' }],
      titleDeed: {
        publicId: 'private-deed', resourceType: 'raw', deliveryType: 'authenticated',
        classification: AssetClassification.PRIVATE_PROPERTY_EVIDENCE,
      },
    };
    const publicDto = instance.toOwner(stored);
    const adminDto = instance.toAdmin(stored, true);
    expect(publicDto.images).toEqual([expect.objectContaining({ url: 'https://cdn.example/image.jpg', label: 'front', tagCode: 'other', order: 0 })]);
    expect(publicDto).not.toHaveProperty('titleDeed');
    expect(adminDto).not.toHaveProperty('titleDeed');
    expect(adminDto.hasTitleDeed).toBe(true);
    expect(JSON.stringify(adminDto)).not.toContain('private-deed');
  });

  it('keeps a new revision-backed aggregate readable before its revision is populated', () => {
    const publicDto = (service() as any).toOwner({
      _id: { toString: () => '64b000000000000000000099' },
      propertyContractVersion: 1,
      totalPriceMinor: 1000,
      currency: 'EGP',
      images: [],
      status: 'pending_review',
    });
    expect(publicDto).toMatchObject({ totalPriceMinor: 1000, currency: 'EGP', status: 'pending_review' });
    expect(publicDto).not.toHaveProperty('downPaymentMinor');
  });

  it('unifies historical entrance media on read without fabricating a slot classification', () => {
    const publicDto = (service() as any).toOwner({
      _id: { toString: () => '64b000000000000000000099' },
      status: 'pending_review',
      pendingRevisionId: {
        _id: { toString: () => '64b000000000000000000088' },
        revisionNumber: 1,
        title: 'Revision',
        totalPriceMinor: 1000,
        currency: 'EGP',
        galleryMedia: [{ url: 'https://cdn.example/gallery.jpg', publicId: 'gallery-provider-id', label: 'front' }],
        entranceImageAsset: { url: 'https://cdn.example/entrance.jpg', publicId: 'entrance-provider-id', label: 'entrance' },
        privateEvidenceAssets: [{ publicId: 'private-provider-id', resourceType: 'raw' }],
        moderationStatus: 'pending_review',
      },
    });
    expect(publicDto.images).toEqual([
      expect.objectContaining({ url: 'https://cdn.example/gallery.jpg', label: 'front', tagCode: 'other', order: 0 }),
      expect.objectContaining({ url: 'https://cdn.example/entrance.jpg', label: 'entrance', tagCode: 'other', order: 1 }),
    ]);
    expect(publicDto).not.toHaveProperty('entranceImage');
    expect(JSON.stringify(publicDto)).not.toMatch(/provider-id|privateEvidenceAssets/);
  });

  it('never projects pending revision media through the public marketplace DTO', () => {
    const dto = (service() as any).toMarketplacePublic({
      _id: { toString: () => '64b000000000000000000099' },
      status: 'approved',
      propertyContractVersion: 1,
      totalPriceMinor: 1000,
      currency: 'EGP',
      images: [{ url: 'https://cdn.example/legacy.jpg', publicId: 'legacy-id' }],
      pendingRevisionId: {
        _id: { toString: () => '64b000000000000000000088' },
        revisionNumber: 2,
        title: 'Unpublished edit',
        totalPriceMinor: 2000,
        currency: 'EGP',
        galleryMedia: [{ url: 'https://cdn.example/pending.jpg', publicId: 'pending-id' }],
        entranceImageAsset: { url: 'https://cdn.example/pending-entrance.jpg', publicId: 'pending-entrance-id' },
        privateEvidenceAssets: [{ publicId: 'private-id' }],
      },
    });
    expect(dto.images).toEqual([expect.objectContaining({ url: 'https://cdn.example/legacy.jpg', tagCode: 'other', order: 0 })]);
    expect(dto.entranceImage).toBeUndefined();
    expect(JSON.stringify(dto)).not.toMatch(/pending\.jpg|pending-entrance|private-id/);
  });

  it('keeps the aggregate property ID in Admin rows with a pending revision', () => {
    const aggregateId = '64b000000000000000000099';
    const pendingRevisionId = '64b000000000000000000088';
    const dto = (service() as any).toAdmin({
      _id: { toString: () => aggregateId },
      status: 'pending_review',
      propertyContractVersion: 1,
      totalPriceMinor: 1000,
      currency: 'EGP',
      images: [],
      pendingRevisionId: {
        _id: { toString: () => pendingRevisionId },
        revisionNumber: 1,
        decisionVersion: 0,
        moderationStatus: 'pending_review',
        title: 'Pending revision',
        totalPriceMinor: 1000,
        currency: 'EGP',
        galleryMedia: [],
      },
    });

    expect(dto.id).toBe(aggregateId);
    expect(dto.revisionId).toBe(pendingRevisionId);
  });

  it('allows the owner to access private evidence and denies an unrelated user', async () => {
    const stored = {
      _id: { toString: () => '64b000000000000000000099' },
      ownerId: { toString: () => '64b000000000000000000001' },
      titleDeed: { publicId: 'private-deed', resourceType: 'raw', deliveryType: 'authenticated', classification: AssetClassification.PRIVATE_PROPERTY_EVIDENCE },
    };
    const properties = {
      findOne: jest.fn().mockImplementation((filter: any) => {
        const requestedAccount = filter.$or[0].advertiserAccountId.toString();
        return query(requestedAccount === stored.ownerId.toString() ? stored : null);
      }),
    };
    const evidenceAssets = { downloadAuthenticatedAsset: jest.fn().mockResolvedValue({ buffer: Buffer.from('pdf'), contentType: 'application/pdf' }) };
    const audit = { logResourceAction: jest.fn().mockResolvedValue(undefined) };
    const instance = service({ properties, evidenceAssets, audit }) as any;

    await expect(instance.downloadTitleDeedForOwner('64b000000000000000000002', stored._id.toString()))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(instance.downloadTitleDeedForOwner('64b000000000000000000001', stored._id.toString()))
      .resolves.toMatchObject({ contentType: 'application/pdf' });
    expect(evidenceAssets.downloadAuthenticatedAsset).toHaveBeenCalledWith(expect.objectContaining({ publicId: 'private-deed' }));
    expect(audit.logResourceAction).toHaveBeenCalled();
  });

  it.each([AccountType.USER, AccountType.BROKER, AccountType.COMPANY])(
    'denies a different %s account private property evidence without exposing asset existence',
    async () => {
      const stored = {
        _id: { toString: () => '64b000000000000000000099' },
        ownerId: { toString: () => '64b000000000000000000001' },
        titleDeed: { publicId: 'private-deed', resourceType: 'raw' },
      };
      const properties = { findOne: jest.fn().mockReturnValue(query(null)) };
      const evidenceAssets = { downloadAuthenticatedAsset: jest.fn() };
      const instance = service({ properties, evidenceAssets }) as any;
      await expect(instance.downloadPrivateEvidenceForOwner(
        '64b000000000000000000002',
        stored._id.toString(),
        undefined,
        0,
      )).rejects.toMatchObject({ response: expect.objectContaining({ code: 'EVIDENCE_NOT_FOUND' }) });
      expect(evidenceAssets.downloadAuthenticatedAsset).not.toHaveBeenCalled();
    },
  );
});

describe('Admin PLATFORM_MANAGED flexible media', () => {
  const propertyId = '64b000000000000000000090';
  const revisionId = '64b000000000000000000091';
  const adminId = '64b000000000000000000092';
  const media = (mediaId = '1f66a82e-5e20-45fc-a9f0-2fa70895ec75', tagCode = PropertyMediaTagCode.BEDROOM) => ({
    publicId: `provider-${mediaId}`, url: `https://cdn.example/${mediaId}.png`, resourceType: 'image',
    deliveryType: 'upload', classification: AssetClassification.PUBLIC_PROPERTY_MEDIA, mediaId, tagCode, sortOrder: 0,
  });

  function context(galleryMedia: any[] = []) {
    const pending = {
      _id: revisionId, propertyId, moderationStatus: 'pending_review', marketingMode: 'PLATFORM_MANAGED', decisionVersion: 3,
      livingRooms: 1, bedrooms: 1, kitchens: 1, bathrooms: 1, galleryMedia, privateEvidenceAssets: [{ publicId: 'private-evidence' }],
    };
    const lean = (value: unknown) => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(value) }) });
    const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
    const revisions = {
      findOne: jest.fn().mockReturnValue(lean(pending)),
      findOneAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ ...pending, decisionVersion: 4 }) }),
    };
    const properties = { findOne: jest.fn().mockReturnValue(lean({ _id: propertyId, pendingRevisionId: revisionId })), updateOne: jest.fn() };
    const evidenceAssets = {
      uploadPublicPropertyMedia: jest.fn().mockResolvedValue({ publicId: 'uploaded', secureUrl: 'https://cdn.example/uploaded.png', resourceType: 'image', deliveryType: 'upload', classification: AssetClassification.PUBLIC_PROPERTY_MEDIA, format: 'png', bytes: validPng.length }),
      deleteOrEnqueue: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { logRequired: jest.fn().mockResolvedValue(undefined) };
    const instance = Object.create(PropertiesService.prototype) as any;
    Object.assign(instance, { revisions, properties, evidenceAssets, audit, connection: { startSession: jest.fn().mockResolvedValue(session) }, getForAdmin: jest.fn().mockResolvedValue({ property: { id: propertyId } }) });
    return { service: instance as PropertiesService, revisions, properties, evidenceAssets, audit };
  }

  const file = { mimetype: 'image/png', buffer: validPng } as Express.Multer.File;

  it('adds tagged public media to the exact pending revision without publishing it', async () => {
    const value = context();
    await expect(value.service.addPlatformMediaForAdmin(propertyId, revisionId, PropertyMediaTagCode.BEDROOM, 3, file, adminId)).resolves.toEqual({ property: { id: propertyId } });
    expect(value.revisions.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: revisionId, propertyId: expect.anything(), moderationStatus: 'pending_review', marketingMode: 'PLATFORM_MANAGED', decisionVersion: 3 }),
      expect.objectContaining({ $set: { galleryMedia: [expect.objectContaining({ mediaId: expect.any(String), tagCode: PropertyMediaTagCode.BEDROOM, sortOrder: 0, classification: AssetClassification.PUBLIC_PROPERTY_MEDIA })] }, $inc: { decisionVersion: 1 } }),
      expect.objectContaining({ session: expect.anything(), overwriteImmutable: true }),
    );
    expect(value.properties.updateOne).not.toHaveBeenCalled();
    expect(value.audit.logRequired).toHaveBeenCalled();
  });

  it('allows duplicate controlled tags without room-count constraints', async () => {
    const value = context([media()]);
    await value.service.addPlatformMediaForAdmin(propertyId, revisionId, PropertyMediaTagCode.BEDROOM, 3, file, adminId);
    const gallery = value.revisions.findOneAndUpdate.mock.calls[0][1].$set.galleryMedia;
    expect(gallery).toHaveLength(2);
    expect(gallery.map((item: any) => item.tagCode)).toEqual([PropertyMediaTagCode.BEDROOM, PropertyMediaTagCode.BEDROOM]);
  });

  it('rejects spoofed image content before upload', async () => {
    const value = context();
    await expect(value.service.addPlatformMediaForAdmin(propertyId, revisionId, PropertyMediaTagCode.EXTERIOR, 3, { mimetype: 'image/png', buffer: Buffer.from('not-an-image') } as Express.Multer.File, adminId))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(value.evidenceAssets.uploadPublicPropertyMedia).not.toHaveBeenCalled();
  });

  it('replaces public media without touching private evidence', async () => {
    const value = context([media()]);
    await value.service.replacePlatformMediaForAdmin(propertyId, revisionId, media().mediaId, PropertyMediaTagCode.KITCHEN, 3, file, adminId);
    const update = value.revisions.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.galleryMedia).toHaveLength(1);
    expect(JSON.stringify(update)).not.toContain('private-evidence');
    expect(update.$set.galleryMedia[0]).toEqual(expect.objectContaining({ tagCode: PropertyMediaTagCode.KITCHEN }));
    expect(value.evidenceAssets.deleteOrEnqueue).toHaveBeenCalledWith([expect.objectContaining({ publicId: expect.stringContaining('provider-') })], expect.stringContaining('replaced'));
  });

  it('changes a tag and reorders platform media using optimistic revision versioning', async () => {
    const first = media();
    const second = { ...media('cf505086-1b68-4e67-b784-cd862d2aa355', PropertyMediaTagCode.KITCHEN), sortOrder: 1 };
    const value = context([first, second]);
    await value.service.updatePlatformMediaForAdmin(propertyId, revisionId, second.mediaId, { tagCode: PropertyMediaTagCode.BEDROOM, sortOrder: 0, version: 3 }, adminId);
    const gallery = value.revisions.findOneAndUpdate.mock.calls[0][1].$set.galleryMedia;
    expect(gallery).toEqual([
      expect.objectContaining({ mediaId: second.mediaId, tagCode: PropertyMediaTagCode.BEDROOM, sortOrder: 0 }),
      expect.objectContaining({ mediaId: first.mediaId, tagCode: PropertyMediaTagCode.BEDROOM, sortOrder: 1 }),
    ]);
  });

  it('removes media only from a mutable pending PLATFORM_MANAGED revision', async () => {
    const value = context([media()]);
    await value.service.removePlatformMediaForAdmin(propertyId, revisionId, media().mediaId, 3, adminId);
    expect(value.revisions.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ moderationStatus: 'pending_review', marketingMode: 'PLATFORM_MANAGED', decisionVersion: 3 }),
      { $set: { galleryMedia: [] }, $inc: { decisionVersion: 1 } },
      expect.objectContaining({ session: expect.anything(), overwriteImmutable: true }),
    );
    expect(value.properties.updateOne).not.toHaveBeenCalled();
  });

  it('projects the one-photo platform minimum without guided missing slots', () => {
    const value = context([media()]);
    const dto = (value.service as any).revisionAdmin({
      _id: revisionId, revisionNumber: 1, decisionVersion: 3, moderationStatus: 'pending_review', marketingMode: 'PLATFORM_MANAGED',
      livingRooms: 1, bedrooms: 1, kitchens: 1, bathrooms: 1, galleryMedia: [media()], privateEvidenceAssets: [],
    });
    expect(dto.mediaCompleteness).toMatchObject({ requiredPhotoSlots: [], missingPhotoSlots: [], minimumPhotoCount: 1, photoCount: 1, complete: true });
    expect(dto.images[0]).toEqual(expect.objectContaining({ id: media().mediaId, tagCode: PropertyMediaTagCode.BEDROOM, order: 0 }));
  });
});
