'use strict';

const { ObjectId } = require('mongodb');
const { PropertyRevisionSchema } = require('../src/models/property-revision.model');
const { ManagedMarketingPackageSchema } = require('../src/models/managed-marketing-package.model');
const { ManagedMarketingRequestSchema } = require('../src/models/managed-marketing-request.model');
const {
  legacyRevisionPointer,
  planLegacyPropertyRevision,
} = require('../src/migrations/015-property-attribution-revisions');
const { CORE_MIGRATIONS } = require('../src/migrations/framework/core-migrations');
const {
  propertyAttributionRevisionMigration,
} = require('../src/migrations/framework/core-migrations');
const {
  buildManagedMarketingPackageSnapshot,
} = require('../src/domain/managed-marketing/managed-marketing.snapshot');
describe('MAZAD-015 property domain contract', () => {
  const propertyId = new ObjectId();
  const ownerId = new ObjectId();
  const typeId = new ObjectId();
  const purposeId = new ObjectId();
  const legacy = {
    _id: propertyId,
    ownerId,
    operationType: 'sale',
    propertyTypeCode: 'apartment',
    title: 'Legacy property',
    description: 'Legacy description',
    governorateCode: 'cairo',
    city: 'Cairo',
    district: 'District',
    latitude: 30,
    longitude: 31,
    area: 120,
    bedrooms: 2,
    livingRooms: 1,
    kitchens: 1,
    bathrooms: 1,
    floor: 2,
    totalFloors: 5,
    buildingYear: 2020,
    finishingStatusCode: 'finished',
    deliveryStatusCode: 'ready',
    amenityCodes: [],
    totalPriceMinor: 1_000_000,
    downPaymentMinor: 200_000,
    currency: 'EGP',
    paymentMethodCode: 'cash',
    images: [{ publicId: 'gallery', resourceType: 'image' }],
    titleDeed: { publicId: 'private', resourceType: 'raw' },
    coverImageIndex: 0,
    status: 'approved',
  };
  it('plans conservative revision 1 without inventing unknown V1 values', () => {
    const plan = planLegacyPropertyRevision(
      legacy,
      { _id: ownerId, systemRole: 'USER', accountType: 'BROKER' },
      { _id: typeId, purposeCategoryId: purposeId },
      true,
    );
    expect(plan.propertySet).toMatchObject({
      advertiserAccountId: ownerId,
      advertiserAccountTypeSnapshot: 'BROKER',
      createdByActorId: ownerId,
      revisionSequence: 1,
    });
    expect(plan.revision).toMatchObject({
      revisionNumber: 1,
      purposeCategoryId: purposeId,
      purposeSubcategoryId: typeId,
      paymentMethodCodes: ['cash'],
      legacyDownPaymentMinor: 200_000,
      privateEvidenceAssets: [{ publicId: 'private', resourceType: 'raw' }],
    });
    expect(plan.revision).toHaveProperty('marketingMode', null);
    expect(plan.revision).toHaveProperty('entranceImageAsset', null);
  });
  it('leaves unknown hierarchy, payment, entrance, and mode neutral', () => {
    const plan = planLegacyPropertyRevision(legacy, {
      _id: ownerId,
      systemRole: 'USER',
      accountType: 'USER',
    });
    expect(plan.revision).toMatchObject({
      paymentMethodCodes: undefined,
      purposeCategoryId: null,
      purposeSubcategoryId: null,
    });
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        'PURPOSE_CATEGORY_UNKNOWN',
        'PAYMENT_METHOD_UNKNOWN',
        'ENTRANCE_IMAGE_UNKNOWN',
        'MARKETING_MODE_UNKNOWN',
      ]),
    );
  });
  it('never migrates an administrative account into a marketplace advertiser', () => {
    expect(() =>
      planLegacyPropertyRevision(legacy, {
        _id: ownerId,
        systemRole: 'ADMIN',
        accountType: 'USER',
      }),
    ).toThrow('administrative account');
  });
  it('maps approved history to public pointer and other history to pending pointer', () => {
    const revisionId = new ObjectId();
    expect(legacyRevisionPointer('approved', revisionId)).toEqual({
      currentPublicRevisionId: revisionId,
    });
    expect(legacyRevisionPointer('rejected', revisionId)).toEqual({
      pendingRevisionId: revisionId,
    });
  });
  it('declares a unique sequential revision index and immutable commercial snapshot fields', () => {
    expect(PropertyRevisionSchema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { propertyId: 1, revisionNumber: 1 },
          expect.objectContaining({ unique: true, name: 'property_revision_sequence_unique' }),
        ],
      ]),
    );
    expect(ManagedMarketingPackageSchema.path('priceMinor')).toBeDefined();
    expect(ManagedMarketingRequestSchema.path('packageSnapshot')).toBeDefined();
  });
  it('copies an immutable active-package snapshot without coupling history to later package edits', () => {
    const source = {
      _id: new ObjectId(),
      version: 3,
      code: 'premium',
      nameAr: 'مميز',
      nameEn: 'Premium',
      includedServiceCodes: ['inspection', 'photography'],
      benefitsAr: ['معاينة العقار', 'تصوير احترافي'],
      benefitsEn: ['Property inspection', 'Professional photography'],
      priceMinor: 250_000,
      currency: 'EGP',
      isActive: true,
    };
    const snapshot = buildManagedMarketingPackageSnapshot(source);
    source.nameEn = 'Changed';
    source.includedServiceCodes.push('boost');
    expect(snapshot).toMatchObject({
      packageVersion: 3,
      nameEn: 'Premium',
      priceMinor: 250_000,
      includedServiceCodes: ['inspection', 'photography'],
      benefitsAr: ['معاينة العقار', 'تصوير احترافي'],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
  it('enforces one managed-marketing request snapshot per property revision', () => {
    expect(ManagedMarketingRequestSchema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { propertyRevisionId: 1 },
          expect.objectContaining({
            unique: true,
            name: 'managed_marketing_request_revision_unique',
          }),
        ],
      ]),
    );
  });
  it('rejects inactive or unpriced managed-marketing packages', () => {
    const source = {
      _id: new ObjectId(),
      version: 1,
      code: 'draft',
      nameAr: 'مسودة',
      nameEn: 'Draft',
      includedServiceCodes: [],
      currency: 'EGP',
      isActive: false,
    };
    expect(() => buildManagedMarketingPackageSnapshot(source)).toThrow('باقة التسويق غير متاحة');
  });
  it('registers resumable data and index migrations in dependency order', () => {
    const ids = CORE_MIGRATIONS.map((migration) => migration.id);
    expect(ids).toEqual(
      expect.arrayContaining(['015-property-attribution-revisions', '015-property-domain-indexes']),
    );
    expect(
      CORE_MIGRATIONS.find((migration) => migration.id === '015-property-domain-indexes')
        ?.dependencies,
    ).toContain('015-property-attribution-revisions');
  });
  it('resumes after a revision insert without creating a duplicate revision', async () => {
    const revisionId = new ObjectId();
    const property = { ...legacy, propertyContractVersion: undefined };
    const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const insertOne = jest.fn();
    const collections = {
      properties: {
        find: jest.fn().mockReturnValue({
          sort: () => ({ limit: () => ({ toArray: jest.fn().mockResolvedValue([property]) }) }),
        }),
        updateOne,
      },
      users: {
        findOne: jest
          .fn()
          .mockResolvedValue({ _id: ownerId, systemRole: 'USER', accountType: 'USER' }),
      },
      property_types: {
        findOne: jest.fn().mockResolvedValue({ _id: typeId, purposeCategoryId: purposeId }),
      },
      property_options: { findOne: jest.fn().mockResolvedValue({ code: 'cash' }) },
      property_revisions: { findOne: jest.fn().mockResolvedValue({ _id: revisionId }), insertOne },
    };
    const result = await propertyAttributionRevisionMigration.migrateBatch({
      db: { collection: (name) => collections[name] },
      runId: 'resume-run',
      batchSize: 10,
    });
    expect(insertOne).not.toHaveBeenCalled();
    expect(updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: propertyId }), {
      $set: expect.objectContaining({
        currentPublicRevisionId: revisionId,
        propertyContractVersion: 1,
      }),
    });
    expect(result).toMatchObject({ scanned: 1, modified: 1, done: true });
  });
  it('is idempotent when a migrated record is encountered again', async () => {
    const updateOne = jest.fn();
    const insertOne = jest.fn();
    const collections = {
      properties: {
        find: jest.fn().mockReturnValue({
          sort: () => ({
            limit: () => ({
              toArray: jest.fn().mockResolvedValue([{ ...legacy, propertyContractVersion: 1 }]),
            }),
          }),
        }),
        updateOne,
      },
      property_revisions: { insertOne },
    };
    const result = await propertyAttributionRevisionMigration.migrateBatch({
      db: { collection: (name) => collections[name] },
      runId: 'rerun',
      batchSize: 10,
    });
    expect(updateOne).not.toHaveBeenCalled();
    expect(insertOne).not.toHaveBeenCalled();
    expect(result.modified).toBe(0);
  });
});
