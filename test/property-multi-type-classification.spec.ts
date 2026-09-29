import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Types } from 'mongoose';
import { PropertyErrorCode } from '../src/common/errors/property-error-codes';
import { CreatePropertyDto } from '../src/properties/dto/create-property.dto';
import { MAX_PROPERTY_TYPES, selectedPropertyTypeIds } from '../src/properties/property-classification';
import { PropertiesService } from '../src/properties/properties.service';
import { PropertyLifecycleStatus, PropertyMarketingMode } from '../src/properties/property.types';
import { AccountType } from '../src/users/identity.types';
import { FormDefinitionStore } from './support/form-definition-store';

/**
 * DPF-005 — multi-property-type classification: purposeSubcategoryId stays the
 * primary type, purposeSubcategoryIds holds the canonical full selection.
 */

const userId = '64b000000000000000000001';
const propertyId = '64b000000000000000000099';
const PURPOSE_A = '64b000000000000000000010';
const PURPOSE_B = '64b000000000000000000020';
// Hex ids chosen so the canonical (ascending) order differs from any natural client order.
const DUPLEX = '64b0000000000000000000a1';
const VILLA = '64b0000000000000000000a2';
const APARTMENT = '64b0000000000000000000a3';
const STUDIO = '64b0000000000000000000a4';
const CHALET = '64b0000000000000000000a5';
const RETIRED = '64b0000000000000000000a6';
const OFFICE = '64b0000000000000000000b1';

type CatalogType = { _id: Types.ObjectId; code: string; nameAr: string; purposeCategoryId: Types.ObjectId; isActive: boolean; sortOrder: number; iconKey?: string };
const catalogType = (id: string, code: string, nameAr: string, purpose: string, sortOrder: number, isActive = true): CatalogType => ({
  _id: new Types.ObjectId(id), code, nameAr, purposeCategoryId: new Types.ObjectId(purpose), isActive, sortOrder, iconKey: `${code}-icon`,
});

// The pre-multi-type (current Flutter) create/revision payload: only purposeSubcategoryId, mirroring test/properties.spec.ts.
const legacyDto = (overrides: Record<string, unknown> = {}): any => ({
  operationType: 'sale', purposeCategoryId: PURPOSE_A, purposeSubcategoryId: APARTMENT, title: 'شقة ممتازة للبيع',
  description: 'وصف تفصيلي صالح للعقار المعروض للبيع', governorateCode: 'cairo',
  city: 'القاهرة', district: 'التجمع', latitude: 30, longitude: 31, area: 150,
  bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2,
  totalFloors: 5, buildingYear: 2020, finishingStatusCode: 'fully_finished',
  deliveryStatusCode: 'immediate', amenityCodes: ['elevator'], totalPriceMinor: 100000000,
  currency: 'EGP', isPriceNegotiable: true, paymentMethodCodes: ['cash'], marketingMode: PropertyMarketingMode.PLATFORM_MANAGED,
  imageLabels: [], imageSlotIds: [], coverImageIndex: 0, hidePhone: false,
  ...overrides,
});

const matchesType = (type: CatalogType, filter: Record<string, any>) => Object.entries(filter).every(([key, condition]) => {
  const value = (type as any)[key];
  if (condition && typeof condition === 'object' && '$in' in condition) return condition.$in.map(String).includes(String(value));
  return String(value) === String(condition);
});

function writeHarness(options: {
  catalog?: CatalogType[];
  existingProperty?: Record<string, any> | null;
  latestRevision?: Record<string, any> | null;
  existingDraft?: Record<string, any> | null;
} = {}) {
  const catalog = options.catalog ?? [
    catalogType(DUPLEX, 'duplex', 'دوبلكس', PURPOSE_A, 3),
    catalogType(VILLA, 'villa', 'فيلا', PURPOSE_A, 2),
    catalogType(APARTMENT, 'apartment', 'شقة', PURPOSE_A, 1),
    catalogType(STUDIO, 'studio', 'ستوديو', PURPOSE_A, 4),
    catalogType(CHALET, 'chalet', 'شاليه', PURPOSE_A, 5),
    catalogType(RETIRED, 'retired', 'نوع موقوف', PURPOSE_A, 6, false),
    catalogType(OFFICE, 'office', 'مكتب', PURPOSE_B, 1),
  ];
  const usage = new Map<string, number>();
  const chain = (value: unknown) => {
    const query: any = { sort: () => query, select: () => query, session: () => query, lean: () => query, exec: async () => value };
    return query;
  };
  const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
  const createdRevisions: any[] = [];
  const createdProperties: any[] = [];
  const draftDocument: Record<string, any> | undefined = options.existingDraft ? {
    ...options.existingDraft, supersededAssets: [], galleryMedia: [], privateEvidenceAssets: [],
    set(values: any) { Object.assign(this, values); }, save: jest.fn(async () => undefined),
  } : undefined;
  const propertyTypes = {
    findOne: jest.fn((filter: any) => chain(catalog.find((type) => matchesType(type, filter)) ?? null)),
    find: jest.fn((filter: any) => chain(catalog.filter((type) => matchesType(type, filter)))),
    updateMany: jest.fn((filter: any) => {
      const matched = catalog.filter((type) => matchesType(type, filter));
      for (const type of matched) usage.set(type._id.toString(), (usage.get(type._id.toString()) ?? 0) + 1);
      return { exec: async () => ({ matchedCount: matched.length }) };
    }),
  };
  const revisions = {
    create: jest.fn(async ([value]: any[]) => { createdRevisions.push(value); return [value]; }),
    findOne: jest.fn((filter: any) => {
      if (filter._id) return chain(draftDocument ?? null);
      if (filter.moderationStatus === 'draft') return chain(options.existingDraft ?? null);
      return chain(options.latestRevision ?? null);
    }),
    deleteOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(undefined) })),
  };
  const properties = {
    create: jest.fn(async ([value]: any[]) => { createdProperties.push(value); return [{ ...value, toObject: () => ({ ...value, createdAt: new Date() }) }]; }),
    findOne: jest.fn(() => chain(options.existingProperty ?? null)),
    findOneAndUpdate: jest.fn(() => chain(options.existingProperty ?? null)),
    deleteOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(undefined) })),
  };
  const matched = (count: number) => ({ exec: jest.fn().mockResolvedValue({ matchedCount: count }) });
  const service = Object.create(PropertiesService.prototype) as any;
  Object.assign(service, {
    users: { find: jest.fn(() => chain([{ _id: new Types.ObjectId(userId), systemRole: 'USER', accountType: AccountType.USER, accountStatus: 'ACTIVE' }])) },
    purposeCategories: { findOne: jest.fn((filter: any) => chain({ _id: new Types.ObjectId(String(filter._id)) })), updateOne: jest.fn(() => matched(1)) },
    propertyTypes,
    governorates: { findOne: jest.fn(() => chain({ _id: new Types.ObjectId(), code: 'cairo' })), updateOne: jest.fn(() => matched(1)) },
    cities: { findOne: jest.fn(() => chain({ _id: new Types.ObjectId(), nameAr: 'القاهرة' })), updateOne: jest.fn(() => matched(1)) },
    options: { findOne: jest.fn(() => chain({ code: 'valid' })), find: jest.fn(() => chain([{ code: 'cash' }])), updateMany: jest.fn(() => matched(3)) },
    amenities: { countDocuments: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(1) })), updateMany: jest.fn(() => matched(1)) },
    auctionLock: { assertUnlocked: jest.fn().mockResolvedValue(undefined) },
    properties, revisions,
    connection: { startSession: jest.fn().mockResolvedValue(session) },
    audit: { logRequired: jest.fn(), logResourceAction: jest.fn(), logAdminResourceAction: jest.fn() },
    evidenceAssets: { deleteOrEnqueue: jest.fn() },
    // Every type has the seeded legacy v1 (migration 026).
    ...new FormDefinitionStore().models(),
  });
  const stored = () => createdRevisions.at(-1) ?? draftDocument;
  return { service: service as any, propertyTypes, revisions, properties, usage, createdRevisions, createdProperties, draftDocument, stored, session };
}

const ids = (values: unknown[] | undefined) => (values ?? []).map(String);
const errorOf = async (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected rejection'); }, (error) => error);
const expectInvalid = async (promise: Promise<unknown>, details: Record<string, unknown>) => {
  const error = await errorOf(promise);
  expect(error.getStatus()).toBe(400);
  expect(error.getResponse()).toEqual({ message: 'أنواع العقار المختارة غير صالحة', code: PropertyErrorCode.SUBCATEGORIES_INVALID, details });
};

describe('DPF-005 create: selection, validation and dual-write', () => {
  it('stores [primary] for a legacy single-id create, on both the revision and the new aggregate', async () => {
    const ctx = writeHarness();
    await ctx.service.create(userId, legacyDto(), {});
    const revision = ctx.createdRevisions[0];
    expect(String(revision.purposeSubcategoryId)).toBe(APARTMENT);
    expect(ids(revision.purposeSubcategoryIds)).toEqual([APARTMENT]);
    expect(String(ctx.createdProperties[0].purposeSubcategoryId)).toBe(APARTMENT);
    expect(ids(ctx.createdProperties[0].purposeSubcategoryIds)).toEqual([APARTMENT]);
    expect(revision.purposeSubcategoryIds.every((value: unknown) => value instanceof Types.ObjectId)).toBe(true);
  });

  it('stores a valid multi-type selection with the primary kept separately and included in the array', async () => {
    const ctx = writeHarness();
    await ctx.service.create(userId, legacyDto({ purposeSubcategoryIds: [APARTMENT, DUPLEX, VILLA] }), {});
    const revision = ctx.createdRevisions[0];
    expect(String(revision.purposeSubcategoryId)).toBe(APARTMENT);
    expect(revision.legacyPropertyTypeCode).toBe('apartment');
    expect(ids(revision.purposeSubcategoryIds)).toEqual([DUPLEX, VILLA, APARTMENT]);
    expect(ids(ctx.createdProperties[0].purposeSubcategoryIds)).toEqual([DUPLEX, VILLA, APARTMENT]);
    expect(ctx.createdProperties[0].propertyTypeCode).toBe('apartment');
  });

  it('persists one canonical order whatever order (or hex case) the client used', async () => {
    const orders = [[APARTMENT, DUPLEX, VILLA], [VILLA, APARTMENT, DUPLEX], [DUPLEX.toUpperCase(), VILLA, APARTMENT]];
    const stored: string[][] = [];
    for (const order of orders) {
      const ctx = writeHarness();
      await ctx.service.create(userId, legacyDto({ purposeSubcategoryIds: order }), {});
      stored.push(ids(ctx.createdRevisions[0].purposeSubcategoryIds));
    }
    expect(stored).toEqual([[DUPLEX, VILLA, APARTMENT], [DUPLEX, VILLA, APARTMENT], [DUPLEX, VILLA, APARTMENT]]);
  });

  it('gives the same idempotency fingerprint to the same logical selection in any order, and a different one otherwise', () => {
    const { service } = writeHarness();
    const fingerprint = (dto: any) => service.requestFingerprint('new', dto, {});
    const base = fingerprint(legacyDto({ purposeSubcategoryIds: [APARTMENT, DUPLEX] }));
    expect(fingerprint(legacyDto({ purposeSubcategoryIds: [DUPLEX, APARTMENT] }))).toBe(base);
    expect(fingerprint(legacyDto({ purposeSubcategoryIds: [DUPLEX.toUpperCase(), APARTMENT] }))).toBe(base);
    expect(fingerprint(legacyDto({ purposeSubcategoryIds: [APARTMENT] }))).not.toBe(base);
    expect(fingerprint(legacyDto({ purposeSubcategoryIds: [APARTMENT, VILLA] }))).not.toBe(base);
    // Omitting the array is a different request (it may carry types forward on edit).
    expect(fingerprint(legacyDto())).not.toBe(fingerprint(legacyDto({ purposeSubcategoryIds: [APARTMENT] })));
  });

  it('rejects an empty selection', async () => {
    await expectInvalid(writeHarness().service.create(userId, legacyDto({ purposeSubcategoryIds: [] }), {}), { reason: 'EMPTY' });
  });

  it(`rejects more than ${MAX_PROPERTY_TYPES} selected types`, async () => {
    await expectInvalid(
      writeHarness().service.create(userId, legacyDto({ purposeSubcategoryIds: [APARTMENT, DUPLEX, VILLA, STUDIO, CHALET] }), {}),
      { reason: 'TOO_MANY', maxPropertyTypes: 4 },
    );
    const ctx = writeHarness();
    await ctx.service.create(userId, legacyDto({ purposeSubcategoryIds: [APARTMENT, DUPLEX, VILLA, STUDIO] }), {});
    expect(ctx.createdRevisions[0].purposeSubcategoryIds).toHaveLength(4);
  });

  it('rejects duplicate ids, including the same id in different hex case', async () => {
    await expectInvalid(writeHarness().service.create(userId, legacyDto({ purposeSubcategoryIds: [APARTMENT, DUPLEX, DUPLEX] }), {}), { reason: 'DUPLICATE', invalidIds: [DUPLEX] });
    await expectInvalid(writeHarness().service.create(userId, legacyDto({ purposeSubcategoryIds: [APARTMENT, DUPLEX, DUPLEX.toUpperCase()] }), {}), { reason: 'DUPLICATE', invalidIds: [DUPLEX] });
  });

  it('rejects a selection that leaves out the primary', async () => {
    await expectInvalid(writeHarness().service.create(userId, legacyDto({ purposeSubcategoryIds: [DUPLEX, VILLA] }), {}), { reason: 'PRIMARY_NOT_INCLUDED', invalidIds: [APARTMENT] });
  });

  it('rejects inactive or unknown additional types with their ids', async () => {
    const unknown = '64b0000000000000000000ff';
    await expectInvalid(
      writeHarness().service.create(userId, legacyDto({ purposeSubcategoryIds: [APARTMENT, RETIRED, unknown, DUPLEX] }), {}),
      { reason: 'INACTIVE', invalidIds: [RETIRED, unknown] },
    );
  });

  it('keeps PROPERTY_PURPOSE_HIERARCHY_MISMATCH for a selected type under another purpose', async () => {
    const ctx = writeHarness();
    const error = await errorOf(ctx.service.create(userId, legacyDto({ purposeSubcategoryIds: [APARTMENT, OFFICE] }), {}));
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toMatchObject({ code: PropertyErrorCode.PURPOSE_HIERARCHY_MISMATCH, details: { invalidIds: [OFFICE] } });
    expect(ctx.createdRevisions).toHaveLength(0);
  });

  it('keeps the existing primary-type errors unchanged', async () => {
    const inactivePrimary = await errorOf(writeHarness().service.create(userId, legacyDto({ purposeSubcategoryId: RETIRED, purposeSubcategoryIds: [RETIRED] }), {}));
    expect(inactivePrimary.getResponse()).toMatchObject({ code: PropertyErrorCode.PURPOSE_SUBCATEGORY_INVALID });
    const foreignPrimary = await errorOf(writeHarness().service.create(userId, legacyDto({ purposeSubcategoryId: OFFICE }), {}));
    expect(foreignPrimary.getResponse()).toEqual({ message: 'نوع العقار الفرعي لا يتبع غرض العقار المحدد', code: PropertyErrorCode.PURPOSE_HIERARCHY_MISMATCH });
  });

  it('increments usageCount once for every selected type, never twice for the primary', async () => {
    const ctx = writeHarness();
    await ctx.service.create(userId, legacyDto({ purposeSubcategoryIds: [APARTMENT, DUPLEX, VILLA] }), {});
    expect(ctx.propertyTypes.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update, options] = ctx.propertyTypes.updateMany.mock.calls[0] as any[];
    expect(ids(filter._id.$in)).toEqual([DUPLEX, VILLA, APARTMENT]);
    expect(filter).toMatchObject({ purposeCategoryId: expect.anything(), isActive: true });
    expect(update).toEqual({ $inc: { usageCount: 1 } });
    expect(options).toEqual({ session: ctx.session });
    expect(Object.fromEntries(ctx.usage)).toEqual({ [DUPLEX]: 1, [VILLA]: 1, [APARTMENT]: 1 });

    const legacy = writeHarness();
    await legacy.service.create(userId, legacyDto(), {});
    expect(Object.fromEntries(legacy.usage)).toEqual({ [APARTMENT]: 1 });
  });

  it('aborts when a selected type stops matching inside the transaction (count-checked usage update)', async () => {
    const ctx = writeHarness();
    ctx.propertyTypes.updateMany.mockReturnValueOnce({ exec: async () => ({ matchedCount: 2 }) } as any);
    const error = await errorOf(ctx.service.create(userId, legacyDto({ purposeSubcategoryIds: [APARTMENT, DUPLEX, VILLA] }), {}));
    expect(error.getResponse()).toMatchObject({ code: PropertyErrorCode.PURPOSE_HIERARCHY_MISMATCH });
  });
});

describe('DPF-005 edits: explicit arrays and old-client carry-forward', () => {
  const existingProperty = {
    _id: new Types.ObjectId(propertyId), advertiserAccountId: new Types.ObjectId(userId), ownerId: new Types.ObjectId(userId),
    revisionSequence: 2, lifecycleStatus: PropertyLifecycleStatus.ACTIVE, city: 'القاهرة', createdAt: new Date(),
    propertyContractVersion: 1, totalPriceMinor: 100000000, currency: 'EGP',
  };
  const latest = (primary: string, selected?: string[]) => ({
    purposeSubcategoryId: new Types.ObjectId(primary), ...(selected ? { purposeSubcategoryIds: selected.map((id) => new Types.ObjectId(id)) } : {}),
  });

  it('carries the latest revision\'s additional types forward when an old client keeps the primary', async () => {
    const ctx = writeHarness({ existingProperty, latestRevision: latest(APARTMENT, [DUPLEX, VILLA, APARTMENT]) });
    await ctx.service.createDraftRevision(userId, propertyId, legacyDto(), {});
    expect(ids(ctx.createdRevisions[0].purposeSubcategoryIds)).toEqual([DUPLEX, VILLA, APARTMENT]);
    expect(String(ctx.createdRevisions[0].purposeSubcategoryId)).toBe(APARTMENT);
    expect(ctx.revisions.findOne).toHaveBeenCalledWith({ propertyId: existingProperty._id });
  });

  it('drops carried types that are no longer valid instead of failing the old client', async () => {
    const ctx = writeHarness({ existingProperty, latestRevision: latest(APARTMENT, [DUPLEX, RETIRED, APARTMENT, OFFICE]) });
    await ctx.service.createDraftRevision(userId, propertyId, legacyDto(), {});
    expect(ids(ctx.createdRevisions[0].purposeSubcategoryIds)).toEqual([DUPLEX, APARTMENT]);
  });

  it('carries forward from the existing draft when an old client saves it again', async () => {
    const existingDraft = { _id: new Types.ObjectId(), revisionNumber: 3, decisionVersion: 1, city: 'القاهرة', ...latest(APARTMENT, [APARTMENT, STUDIO]) };
    const ctx = writeHarness({ existingProperty, existingDraft, latestRevision: latest(APARTMENT, [APARTMENT, CHALET]) });
    await ctx.service.createDraftRevision(userId, propertyId, legacyDto({ expectedRevisionVersion: 1 }), {});
    expect(ids(ctx.draftDocument!.purposeSubcategoryIds as any)).toEqual([APARTMENT, STUDIO]);
    expect(ctx.draftDocument!.save).toHaveBeenCalled();
  });

  it('falls back to [newPrimary] when an old client changes the primary', async () => {
    const ctx = writeHarness({ existingProperty, latestRevision: latest(APARTMENT, [DUPLEX, VILLA, APARTMENT]) });
    await ctx.service.createDraftRevision(userId, propertyId, legacyDto({ purposeSubcategoryId: STUDIO }), {});
    expect(ids(ctx.createdRevisions[0].purposeSubcategoryIds)).toEqual([STUDIO]);
    expect(String(ctx.createdRevisions[0].purposeSubcategoryId)).toBe(STUDIO);
  });

  it('reads a pre-DPF-005 latest revision as [primary] when carrying forward', async () => {
    const ctx = writeHarness({ existingProperty, latestRevision: latest(APARTMENT) });
    await ctx.service.createDraftRevision(userId, propertyId, legacyDto(), {});
    expect(ids(ctx.createdRevisions[0].purposeSubcategoryIds)).toEqual([APARTMENT]);
  });

  it('lets an explicit new-client array replace the classification', async () => {
    const ctx = writeHarness({ existingProperty, latestRevision: latest(APARTMENT, [DUPLEX, VILLA, APARTMENT]) });
    await ctx.service.createDraftRevision(userId, propertyId, legacyDto({ purposeSubcategoryIds: [STUDIO, APARTMENT] }), {});
    expect(ids(ctx.createdRevisions[0].purposeSubcategoryIds)).toEqual([APARTMENT, STUDIO]);
    expect(Object.fromEntries(ctx.usage)).toEqual({ [APARTMENT]: 1, [STUDIO]: 1 });
  });
});

describe('DPF-005 multipart transport', () => {
  const body = (extra: Record<string, unknown>) => ({
    ...Object.fromEntries(Object.entries(legacyDto()).map(([key, value]) => [key, Array.isArray(value) ? JSON.stringify(value) : String(value)])),
    ...extra,
  });
  const parse = async (extra: Record<string, unknown>) => {
    const dto = plainToInstance(CreatePropertyDto, body(extra));
    return { dto, errors: (await validate(dto)).map((error) => error.property) };
  };

  it('decodes a JSON-array multipart field and keeps the single-id contract when it is absent', async () => {
    const withArray = await parse({ purposeSubcategoryIds: JSON.stringify([APARTMENT, DUPLEX]) });
    expect(withArray.errors).toEqual([]);
    expect(withArray.dto.purposeSubcategoryIds).toEqual([APARTMENT, DUPLEX]);
    const legacy = await parse({});
    expect(legacy.errors).toEqual([]);
    expect(legacy.dto.purposeSubcategoryIds).toBeUndefined();
    expect(legacy.dto.purposeSubcategoryId).toBe(APARTMENT);
  });

  it('rejects malformed ids at the transport layer and leaves count rules to the service', async () => {
    expect((await parse({ purposeSubcategoryIds: JSON.stringify([APARTMENT, 'not-an-id']) })).errors).toEqual(['purposeSubcategoryIds']);
    expect((await parse({ purposeSubcategoryIds: '[]' })).errors).toEqual([]);
  });
});

describe('DPF-005 submission re-checks every selected type', () => {
  function submissionService(catalog: CatalogType[]) {
    const chain = (value: unknown) => { const query: any = { session: () => query, lean: () => query, exec: async () => value }; return query; };
    const service = Object.create(PropertiesService.prototype) as any;
    Object.assign(service, {
      purposeCategories: { findOne: jest.fn(() => chain({ _id: new Types.ObjectId(PURPOSE_A) })) },
      propertyTypes: {
        findOne: jest.fn((filter: any) => chain(catalog.find((type) => matchesType(type, filter)) ?? null)),
        find: jest.fn((filter: any) => chain(catalog.filter((type) => matchesType(type, filter)))),
      },
      options: {
        countDocuments: jest.fn(() => ({ session: () => ({ exec: async () => 1 }) })),
        find: jest.fn(() => chain([{ group: 'finishing_status', code: 'fully_finished' }, { group: 'delivery_status', code: 'immediate' }])),
      },
      ...new FormDefinitionStore().models(),
    });
    return service;
  }
  // A legacy (pre-pinning) draft, as the legacy DTO always stored it.
  const candidate = (selected: string[]) => ({
    operationType: 'sale', bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020,
    finishingStatusCode: 'fully_finished', deliveryStatusCode: 'immediate',
    totalPriceMinor: 100, currency: 'EGP', marketingMode: PropertyMarketingMode.PLATFORM_MANAGED, paymentMethodCodes: ['cash'], galleryMedia: [{ slotId: 'exterior' }],
    purposeCategoryId: new Types.ObjectId(PURPOSE_A), purposeSubcategoryId: new Types.ObjectId(APARTMENT), purposeSubcategoryIds: selected.map((id) => new Types.ObjectId(id)),
  });

  it('rejects submission when an additional type was deactivated after the draft was saved', async () => {
    const service = submissionService([catalogType(APARTMENT, 'apartment', 'شقة', PURPOSE_A, 1), catalogType(DUPLEX, 'duplex', 'دوبلكس', PURPOSE_A, 2, false)]);
    const error = await errorOf(service.validateRevisionForSubmission(candidate([APARTMENT, DUPLEX]), {}));
    expect(error.getResponse()).toMatchObject({ code: PropertyErrorCode.SUBCATEGORIES_INVALID, details: { reason: 'INACTIVE', invalidIds: [DUPLEX] } });
  });

  it('accepts a still-valid multi-type revision', async () => {
    const service = submissionService([catalogType(APARTMENT, 'apartment', 'شقة', PURPOSE_A, 1), catalogType(DUPLEX, 'duplex', 'دوبلكس', PURPOSE_A, 2)]);
    await expect(service.validateRevisionForSubmission(candidate([APARTMENT, DUPLEX]), {})).resolves.toBeUndefined();
  });
});

describe('DPF-005 approval syncs the selection in the existing transaction', () => {
  function approval(revisionClassification: Record<string, unknown>) {
    let inTransaction = false;
    const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => { inTransaction = true; try { await work(); } finally { inTransaction = false; } }), endSession: jest.fn() };
    const aggregate: Record<string, any> = { _id: propertyId, ownerId: userId, pendingRevisionId: 'pending', publishedAt: new Date(), area: 100 };
    const calls: any[] = [];
    const approved = { _id: new Types.ObjectId(), revisionNumber: 2, area: 130, purposeCategoryId: new Types.ObjectId(PURPOSE_A), legacyPropertyTypeCode: 'apartment', ...revisionClassification };
    const service = Object.create(PropertiesService.prototype) as any;
    Object.assign(service, {
      properties: {
        findOne: jest.fn(() => ({ session: () => ({ exec: async () => aggregate }) })),
        updateOne: jest.fn((filter: any, update: any, options: any) => { calls.push({ update, options, inTransaction }); Object.assign(aggregate, update.$set); return { exec: async () => ({ modifiedCount: 1 }) }; }),
      },
      revisions: {
        findOne: jest.fn(() => ({ session: () => ({ lean: () => ({ exec: async () => ({ marketingMode: 'PLATFORM_MANAGED', galleryMedia: [{ mediaId: 'm' }] }) }) }) })),
        findOneAndUpdate: jest.fn(() => ({ exec: async () => approved })),
      },
      audit: { logRequired: jest.fn() }, outbox: { recordRequired: jest.fn() },
      connection: { startSession: jest.fn().mockResolvedValue(session) }, getForAdmin: jest.fn().mockResolvedValue({}),
    });
    return { service, aggregate, calls, session };
  }

  it('copies purposeSubcategoryIds with the primary and area in the single aggregate update', async () => {
    const ctx = approval({ purposeSubcategoryId: new Types.ObjectId(APARTMENT), purposeSubcategoryIds: [DUPLEX, APARTMENT].map((id) => new Types.ObjectId(id)) });
    await ctx.service.reviewForAdmin(propertyId, '64b000000000000000000088', 0, 'approved', undefined, userId);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]).toMatchObject({ inTransaction: true, options: { session: ctx.session } });
    expect(ids(ctx.calls[0].update.$set.purposeSubcategoryIds)).toEqual([DUPLEX, APARTMENT]);
    expect(String(ctx.aggregate.purposeSubcategoryId)).toBe(APARTMENT);
    expect(ids(ctx.aggregate.purposeSubcategoryIds)).toEqual([DUPLEX, APARTMENT]);
    expect(ctx.aggregate.area).toBe(130);
  });

  it('syncs a pre-DPF-005 revision as [primary]', async () => {
    const ctx = approval({ purposeSubcategoryId: new Types.ObjectId(APARTMENT) });
    await ctx.service.reviewForAdmin(propertyId, '64b000000000000000000088', 0, 'approved', undefined, userId);
    expect(ids(ctx.aggregate.purposeSubcategoryIds)).toEqual([APARTMENT]);
  });
});

describe('DPF-005 reads: legacy fallback, projections and anchoring', () => {
  const lookup = (items: unknown[]) => ({ find: jest.fn().mockReturnValue({ lean: () => ({ exec: jest.fn().mockResolvedValue(items) }) }) });
  function readService(extra: Record<string, unknown> = {}) {
    const service = Object.create(PropertiesService.prototype) as any;
    Object.assign(service, {
      governorates: lookup([{ code: 'cairo', nameAr: 'القاهرة' }]),
      propertyTypes: lookup([
        catalogType(APARTMENT, 'apartment', 'شقة', PURPOSE_A, 5), catalogType(DUPLEX, 'duplex', 'دوبلكس', PURPOSE_A, 2),
        catalogType(VILLA, 'villa', 'فيلا', PURPOSE_A, 1),
      ]),
      purposeCategories: lookup([{ _id: new Types.ObjectId(PURPOSE_A), nameAr: 'سكني' }]),
      options: lookup([]),
      amenities: lookup([]),
      ...extra,
    });
    return service;
  }
  const revision = (overrides: Record<string, unknown> = {}): Record<string, any> => ({
    _id: new Types.ObjectId(), propertyId: new Types.ObjectId(propertyId), revisionNumber: 2, title: 'عنوان', description: 'وصف', operationType: 'sale',
    purposeCategoryId: new Types.ObjectId(PURPOSE_A), purposeSubcategoryId: new Types.ObjectId(APARTMENT), legacyPropertyTypeCode: 'apartment',
    governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع', area: 120, totalPriceMinor: 100, currency: 'EGP', paymentMethodCodes: [], galleryMedia: [], coverImageIndex: 0,
    moderationStatus: 'approved', ...overrides,
  });
  const aggregate = (current: unknown) => ({ _id: new Types.ObjectId(propertyId), status: 'approved', lifecycleStatus: 'active', createdAt: new Date('2026-01-01'), images: [], currentPublicRevisionId: current });

  it('reads a legacy revision without the array as [purposeSubcategoryId], without rewriting it', async () => {
    const legacy = revision();
    expect(selectedPropertyTypeIds(legacy).map(String)).toEqual([APARTMENT]);
    expect(selectedPropertyTypeIds({ purposeSubcategoryId: null })).toEqual([]);
    const [item] = await readService().hydratePublicListings([aggregate(legacy)]);
    expect(item).toMatchObject({ purposeSubcategoryId: APARTMENT, purposeSubcategoryIds: [APARTMENT], propertyTypes: [{ id: APARTMENT, code: 'apartment', nameAr: 'شقة', iconKey: 'apartment-icon', isPrimary: true }] });
    expect(legacy).not.toHaveProperty('purposeSubcategoryIds');
  });

  it('projects every selected type (primary first, then catalog order) while the legacy fields keep describing the primary', async () => {
    const [item] = await readService().hydratePublicListings([aggregate(revision({ purposeSubcategoryIds: [DUPLEX, VILLA, APARTMENT].map((id) => new Types.ObjectId(id)) }))]);
    expect(item.propertyTypes.map((type: any) => [type.id, type.isPrimary])).toEqual([[APARTMENT, true], [VILLA, false], [DUPLEX, false]]);
    expect(item).toMatchObject({ purposeSubcategoryId: APARTMENT, propertyTypeCode: 'apartment', propertyTypeNameAr: 'شقة', purposeSubcategoryIds: [DUPLEX, VILLA, APARTMENT] });
  });

  it('includes propertyTypes on the public detail and resolves every selected type in one lookup', async () => {
    const current = revision({ purposeSubcategoryIds: [DUPLEX, APARTMENT].map((id) => new Types.ObjectId(id)) });
    const find = jest.fn().mockReturnValue({ lean: () => ({ exec: async () => [catalogType(APARTMENT, 'apartment', 'شقة', PURPOSE_A, 5), catalogType(DUPLEX, 'duplex', 'دوبلكس', PURPOSE_A, 2)] }) });
    const byId = (value: unknown) => ({ lean: () => ({ exec: async () => value }) });
    const service = readService({
      properties: { findOne: jest.fn(() => ({ populate: () => ({ lean: () => ({ exec: async () => aggregate(current) }) }) })) },
      purposeCategories: { findById: jest.fn(() => byId({ nameAr: 'سكني' })) },
      propertyTypes: { find },
      governorates: { findOne: jest.fn(() => byId({ nameAr: 'القاهرة' })) },
      options: { find: jest.fn(() => byId([])) },
    });
    const { property } = await service.getPublished(propertyId);
    expect(ids(find.mock.calls[0][0]._id.$in)).toEqual([DUPLEX, APARTMENT]);
    expect(property).toMatchObject({ propertyTypeNameAr: 'شقة', purposeSubcategoryId: APARTMENT, purposeSubcategoryIds: [DUPLEX, APARTMENT] });
    expect(property.propertyTypes.map((type: any) => type.id)).toEqual([APARTMENT, DUPLEX]);
  });

  it('shows the anchored revision\'s classification on auction projections, not the newer current one', async () => {
    const anchored = revision({ purposeSubcategoryIds: [DUPLEX, APARTMENT].map((id) => new Types.ObjectId(id)) });
    const current = revision({ _id: new Types.ObjectId(), purposeSubcategoryId: new Types.ObjectId(VILLA), purposeSubcategoryIds: [new Types.ObjectId(VILLA)], legacyPropertyTypeCode: 'villa' });
    const revisionsFind = jest.fn((_filter: unknown, _projection: unknown) => ({ lean: () => ({ exec: async () => [anchored] }) }));
    const service = readService({
      properties: { find: jest.fn(() => ({ lean: () => ({ exec: async () => [{ ...aggregate(current._id), purposeSubcategoryId: current.purposeSubcategoryId, purposeSubcategoryIds: current.purposeSubcategoryIds }] }) })) },
      revisions: { find: revisionsFind },
    });
    const result = await service.getAnchoredPublicProjections([{ propertyId, revisionId: anchored._id.toString() }]);
    const item = result.get(`${propertyId}:${anchored._id.toString()}`);
    expect(item).toMatchObject({ purposeSubcategoryId: APARTMENT, purposeSubcategoryIds: [DUPLEX, APARTMENT], propertyTypeNameAr: 'شقة' });
    expect(item.propertyTypes.map((type: any) => type.id)).toEqual([APARTMENT, DUPLEX]);
    expect(String(revisionsFind.mock.calls[0][1]).split(' ')).toContain('purposeSubcategoryIds');
  });
});

describe('DPF-007 search matches any selected type (superseding the DPF-005 primary-only stage)', () => {
  it('filters purposeSubcategoryId=X on the selected-type array, not on the primary field', async () => {
    const service = Object.create(PropertiesService.prototype) as any;
    Object.assign(service, {
      propertyTypes: { findById: jest.fn(() => ({ lean: () => ({ exec: async () => ({ _id: new Types.ObjectId(DUPLEX), purposeCategoryId: new Types.ObjectId(PURPOSE_A) }) }) })) },
    });
    const { filter } = await service.buildPublicListingQuery({ purposeSubcategoryId: DUPLEX });
    expect(String(filter.purposeSubcategoryIds)).toBe(DUPLEX);
    expect(String(filter.purposeCategoryId)).toBe(PURPOSE_A);
    expect(filter).not.toHaveProperty('purposeSubcategoryId');
  });
});
