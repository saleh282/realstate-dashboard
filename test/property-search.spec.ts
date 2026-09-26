import { BadRequestException } from '@nestjs/common';
import { PropertiesService } from '../src/properties/properties.service';
import { PropertyErrorCode } from '../src/common/errors/property-error-codes';
import { PropertyLifecycleStatus } from '../src/properties/property.types';
import { ListPublishedPropertiesDto } from '../src/properties/dto/list-published-properties.dto';

/**
 * MAZAD-021 — server-side property search, filtering, sorting and pagination.
 *
 * `fakeCollection` is a tiny in-memory stand-in for the Mongoose query chain
 * (`find(filter).sort().skip().limit().populate().lean().exec()`) that applies
 * the same operators `PropertiesService` actually issues ($ne, $nin, $in, $exists,
 * $gte/$lte, $regex/$options, $or, equality incl. ObjectId-like values). This
 * lets the filter/sort/pagination behaviour be exercised end-to-end against
 * realistic fixtures instead of asserting on mocked call shapes.
 */
function coerce(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value) && typeof (value as any).toString === 'function') {
    return (value as any).toString();
  }
  return value;
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
    return Object.entries(condition as Record<string, unknown>).every(([op, opValue]) => {
      switch (op) {
        case '$exists': return (value !== undefined) === opValue;
        case '$ne': return coerce(value) !== coerce(opValue);
        case '$nin': return !(opValue as unknown[]).map(coerce).includes(coerce(value));
        case '$in': return (opValue as unknown[]).map(coerce).includes(coerce(value));
        case '$gte': return value !== undefined && (value as number) >= (opValue as number);
        case '$lte': return value !== undefined && (value as number) <= (opValue as number);
        case '$regex': return new RegExp(opValue as string, (condition as any).$options ?? '').test(String(value ?? ''));
        case '$options': return true;
        default: return true;
      }
    });
  }
  return coerce(value) === coerce(condition);
}

function matchesFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') return (condition as Record<string, unknown>[]).some((sub) => matchesFilter(doc, sub));
    return matchesCondition(doc[key], condition);
  });
}

function fakeCollection(docs: Record<string, any>[]) {
  return {
    findOne: jest.fn((filter: Record<string, unknown> = {}) => {
      const result = docs.find((doc) => matchesFilter(doc, filter)) ?? null;
      const chain: any = {
        populate: () => chain,
        lean: () => chain,
        exec: async () => result,
      };
      return chain;
    }),
    find: jest.fn((filter: Record<string, unknown> = {}) => {
      let results = docs.filter((doc) => matchesFilter(doc, filter));
      const chain: any = {
        sort: (spec: Record<string, 1 | -1>) => {
          const entries = Object.entries(spec);
          results = [...results].sort((a, b) => {
            for (const [field, dir] of entries) {
              const av = a[field]; const bv = b[field];
              if (av === bv) continue;
              return av > bv ? dir : -dir;
            }
            return 0;
          });
          return chain;
        },
        skip: (n: number) => { results = results.slice(n); return chain; },
        limit: (n: number) => { results = results.slice(0, n); return chain; },
        populate: () => chain,
        lean: () => chain,
        exec: async () => results,
      };
      return chain;
    }),
    countDocuments: jest.fn((filter: Record<string, unknown> = {}) => ({
      exec: async () => docs.filter((doc) => matchesFilter(doc, filter)).length,
    })),
    exists: jest.fn((filter: Record<string, unknown> = {}) => ({
      exec: async () => (docs.some((doc) => matchesFilter(doc, filter)) ? { _id: (docs.find((doc) => matchesFilter(doc, filter)) as any)._id } : null),
    })),
  };
}

const emptyLookup = { find: jest.fn().mockReturnValue({ lean: () => ({ exec: jest.fn().mockResolvedValue([]) }) }) };

const CATEGORY_A = '64b000000000000000000010';
const SUBCATEGORY_A1 = '64b000000000000000000011'; // belongs to CATEGORY_A
const CATEGORY_B = '64b000000000000000000020';
const SUBCATEGORY_B1 = '64b000000000000000000021'; // belongs to CATEGORY_B

function makeProperty(overrides: Record<string, any> = {}) {
  const id = overrides.id ?? overrides._id ?? 'p1';
  const revisionOverrides = overrides.revision ?? {};
  return {
    _id: id,
    advertiserAccountId: undefined,
    createdByActorId: undefined,
    operationType: 'sale',
    propertyTypeCode: 'apartment',
    purposeCategoryId: CATEGORY_A,
    purposeSubcategoryId: SUBCATEGORY_A1,
    title: 'شقة للبيع',
    description: 'وصف العقار',
    governorateCode: 'cairo',
    city: 'القاهرة الجديدة',
    district: 'التجمع',
    area: 150,
    bedrooms: 3,
    bathrooms: 2,
    floor: 2,
    totalPriceMinor: 100_000_000,
    currency: 'EGP',
    images: [],
    coverImageIndex: 0,
    advertiserType: 'owner',
    isOwnerVisible: true,
    status: 'approved',
    lifecycleStatus: PropertyLifecycleStatus.ACTIVE,
    lifecycleVersion: 0,
    pendingRevisionId: undefined,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    currentPublicRevisionId: {
      _id: `${id}-rev`,
      revisionNumber: 1,
      title: 'شقة للبيع',
      description: 'وصف العقار',
      operationType: 'sale',
      purposeCategoryId: CATEGORY_A,
      purposeSubcategoryId: SUBCATEGORY_A1,
      governorateCode: 'cairo',
      city: 'القاهرة الجديدة',
      district: 'التجمع',
      area: 150,
      bedrooms: 3,
      bathrooms: 2,
      floor: 2,
      totalPriceMinor: 100_000_000,
      currency: 'EGP',
      galleryMedia: [],
      paymentMethodCodes: [],
      moderationStatus: 'approved',
      decisionVersion: 0,
      coverImageIndex: 0,
      ...revisionOverrides,
    },
    ...overrides,
  };
}

function service(docs: Record<string, any>[], catalogOverrides: Record<string, unknown> = {}) {
  const instance = Object.create(PropertiesService.prototype) as any;
  Object.assign(instance, {
    properties: fakeCollection(docs),
    governorates: emptyLookup,
    propertyTypes: {
      ...emptyLookup,
      findById: jest.fn((id: string) => ({
        lean: () => ({
          exec: jest.fn().mockResolvedValue(
            id === SUBCATEGORY_A1 ? { _id: SUBCATEGORY_A1, code: 'apartment', purposeCategoryId: CATEGORY_A }
              : id === SUBCATEGORY_B1 ? { _id: SUBCATEGORY_B1, code: 'villa', purposeCategoryId: CATEGORY_B }
                : null,
          ),
        }),
      })),
    },
    purposeCategories: {
      ...emptyLookup,
      exists: jest.fn((filter: { _id: string }) => ({
        exec: jest.fn().mockResolvedValue([CATEGORY_A, CATEGORY_B].includes(filter._id) ? { _id: filter._id } : null),
      })),
    },
    options: emptyLookup,
    ...catalogOverrides,
  });
  return instance as PropertiesService;
}

describe('MAZAD-021 public property search', () => {
  describe('visibility isolation', () => {
    const docs = [
      makeProperty({ id: 'approved-visible' }),
      makeProperty({ id: 'pending', status: 'pending_review', currentPublicRevisionId: undefined }),
      makeProperty({ id: 'rejected', status: 'rejected', currentPublicRevisionId: undefined }),
      makeProperty({ id: 'owner-hidden', isOwnerVisible: false }),
      makeProperty({ id: 'archived', lifecycleStatus: PropertyLifecycleStatus.ARCHIVED }),
      makeProperty({ id: 'admin-hidden', lifecycleStatus: PropertyLifecycleStatus.ADMIN_HIDDEN }),
      makeProperty({ id: 'no-public-revision', currentPublicRevisionId: undefined }),
    ];

    it('returns only approved, owner-visible, non-archived properties with a public revision', async () => {
      const result = await service(docs).listPublished({});
      expect(result.items.map((item: any) => item.id)).toEqual(['approved-visible']);
      expect(result.pagination.total).toBe(1);
    });

    it('never exposes draft/pending/rejected/private fields through the public projection', async () => {
      const result = await service(docs).listPublished({});
      const [item] = result.items as any[];
      expect(item).not.toHaveProperty('reviewedBy');
      expect(item).not.toHaveProperty('pendingRevisionId');
      expect(item).not.toHaveProperty('privateEvidence');
    });
  });

  describe('filter combinations', () => {
    const docs = [
      makeProperty({ id: 'sale-cairo', operationType: 'sale', governorateCode: 'cairo', city: 'القاهرة الجديدة', totalPriceMinor: 100_000_000 }),
      makeProperty({ id: 'rent-cairo', operationType: 'rent', governorateCode: 'cairo', city: 'القاهرة الجديدة', totalPriceMinor: 5_000_000 }),
      makeProperty({ id: 'sale-giza', operationType: 'sale', governorateCode: 'giza', city: 'الشيخ زايد', totalPriceMinor: 250_000_000 }),
      makeProperty({
        id: 'sale-giza-villa', operationType: 'sale', governorateCode: 'giza', city: 'الشيخ زايد',
        totalPriceMinor: 800_000_000, purposeCategoryId: CATEGORY_B, purposeSubcategoryId: SUBCATEGORY_B1,
      }),
    ];

    it('filters by operationType alone', async () => {
      const result = await service(docs).listPublished({ operationType: 'rent' });
      expect(result.items.map((item: any) => item.id)).toEqual(['rent-cairo']);
    });

    it('filters by governorateCode alone', async () => {
      const result = await service(docs).listPublished({ governorateCode: 'giza' });
      expect(result.items.map((item: any) => item.id).sort()).toEqual(['sale-giza', 'sale-giza-villa']);
    });

    it('filters by city case-insensitively', async () => {
      const result = await service(docs).listPublished({ city: 'الشيخ زايد'.toUpperCase() /* no-op for Arabic, exercises the $options:i path */ });
      expect(result.items).toHaveLength(2);
    });

    it('combines operationType + governorateCode + price range', async () => {
      const result = await service(docs).listPublished({ operationType: 'sale', governorateCode: 'giza', maxPriceMinor: 300_000_000 });
      expect(result.items.map((item: any) => item.id)).toEqual(['sale-giza']);
    });

    it('matches a keyword against title/city/district (q)', async () => {
      const result = await service(docs).listPublished({ q: 'زايد' });
      expect(result.items.map((item: any) => item.id).sort()).toEqual(['sale-giza', 'sale-giza-villa']);
    });

    it('returns an empty page (not an error) for a filter combination that matches nothing', async () => {
      const result = await service(docs).listPublished({ operationType: 'rent', governorateCode: 'giza' });
      expect(result.items).toEqual([]);
      expect(result.pagination.total).toBe(0);
    });
  });

  describe('price bounds', () => {
    it('rejects minPriceMinor greater than maxPriceMinor', async () => {
      await expect(service([]).listPublished({ minPriceMinor: 500, maxPriceMinor: 100 }))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.PRICE_RANGE_INVALID }) });
    });

    it('accepts an inclusive price range', async () => {
      const docs = [
        makeProperty({ id: 'below', totalPriceMinor: 99 }),
        makeProperty({ id: 'at-min', totalPriceMinor: 100 }),
        makeProperty({ id: 'inside', totalPriceMinor: 150 }),
        makeProperty({ id: 'at-max', totalPriceMinor: 200 }),
        makeProperty({ id: 'above', totalPriceMinor: 201 }),
      ];
      const result = await service(docs).listPublished({ minPriceMinor: 100, maxPriceMinor: 200 });
      expect(result.items.map((item: any) => item.id).sort()).toEqual(['at-max', 'at-min', 'inside']);
    });
  });

  describe('catalog relationships', () => {
    it('rejects a purposeSubcategoryId that does not exist', async () => {
      await expect(service([]).listPublished({ purposeSubcategoryId: '64b0000000000000000000ff' }))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.PURPOSE_SUBCATEGORY_INVALID }) });
    });

    it('rejects a purposeCategoryId that does not exist', async () => {
      await expect(service([]).listPublished({ purposeCategoryId: '64b0000000000000000000ff' }))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.PURPOSE_CATEGORY_INVALID }) });
    });

    it('rejects a subcategory that does not belong to the given category', async () => {
      await expect(service([]).listPublished({ purposeCategoryId: CATEGORY_A, purposeSubcategoryId: SUBCATEGORY_B1 }))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.PURPOSE_HIERARCHY_MISMATCH }) });
    });

    it('accepts a subcategory that matches the given category', async () => {
      const docs = [makeProperty({ id: 'a1', purposeCategoryId: CATEGORY_A, purposeSubcategoryId: SUBCATEGORY_A1 })];
      const result = await service(docs).listPublished({ purposeCategoryId: CATEGORY_A, purposeSubcategoryId: SUBCATEGORY_A1 });
      expect(result.items.map((item: any) => item.id)).toEqual(['a1']);
    });

    it('derives the parent category filter from a subcategory given alone', async () => {
      const docs = [
        makeProperty({ id: 'a1', purposeCategoryId: CATEGORY_A, purposeSubcategoryId: SUBCATEGORY_A1 }),
        makeProperty({ id: 'b1', purposeCategoryId: CATEGORY_B, purposeSubcategoryId: SUBCATEGORY_B1 }),
      ];
      const result = await service(docs).listPublished({ purposeSubcategoryId: SUBCATEGORY_A1 });
      expect(result.items.map((item: any) => item.id)).toEqual(['a1']);
    });
  });

  describe('sorting', () => {
    const docs = [
      makeProperty({ id: 'cheap', totalPriceMinor: 100, createdAt: new Date('2026-01-01') }),
      makeProperty({ id: 'mid', totalPriceMinor: 200, createdAt: new Date('2026-01-03') }),
      makeProperty({ id: 'expensive', totalPriceMinor: 300, createdAt: new Date('2026-01-02') }),
    ];

    it('defaults to newest first', async () => {
      const result = await service(docs).listPublished({});
      expect(result.items.map((item: any) => item.id)).toEqual(['mid', 'expensive', 'cheap']);
    });

    it('sorts by price ascending', async () => {
      const result = await service(docs).listPublished({ sort: 'price_asc' });
      expect(result.items.map((item: any) => item.id)).toEqual(['cheap', 'mid', 'expensive']);
    });

    it('sorts by price descending', async () => {
      const result = await service(docs).listPublished({ sort: 'price_desc' });
      expect(result.items.map((item: any) => item.id)).toEqual(['expensive', 'mid', 'cheap']);
    });
  });

  describe('pagination', () => {
    const docs = Array.from({ length: 25 }, (_, index) => makeProperty({
      id: `p${index}`,
      createdAt: new Date(2026, 0, index + 1),
    }));

    it('defaults to page 1 with a limit of 20', async () => {
      const result = await service(docs).listPublished({});
      expect(result.items).toHaveLength(20);
      expect(result.pagination).toMatchObject({ page: 1, limit: 20, total: 25, totalPages: 2 });
      // newest first: the last-created doc (index 24) comes first.
      expect(result.items[0].id).toBe('p24');
    });

    it('returns the remainder on page 2', async () => {
      const result = await service(docs).listPublished({ page: 2 });
      expect(result.items).toHaveLength(5);
      expect(result.pagination.page).toBe(2);
    });

    it('clamps limit to the [1, 50] bound', async () => {
      const result = await service(docs).listPublished({ limit: 500 });
      expect(result.pagination.limit).toBe(50);
    });

    it('clamps page below 1 up to 1', async () => {
      const result = await service(docs).listPublished({ page: -3 });
      expect(result.pagination.page).toBe(1);
    });
  });

  describe('invalid filters (DTO validation boundary)', () => {
    const { validate } = require('class-validator');
    const { plainToInstance } = require('class-transformer');

    const parse = (raw: Record<string, unknown>) => plainToInstance(ListPublishedPropertiesDto, raw);

    it('rejects an operationType outside sale/rent', async () => {
      const errors = await validate(parse({ operationType: 'auction' }));
      expect(errors.some((error: any) => error.property === 'operationType')).toBe(true);
    });

    it('rejects a malformed purposeCategoryId', async () => {
      const errors = await validate(parse({ purposeCategoryId: 'not-an-object-id' }));
      expect(errors.some((error: any) => error.property === 'purposeCategoryId')).toBe(true);
    });

    it('rejects a negative minPriceMinor', async () => {
      const errors = await validate(parse({ minPriceMinor: -1 }));
      expect(errors.some((error: any) => error.property === 'minPriceMinor')).toBe(true);
    });

    it('rejects an unsupported sort value', async () => {
      const errors = await validate(parse({ sort: 'most_relevant' }));
      expect(errors.some((error: any) => error.property === 'sort')).toBe(true);
    });

    it('rejects a limit above 50', async () => {
      const errors = await validate(parse({ limit: 51 }));
      expect(errors.some((error: any) => error.property === 'limit')).toBe(true);
    });

    it('accepts a fully-specified valid query', async () => {
      const errors = await validate(parse({
        page: 2, limit: 10, operationType: 'rent', purposeCategoryId: CATEGORY_A, purposeSubcategoryId: SUBCATEGORY_A1,
        governorateCode: 'cairo', city: 'القاهرة الجديدة', minPriceMinor: 0, maxPriceMinor: 1000, q: 'شقة', sort: 'price_asc',
      }));
      expect(errors).toEqual([]);
    });
  });
});

describe('MAZAD-021 approval denormalization', () => {
  const propertyId = '64b000000000000000000099';
  const revisionId = '64b000000000000000000088';
  const actorId = '64b000000000000000000002';

  function approvalHarness() {
    const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
    const property = { _id: propertyId, ownerId: actorId, advertiserAccountId: actorId, pendingRevisionId: revisionId, currentPublicRevisionId: undefined, publishedAt: undefined };
    const approvedRevision = {
      _id: revisionId, revisionNumber: 2, operationType: 'rent',
      purposeCategoryId: CATEGORY_B, purposeSubcategoryId: SUBCATEGORY_B1, legacyPropertyTypeCode: 'villa',
      governorateCode: 'giza', city: 'الشيخ زايد', district: 'الحي الأول', totalPriceMinor: 777, currency: 'EGP',
    };
    const revisions = {
      findOne: jest.fn().mockReturnValue({ session: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue({
        _id: revisionId, decisionVersion: 0, marketingMode: 'PLATFORM_MANAGED', livingRooms: 1, bedrooms: 1, kitchens: 1, bathrooms: 1,
        galleryMedia: [{ mediaId: '1f66a82e-5e20-45fc-a9f0-2fa70895ec75', tagCode: 'exterior', sortOrder: 0 }],
      }) }) }) }),
      findOneAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(approvedRevision) }),
    };
    const updateOne = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) });
    const properties = {
      findOne: jest.fn().mockReturnValue({ session: () => ({ exec: jest.fn().mockResolvedValue(property) }) }),
      updateOne,
    };
    const audit = { logRequired: jest.fn().mockResolvedValue(undefined) };
    const service = Object.create(PropertiesService.prototype) as any;
    Object.assign(service, {
      properties, revisions, audit, outbox: { recordRequired: jest.fn().mockResolvedValue(undefined) },
      connection: { startSession: jest.fn().mockResolvedValue(session) },
      getForAdmin: jest.fn().mockResolvedValue({ property: { id: propertyId } }),
    });
    return { service: service as PropertiesService, updateOne };
  }

  it('copies the approved revision search fields onto the property document', async () => {
    const { service, updateOne } = approvalHarness();
    await service.reviewForAdmin(propertyId, revisionId, 0, 'approved', undefined, actorId);
    const [, update] = updateOne.mock.calls[0];
    expect(update.$set).toMatchObject({
      operationType: 'rent',
      purposeCategoryId: CATEGORY_B,
      purposeSubcategoryId: SUBCATEGORY_B1,
      propertyTypeCode: 'villa',
      governorateCode: 'giza',
      city: 'الشيخ زايد',
      district: 'الحي الأول',
      totalPriceMinor: 777,
      currency: 'EGP',
    });
  });

  it('does not touch the search fields on rejection', async () => {
    const { service, updateOne } = approvalHarness();
    await service.reviewForAdmin(propertyId, revisionId, 0, 'rejected', 'بيانات غير مكتملة', actorId);
    const [, update] = updateOne.mock.calls[0];
    expect(update.$set).not.toHaveProperty('governorateCode');
    expect(update.$set).not.toHaveProperty('totalPriceMinor');
  });
});

/**
 * MAZAD-022 favorites reuses the exact same public-visibility gate through
 * two small read helpers on PropertiesService, rather than a parallel
 * favorites-only notion of "visible". These tests exercise those helpers
 * directly against the same fixtures/harness as the MAZAD-021 suite above.
 */
describe('PropertiesService favorite-support helpers (MAZAD-022)', () => {
  // getPublicProjectionsByIds/isPubliclyVisible short-circuit on
  // Types.ObjectId.isValid, so fixtures here need real ObjectId-hex ids
  // (unlike the string ids the MAZAD-021 suite above uses elsewhere).
  const ID_APPROVED = '64b000000000000000000101';
  const ID_APPROVED_2 = '64b000000000000000000102';
  const ID_PENDING = '64b000000000000000000103';
  const ID_OWNER_HIDDEN = '64b000000000000000000104';
  const ID_ARCHIVED = '64b000000000000000000105';
  const ID_ADMIN_HIDDEN = '64b000000000000000000106';
  const ID_NONEXISTENT = '64b0000000000000000000ff';

  const docs = [
    makeProperty({ id: ID_APPROVED }),
    makeProperty({ id: ID_APPROVED_2 }),
    makeProperty({ id: ID_PENDING, status: 'pending_review', currentPublicRevisionId: undefined }),
    makeProperty({ id: ID_OWNER_HIDDEN, isOwnerVisible: false }),
    makeProperty({ id: ID_ARCHIVED, lifecycleStatus: PropertyLifecycleStatus.ARCHIVED }),
    makeProperty({ id: ID_ADMIN_HIDDEN, lifecycleStatus: PropertyLifecycleStatus.ADMIN_HIDDEN }),
  ];

  describe('isPubliclyVisible', () => {
    it('is true only for an approved, owner-visible, non-archived property with a public revision', async () => {
      const instance = service(docs);
      await expect(instance.isPubliclyVisible(ID_APPROVED)).resolves.toBe(true);
    });

    it.each([
      ['pending', ID_PENDING], ['owner-hidden', ID_OWNER_HIDDEN], ['archived', ID_ARCHIVED], ['admin-hidden', ID_ADMIN_HIDDEN],
    ])('is false for a %s property', async (_label, id) => {
      const instance = service(docs);
      await expect(instance.isPubliclyVisible(id)).resolves.toBe(false);
    });

    it('is false for a malformed id without querying the database', async () => {
      const instance = service(docs);
      await expect(instance.isPubliclyVisible('not-an-object-id')).resolves.toBe(false);
    });

    it('is false for an id that does not exist at all', async () => {
      const instance = service(docs);
      await expect(instance.isPubliclyVisible(ID_NONEXISTENT)).resolves.toBe(false);
    });
  });

  describe('getPublicProjectionsByIds', () => {
    it('returns the safe public projection keyed by id for visible properties only', async () => {
      const instance = service(docs);
      const result = await instance.getPublicProjectionsByIds([ID_APPROVED, ID_PENDING, ID_OWNER_HIDDEN, ID_ARCHIVED, ID_ADMIN_HIDDEN]);
      expect([...result.keys()]).toEqual([ID_APPROVED]);
      const projected = result.get(ID_APPROVED);
      expect(projected).toMatchObject({ id: ID_APPROVED });
      expect(projected).not.toHaveProperty('reviewedBy');
      expect(projected).not.toHaveProperty('privateEvidence');
    });

    it('silently drops ids that are hidden/archived/unavailable instead of throwing', async () => {
      const instance = service(docs);
      await expect(instance.getPublicProjectionsByIds([ID_ARCHIVED, ID_ADMIN_HIDDEN])).resolves.toEqual(new Map());
    });

    it('returns an empty map for an empty or malformed input without querying the database', async () => {
      const instance = service(docs);
      expect((await instance.getPublicProjectionsByIds([])).size).toBe(0);
      expect((await instance.getPublicProjectionsByIds(['not-an-object-id'])).size).toBe(0);
    });

    it('only returns the requested ids, even when other properties are also publicly visible', async () => {
      const instance = service(docs);
      const result = await instance.getPublicProjectionsByIds([ID_APPROVED]);
      expect([...result.keys()]).toEqual([ID_APPROVED]);
    });

    it('de-duplicates repeated ids', async () => {
      const instance = service(docs);
      const result = await instance.getPublicProjectionsByIds([ID_APPROVED, ID_APPROVED]);
      expect(result.size).toBe(1);
    });
  });
});

/**
 * MAZAD-023 reuses the exact same public-visibility gate to decide which
 * property an auction may be anchored to, via one more small read helper on
 * PropertiesService (mirroring the MAZAD-022 favorites helpers above).
 */
describe('PropertiesService auction-anchor helper (MAZAD-023)', () => {
  const ADVERTISER = '64b000000000000000000201';
  const REVISION_ID = '64b000000000000000000301';
  const ID_APPROVED = '64b000000000000000000111';
  const ID_PENDING = '64b000000000000000000112';
  const ID_OWNER_HIDDEN = '64b000000000000000000113';
  const ID_ARCHIVED = '64b000000000000000000114';
  const ID_ADMIN_HIDDEN = '64b000000000000000000115';
  const ID_NO_ADVERTISER = '64b000000000000000000116';
  const ID_NONEXISTENT = '64b0000000000000000000fe';

  const docs = [
    makeProperty({ id: ID_APPROVED, advertiserAccountId: ADVERTISER, advertiserAccountTypeSnapshot: 'BROKER', currentPublicRevisionId: REVISION_ID }),
    makeProperty({ id: ID_PENDING, status: 'pending_review', currentPublicRevisionId: undefined, advertiserAccountId: ADVERTISER }),
    makeProperty({ id: ID_OWNER_HIDDEN, isOwnerVisible: false, advertiserAccountId: ADVERTISER, currentPublicRevisionId: REVISION_ID }),
    makeProperty({ id: ID_ARCHIVED, lifecycleStatus: PropertyLifecycleStatus.ARCHIVED, advertiserAccountId: ADVERTISER, currentPublicRevisionId: REVISION_ID }),
    makeProperty({ id: ID_ADMIN_HIDDEN, lifecycleStatus: PropertyLifecycleStatus.ADMIN_HIDDEN, advertiserAccountId: ADVERTISER, currentPublicRevisionId: REVISION_ID }),
    makeProperty({ id: ID_NO_ADVERTISER, currentPublicRevisionId: REVISION_ID }), // neither advertiserAccountId nor legacy ownerId set
  ];

  it('returns the attribution + current revision anchor for an eligible property', async () => {
    const instance = service(docs);
    await expect(instance.getEligibleForAuctionAnchor(ID_APPROVED)).resolves.toMatchObject({
      propertyId: ID_APPROVED,
      advertiserAccountId: ADVERTISER,
      advertiserAccountTypeSnapshot: 'BROKER',
      currentPublicRevisionId: REVISION_ID,
    });
  });

  it.each([
    ['pending review', ID_PENDING], ['owner-hidden', ID_OWNER_HIDDEN], ['archived', ID_ARCHIVED], ['admin-hidden', ID_ADMIN_HIDDEN],
  ])('returns null for a %s property, just like isPubliclyVisible (an auction can never be anchored to it)', async (_label, id) => {
    const instance = service(docs);
    await expect(instance.getEligibleForAuctionAnchor(id)).resolves.toBeNull();
  });

  it('returns null for a malformed id without querying the database', async () => {
    const instance = service(docs);
    await expect(instance.getEligibleForAuctionAnchor('not-an-object-id')).resolves.toBeNull();
  });

  it('returns null for an id that does not exist at all', async () => {
    const instance = service(docs);
    await expect(instance.getEligibleForAuctionAnchor(ID_NONEXISTENT)).resolves.toBeNull();
  });

  it('returns null instead of throwing when neither advertiserAccountId nor legacy ownerId is present', async () => {
    const instance = service(docs);
    await expect(instance.getEligibleForAuctionAnchor(ID_NO_ADVERTISER)).resolves.toBeNull();
  });

  it('falls back to the legacy ownerId when advertiserAccountId is absent', async () => {
    const instance = service([
      makeProperty({ id: ID_APPROVED, ownerId: ADVERTISER, advertiserAccountId: undefined, currentPublicRevisionId: REVISION_ID }),
    ]);
    await expect(instance.getEligibleForAuctionAnchor(ID_APPROVED)).resolves.toMatchObject({ advertiserAccountId: ADVERTISER });
  });

  it('defaults advertiserAccountTypeSnapshot to USER when the property predates that field', async () => {
    const instance = service([
      makeProperty({ id: ID_APPROVED, advertiserAccountId: ADVERTISER, advertiserAccountTypeSnapshot: undefined, currentPublicRevisionId: REVISION_ID }),
    ]);
    await expect(instance.getEligibleForAuctionAnchor(ID_APPROVED)).resolves.toMatchObject({ advertiserAccountTypeSnapshot: 'USER' });
  });
});
