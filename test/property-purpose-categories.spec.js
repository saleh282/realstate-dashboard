'use strict';

const { ConflictException } = require('../src/common/http/errors');
const {
  PropertyPurposeCategoriesService,
} = require('../src/services/property-purpose-categories.service');
const query = (value) => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(value) }) });
describe('Property purpose category catalog', () => {
  const actorId = '64b000000000000000000001';
  it('creates an Admin-managed localized parent without hard-coded vocabulary', async () => {
    const created = {
      _id: { toString: () => '64b000000000000000000010' },
      code: 'mixed_use',
      nameAr: 'متعدد الاستخدام',
      nameEn: 'Mixed Use',
      isActive: true,
      sortOrder: 15,
      version: 1,
      usageCount: 0,
      toObject() {
        return this;
      },
    };
    const model = { create: jest.fn().mockResolvedValue(created) };
    const audit = { logAdminResourceAction: jest.fn() };
    const service = new PropertyPurposeCategoriesService(model, audit);
    await expect(
      service.create({ nameAr: ' متعدد الاستخدام ', nameEn: 'Mixed Use', sortOrder: 15 }, actorId),
    ).resolves.toMatchObject({ code: 'mixed_use', version: 1 });
    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'mixed_use', nameAr: 'متعدد الاستخدام' }),
    );
  });
  it('uses optimistic category versions and returns a deterministic conflict', async () => {
    const model = {
      findOneAndUpdate: jest.fn().mockReturnValue(query(null)),
      exists: jest.fn().mockResolvedValue({ _id: 'exists' }),
    };
    const service = new PropertyPurposeCategoriesService(model, {
      logAdminResourceAction: jest.fn(),
    });
    await expect(
      service.update('64b000000000000000000010', { expectedVersion: 2, isActive: false }, actorId),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('exposes only active parents publicly in configured order', async () => {
    const exec = jest.fn().mockResolvedValue([
      {
        _id: { toString: () => '1' },
        code: 'custom',
        nameAr: 'مخصص',
        nameEn: 'Custom',
        sortOrder: 3,
        version: 4,
      },
    ]);
    const model = { find: jest.fn().mockReturnValue({ sort: () => ({ lean: () => ({ exec }) }) }) };
    const service = new PropertyPurposeCategoriesService(model, {});
    await expect(service.listPublic()).resolves.toEqual({
      items: [expect.objectContaining({ code: 'custom', version: 4 })],
    });
    expect(model.find).toHaveBeenCalledWith({ isActive: true });
  });
});
