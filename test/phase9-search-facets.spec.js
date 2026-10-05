'use strict';

const { validate } = require('class-validator');
const { plainToInstance } = require('class-transformer');
const { PropertiesService } = require('../src/services/properties.service');
const { PropertyErrorCode } = require('../src/common/errors/property-error-codes');
const {
  ListPublishedPropertiesDto,
} = require('../src/validators/properties/list-published-properties.dto');
const { PHASE9_PROMOTED_FACET_KEYS } = require('../src/migrations/030-phase9-facet-promotion');
const { PHASE9_FACET_METADATA } = require('../src/domain/properties/property-search-facets');
/**
 * Phase 9 (Search & Facets): the public `GET /properties` facet query
 * parameters, `buildPublicListingQuery`'s facet predicates, the
 * `GET /properties/filter-metadata` contract, and a regression proof that
 * these new parameters never reach auction discovery.
 *
 * `fakeCollection` mirrors the same tiny in-memory Mongoose-query-chain stand-in
 * `test/property-search.spec.js` uses, extended with dotted-path resolution
 * (`facets.shopFloorLevel`) since real MongoDB treats a dotted filter key as
 * nested-field access.
 */
function getPath(doc, path) {
  return path
    .split('.')
    .reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), doc);
}
function matchesCondition(value, condition) {
  if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
    return Object.entries(condition).every(([op, opValue]) => {
      switch (op) {
        case '$exists':
          return (value !== undefined) === opValue;
        case '$ne':
          return value !== opValue;
        case '$nin':
          return !opValue.includes(value);
        case '$in':
          return Array.isArray(value)
            ? value.some((item) => opValue.includes(item))
            : opValue.includes(value);
        case '$gte':
          return value !== undefined && value >= opValue;
        case '$lte':
          return value !== undefined && value <= opValue;
        case '$regex':
          return new RegExp(opValue, condition.$options ?? '').test(String(value ?? ''));
        case '$options':
          return true;
        default:
          return true;
      }
    });
  }
  if (Array.isArray(value)) return value.some((element) => element === condition);
  return value === condition;
}
function matchesFilter(doc, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') return condition.some((sub) => matchesFilter(doc, sub));
    return matchesCondition(getPath(doc, key), condition);
  });
}
function fakeCollection(docs) {
  return {
    findOne: jest.fn((filter = {}) => {
      const result = docs.find((doc) => matchesFilter(doc, filter)) ?? null;
      return {
        populate: () => ({ lean: () => ({ exec: async () => result }) }),
        lean: () => ({ exec: async () => result }),
      };
    }),
    findById: jest.fn((id) => ({
      lean: () => ({
        exec: async () => docs.find((doc) => String(doc._id) === String(id)) ?? null,
      }),
    })),
    find: jest.fn((filter = {}) => {
      let results = docs.filter((doc) => matchesFilter(doc, filter));
      const chain = {
        sort: (spec) => {
          const entries = Object.entries(spec);
          results = [...results].sort((a, b) => {
            for (const [field, dir] of entries) {
              const [av, bv] = [a[field], b[field]];
              if (av === bv) continue;
              return av > bv ? dir : -dir;
            }
            return 0;
          });
          return chain;
        },
        skip: (n) => {
          results = results.slice(n);
          return chain;
        },
        limit: (n) => {
          results = results.slice(0, n);
          return chain;
        },
        populate: () => chain,
        lean: () => chain,
        exec: async () => results,
      };
      return chain;
    }),
    countDocuments: jest.fn((filter = {}) => ({
      exec: async () => docs.filter((doc) => matchesFilter(doc, filter)).length,
    })),
    exists: jest.fn((filter = {}) => ({
      exec: async () => (docs.some((doc) => matchesFilter(doc, filter)) ? { _id: 'x' } : null),
    })),
  };
}
const emptyLookup = {
  find: jest.fn().mockReturnValue({ lean: () => ({ exec: jest.fn().mockResolvedValue([]) }) }),
};
const SHOP_TYPE_ID = '64c900000000000000000001';
const FACTORY_TYPE_ID = '64c900000000000000000002';
const AGRI_TYPE_ID = '64c900000000000000000003';
const RESIDENTIAL_TYPE_ID = '64c900000000000000000004';
function makeProperty(overrides = {}) {
  const id = overrides.id ?? overrides._id ?? 'p1';
  return {
    _id: id,
    operationType: 'sale',
    propertyTypeCode: 'shop',
    purposeSubcategoryIds: [SHOP_TYPE_ID],
    title: 'محل للبيع',
    description: 'وصف العقار',
    governorateCode: 'cairo',
    city: 'القاهرة',
    district: 'وسط البلد',
    area: 80,
    totalPriceMinor: 100_000_000,
    currency: 'EGP',
    images: [],
    coverImageIndex: 0,
    isOwnerVisible: true,
    status: 'approved',
    lifecycleStatus: 'active',
    lifecycleVersion: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    currentPublicRevisionId: {
      _id: `${id}-rev`,
      revisionNumber: 1,
      title: 'محل للبيع',
      description: 'وصف العقار',
      moderationStatus: 'approved',
      decisionVersion: 0,
      coverImageIndex: 0,
      galleryMedia: [],
      paymentMethodCodes: [],
    },
    ...overrides,
  };
}
function service(docs) {
  const instance = Object.create(PropertiesService.prototype);
  Object.assign(instance, {
    properties: fakeCollection(docs),
    governorates: emptyLookup,
    propertyTypes: {
      ...emptyLookup,
      findById: jest.fn((id) => ({
        lean: () => ({
          exec: jest
            .fn()
            .mockResolvedValue(
              id === SHOP_TYPE_ID
                ? { _id: SHOP_TYPE_ID, code: 'shop' }
                : id === FACTORY_TYPE_ID
                  ? { _id: FACTORY_TYPE_ID, code: 'factory' }
                  : id === AGRI_TYPE_ID
                    ? { _id: AGRI_TYPE_ID, code: 'agricultural_land' }
                    : id === RESIDENTIAL_TYPE_ID
                      ? { _id: RESIDENTIAL_TYPE_ID, code: 'apartment' }
                      : null,
            ),
        }),
      })),
    },
    purposeCategories: emptyLookup,
    options: emptyLookup,
    amenities: emptyLookup,
  });
  return instance;
}
describe('Phase 9 public search DTO validation', () => {
  const parse = (raw) => plainToInstance(ListPublishedPropertiesDto, raw);
  it('accepts each approved exact-match facet value', async () => {
    for (const [key, value] of [
      ['shopFloorLevel', 'ground'],
      ['powerSource', 'grid'],
      ['industrialUseType', 'heavy'],
      ['soilType', 'clay'],
      ['waterSource', 'well'],
    ]) {
      const errors = await validate(parse({ [key]: value }));
      expect(errors).toEqual([]);
    }
  });
  it('rejects an exact-match facet value outside its approved option codes', async () => {
    const errors = await validate(parse({ shopFloorLevel: 'penthouse' }));
    expect(errors.some((error) => error.property === 'shopFloorLevel')).toBe(true);
  });
  it('normalizes a single commercialUseTypes value into a one-element array', async () => {
    const dto = parse({ commercialUseTypes: 'retail' });
    expect(dto.commercialUseTypes).toEqual(['retail']);
    expect(await validate(dto)).toEqual([]);
  });
  it('accepts repeated commercialUseTypes values and deduplicates them', async () => {
    const dto = parse({ commercialUseTypes: ['retail', 'retail', 'food'] });
    expect(dto.commercialUseTypes).toEqual(['retail', 'food']);
    expect(await validate(dto)).toEqual([]);
  });
  it('rejects a commercialUseTypes entry outside the approved option codes', async () => {
    const errors = await validate(parse({ commercialUseTypes: ['not-a-real-code'] }));
    expect(errors.some((error) => error.property === 'commercialUseTypes')).toBe(true);
  });
  it('accepts a builtAreaSqm range and rejects a negative value', async () => {
    expect(await validate(parse({ minBuiltAreaSqm: 100, maxBuiltAreaSqm: 500 }))).toEqual([]);
    const errors = await validate(parse({ minBuiltAreaSqm: -1 }));
    expect(errors.some((error) => error.property === 'minBuiltAreaSqm')).toBe(true);
  });
});
describe('Phase 9 public search: presentation-only attributes never affect query results', () => {
  it('a presentation-only field sent alongside a real facet has no effect on the query builder', async () => {
    // buildPublicListingQuery only ever reads the 8 declared facet keys off the
    // query object; extra properties (however named) are simply never consulted.
    const instance = service([]);
    const built = await instance.buildPublicListingQuery({
      shopFloorLevel: 'ground',
      frontageWidthM: 999,
      hasStorefront: true,
    });
    expect(built.filter).toEqual({ 'facets.shopFloorLevel': 'ground' });
  });
});
describe('Phase 9 public search: facet predicates via listPublished', () => {
  const docs = [
    makeProperty({
      id: 'shop-ground-retail',
      purposeSubcategoryIds: [SHOP_TYPE_ID],
      facets: { shopFloorLevel: 'ground', commercialUseTypes: ['retail'] },
      totalPriceMinor: 100,
      governorateCode: 'cairo',
    }),
    makeProperty({
      id: 'shop-upper-food',
      purposeSubcategoryIds: [SHOP_TYPE_ID],
      facets: { shopFloorLevel: 'upper', commercialUseTypes: ['food'] },
      totalPriceMinor: 200,
      governorateCode: 'giza',
    }),
    makeProperty({
      id: 'shop-ground-food-pharmacy',
      purposeSubcategoryIds: [SHOP_TYPE_ID],
      facets: { shopFloorLevel: 'ground', commercialUseTypes: ['food', 'pharmacy'] },
      totalPriceMinor: 300,
      governorateCode: 'cairo',
    }),
    makeProperty({
      id: 'factory-small-grid',
      purposeSubcategoryIds: [FACTORY_TYPE_ID],
      facets: { builtAreaSqm: 500, powerSource: 'grid', industrialUseType: 'light' },
      totalPriceMinor: 400,
    }),
    makeProperty({
      id: 'factory-large-generator',
      purposeSubcategoryIds: [FACTORY_TYPE_ID],
      facets: { builtAreaSqm: 5000, powerSource: 'generator', industrialUseType: 'heavy' },
      totalPriceMinor: 900,
    }),
    makeProperty({
      id: 'agri-clay-well',
      purposeSubcategoryIds: [AGRI_TYPE_ID],
      facets: { soilType: 'clay', waterSource: 'well' },
      totalPriceMinor: 150,
    }),
    makeProperty({
      id: 'residential-no-facets',
      purposeSubcategoryIds: [RESIDENTIAL_TYPE_ID],
      facets: { bedrooms: 3 },
      totalPriceMinor: 250,
    }),
  ];
  it('filters by an exact-match facet (shopFloorLevel)', async () => {
    const result = await service(docs).listPublished({ shopFloorLevel: 'ground' });
    expect(result.items.map((item) => item.id).sort()).toEqual([
      'shop-ground-food-pharmacy',
      'shop-ground-retail',
    ]);
  });
  it('filters commercialUseTypes with OR semantics (any of the given values)', async () => {
    const result = await service(docs).listPublished({ commercialUseTypes: ['retail', 'food'] });
    expect(result.items.map((item) => item.id).sort()).toEqual([
      'shop-ground-food-pharmacy',
      'shop-ground-retail',
      'shop-upper-food',
    ]);
  });
  it('AND semantics across two different facet fields', async () => {
    const result = await service(docs).listPublished({
      shopFloorLevel: 'ground',
      commercialUseTypes: ['retail'],
    });
    expect(result.items.map((item) => item.id)).toEqual(['shop-ground-retail']);
  });
  it('filters builtAreaSqm by minimum only', async () => {
    const result = await service(docs).listPublished({ minBuiltAreaSqm: 1000 });
    expect(result.items.map((item) => item.id)).toEqual(['factory-large-generator']);
  });
  it('filters builtAreaSqm by maximum only', async () => {
    const result = await service(docs).listPublished({ maxBuiltAreaSqm: 1000 });
    expect(result.items.map((item) => item.id)).toEqual(['factory-small-grid']);
  });
  it('filters builtAreaSqm by a full range', async () => {
    const result = await service(docs).listPublished({
      minBuiltAreaSqm: 100,
      maxBuiltAreaSqm: 600,
    });
    expect(result.items.map((item) => item.id)).toEqual(['factory-small-grid']);
  });
  it('rejects an inverted builtAreaSqm range', async () => {
    await expect(
      service(docs).listPublished({ minBuiltAreaSqm: 600, maxBuiltAreaSqm: 100 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: PropertyErrorCode.FACET_RANGE_INVALID }),
    });
  });
  it('combines a facet with price', async () => {
    const result = await service(docs).listPublished({
      industrialUseType: 'heavy',
      maxPriceMinor: 1000,
    });
    expect(result.items.map((item) => item.id)).toEqual(['factory-large-generator']);
  });
  it('combines a facet with governorate', async () => {
    const result = await service(docs).listPublished({
      shopFloorLevel: 'ground',
      governorateCode: 'cairo',
    });
    expect(result.items.map((item) => item.id).sort()).toEqual([
      'shop-ground-food-pharmacy',
      'shop-ground-retail',
    ]);
  });
  it('combines a facet with a property-type filter', async () => {
    const result = await service(docs).listPublished({
      purposeSubcategoryId: FACTORY_TYPE_ID,
      powerSource: 'grid',
    });
    expect(result.items.map((item) => item.id)).toEqual(['factory-small-grid']);
  });
  it('a facet irrelevant to the resolved type naturally returns zero rows, not an error', async () => {
    const result = await service(docs).listPublished({
      purposeSubcategoryId: FACTORY_TYPE_ID,
      soilType: 'clay',
    });
    expect(result.items).toEqual([]);
  });
  it('exact facets on soilType/waterSource work for agricultural_land', async () => {
    const result = await service(docs).listPublished({ soilType: 'clay', waterSource: 'well' });
    expect(result.items.map((item) => item.id)).toEqual(['agri-clay-well']);
  });
  it('pagination and sort still work when a facet filter is present', async () => {
    const result = await service(docs).listPublished({
      commercialUseTypes: ['retail', 'food'],
      sort: 'price_asc',
      limit: 2,
    });
    expect(result.items.map((item) => item.id)).toEqual(['shop-ground-retail', 'shop-upper-food']);
    expect(result.pagination).toMatchObject({ limit: 2, total: 3 });
  });
  it('never returns duplicate rows for a multi-value facet match', async () => {
    const result = await service(docs).listPublished({ commercialUseTypes: ['food', 'pharmacy'] });
    const ids = result.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['shop-ground-food-pharmacy', 'shop-upper-food']);
  });
  it('a query with no facet parameters at all behaves exactly as before (legacy compatibility)', async () => {
    const result = await service(docs).listPublished({});
    expect(result.items).toHaveLength(docs.length);
  });
});
describe('Phase 9 filter-metadata endpoint (GET /properties/filter-metadata)', () => {
  it('returns exactly shopFloorLevel and commercialUseTypes for shop, in the fixed order', async () => {
    const result = await service([]).getFilterMetadata({ purposeSubcategoryId: SHOP_TYPE_ID });
    expect(result.facets.map((facet) => facet.key)).toEqual([
      'shopFloorLevel',
      'commercialUseTypes',
    ]);
    expect(result.facets.find((facet) => facet.key === 'commercialUseTypes').filterKind).toBe(
      'multi',
    );
    expect(result.facets.find((facet) => facet.key === 'shopFloorLevel').filterKind).toBe('exact');
  });
  it('returns exactly builtAreaSqm, powerSource, industrialUseType for factory, in the fixed order', async () => {
    const result = await service([]).getFilterMetadata({ purposeSubcategoryId: FACTORY_TYPE_ID });
    expect(result.facets.map((facet) => facet.key)).toEqual([
      'builtAreaSqm',
      'powerSource',
      'industrialUseType',
    ]);
    expect(result.facets.find((facet) => facet.key === 'builtAreaSqm').filterKind).toBe('range');
  });
  it('returns exactly soilType, waterSource for agricultural_land, in the fixed order', async () => {
    const result = await service([]).getFilterMetadata({ purposeSubcategoryId: AGRI_TYPE_ID });
    expect(result.facets.map((facet) => facet.key)).toEqual(['soilType', 'waterSource']);
  });
  it('returns no Phase 9 promoted facets for a residential type', async () => {
    const result = await service([]).getFilterMetadata({
      purposeSubcategoryId: RESIDENTIAL_TYPE_ID,
    });
    expect(result.facets).toEqual([]);
  });
  it('returns an empty list when no type is given at all', async () => {
    const result = await service([]).getFilterMetadata({});
    expect(result.facets).toEqual([]);
  });
  it('follows the existing public-catalog error convention for an unknown type', async () => {
    await expect(
      service([]).getFilterMetadata({ purposeSubcategoryId: '64c900000000000000009999' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: PropertyErrorCode.PURPOSE_SUBCATEGORY_INVALID }),
    });
  });
  it('includes option codes and human labels (never raw codes as labels) for select/multi facets', async () => {
    const result = await service([]).getFilterMetadata({ purposeSubcategoryId: SHOP_TYPE_ID });
    const shopFloorLevel = result.facets.find((facet) => facet.key === 'shopFloorLevel');
    expect(shopFloorLevel.options?.map((option) => option.code)).toEqual([
      'ground',
      'basement',
      'mezzanine',
      'upper',
    ]);
    for (const option of shopFloorLevel.options ?? []) {
      expect(option.labelAr).not.toBe(option.code);
      expect(option.labelEn).not.toBe(option.code);
    }
  });
  it('exposes exactly the 7 approved promoted keys across the whole metadata catalog, matching the migration', () => {
    expect(PHASE9_FACET_METADATA.map((facet) => facet.key).sort()).toEqual(
      [...PHASE9_PROMOTED_FACET_KEYS].sort(),
    );
  });
});
