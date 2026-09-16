import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PropertiesService } from '../src/properties/properties.service';
import { AssetClassification } from '../src/config/evidence-asset.types';

const query = (value: unknown) => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(value) }) });
const validPng = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000000000000000000049454e4400000000', 'hex');

describe('property publishing validation', () => {
  const dto: any = {
    operationType: 'sale', propertyTypeCode: 'apartment', title: 'شقة ممتازة للبيع',
    description: 'وصف تفصيلي صالح للعقار المعروض للبيع', governorateCode: 'cairo',
    city: 'القاهرة', district: 'التجمع', latitude: 30, longitude: 31, area: 150,
    bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2,
    totalFloors: 5, buildingYear: 2020, finishingStatusCode: 'fully_finished',
    deliveryStatusCode: 'immediate', amenityCodes: ['elevator'], totalPriceMinor: 100000000,
    downPaymentMinor: 10000000, currency: 'EGP', isPriceNegotiable: true, paymentMethodCode: 'cash',
    imageLabels: ['الواجهة'], coverImageIndex: 0, advertiserType: 'owner', hidePhone: false,
  };

  function service(overrides: Record<string, unknown> = {}) {
    const instance = Object.create(PropertiesService.prototype) as any;
    Object.assign(instance, {
      propertyTypes: { findOne: jest.fn().mockReturnValue(query({ code: 'apartment' })) },
      governorates: { findOne: jest.fn().mockReturnValue(query({ code: 'cairo' })) },
      options: { findOne: jest.fn().mockReturnValue(query({ code: 'valid' })) },
      amenities: { countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(1) }) },
      properties: {}, cloudinary: {}, ...overrides,
    });
    return instance as PropertiesService;
  }

  it('rejects a missing image before catalog lookup or upload', async () => {
    await expect(service().create('64b000000000000000000001', dto, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects excessive public image count before upload', async () => {
    const images = Array.from({ length: 21 }, () => ({ mimetype: 'image/png', buffer: Buffer.from('x') } as any));
    await expect(service().create('64b000000000000000000001', { ...dto, imageLabels: Array(21).fill('x') }, { images }))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: 'EVIDENCE_FILE_COUNT_EXCEEDED' }) });
  });

  it('rejects a disabled or unknown catalog value before uploading assets', async () => {
    const upload = jest.fn();
    const instance = service({
      propertyTypes: { findOne: jest.fn().mockReturnValue(query(null)) },
      upload,
    }) as any;
    await expect(instance.create('64b000000000000000000001', dto, {
      images: [{ mimetype: 'image/png', buffer: validPng }],
    })).rejects.toThrow('نوع العقار');
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects inconsistent price and building values', async () => {
    await expect(service().create('64b000000000000000000001', { ...dto, downPaymentMinor: 200000000 }, {
      images: [{ mimetype: 'image/jpeg', buffer: Buffer.from('image') } as any],
    })).rejects.toThrow('المقدم');
  });

  it('lets an administrator approve a property and records the decision', async () => {
    const audit = { logAdminResourceAction: jest.fn().mockResolvedValue(undefined) };
    const item = { _id: { toString: () => '64b000000000000000000099' }, ownerId: { _id: { toString: () => '64b000000000000000000001' }, fullName: 'مالك العقار' }, title: 'عقار صالح', description: 'وصف', totalPriceMinor: 100000000, downPaymentMinor: 0, currency: 'EGP', images: [], status: 'approved' };
    const exec = jest.fn().mockResolvedValue(item);
    const instance = service({ properties: { findByIdAndUpdate: jest.fn().mockReturnValue({ populate: () => ({ lean: () => ({ exec }) }) }) }, audit }) as any;
    const result = await instance.reviewForAdmin('64b000000000000000000099', 'approved', undefined, '64b000000000000000000002');
    expect(result.property.status).toBe('approved');
    expect(audit.logAdminResourceAction).toHaveBeenCalledWith('admin_property_status_updated', '64b000000000000000000002', '64b000000000000000000099', expect.stringContaining('approved'), undefined);
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
    const publicDto = instance.toPublic(stored);
    const adminDto = instance.toAdmin(stored, true);
    expect(publicDto.images).toEqual([{ url: 'https://cdn.example/image.jpg', label: 'front' }]);
    expect(publicDto).not.toHaveProperty('titleDeed');
    expect(adminDto).not.toHaveProperty('titleDeed');
    expect(adminDto.hasTitleDeed).toBe(true);
    expect(JSON.stringify(adminDto)).not.toContain('private-deed');
  });

  it('allows the owner to access private evidence and denies an unrelated user', async () => {
    const stored = {
      _id: { toString: () => '64b000000000000000000099' },
      ownerId: { toString: () => '64b000000000000000000001' },
      titleDeed: { publicId: 'private-deed', resourceType: 'raw', deliveryType: 'authenticated', classification: AssetClassification.PRIVATE_PROPERTY_EVIDENCE },
    };
    const properties = { findById: jest.fn().mockReturnValue(query(stored)) };
    const evidenceAssets = { downloadAuthenticatedAsset: jest.fn().mockResolvedValue({ buffer: Buffer.from('pdf'), contentType: 'application/pdf' }) };
    const audit = { logResourceAction: jest.fn().mockResolvedValue(undefined) };
    const instance = service({ properties, evidenceAssets, audit }) as any;

    await expect(instance.downloadTitleDeedForOwner('64b000000000000000000002', stored._id.toString()))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(instance.downloadTitleDeedForOwner('64b000000000000000000001', stored._id.toString()))
      .resolves.toMatchObject({ contentType: 'application/pdf' });
    expect(evidenceAssets.downloadAuthenticatedAsset).toHaveBeenCalledWith(expect.objectContaining({ publicId: 'private-deed' }));
    expect(audit.logResourceAction).toHaveBeenCalled();
  });
});
