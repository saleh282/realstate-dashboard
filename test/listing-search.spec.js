'use strict';

const {
  parseListingQuery,
  listingFilter,
  listingSearchPipeline,
} = require('../src/domain/listings/listing-search');

const parsed = (query) => parseListingQuery(query).value;
const refused = (query) => Object.keys(parseListingQuery(query).errors).sort();

describe('reading a listings search', () => {
  it('defaults to the newest first, twenty to a page', () => {
    expect(parsed({})).toEqual({ sort: 'newest', page: 1, limit: 20 });
    expect(parsed(undefined)).toEqual({ sort: 'newest', page: 1, limit: 20 });
  });
  it('reads every filter the app offers', () => {
    expect(
      parsed({
        category: 'residential',
        purpose: 'rent',
        subtype: 'apartment',
        region: ' القاهرة ',
        minPrice: '5000',
        maxPrice: '20000',
        minArea: '80',
        maxArea: '200',
        bedrooms: '3',
        minBathrooms: '2',
        rentPeriod: 'monthly',
        furnished: 'true',
        verifiedOnly: 'true',
        q: 'مدينة نصر',
        sort: 'price_asc',
        page: '3',
        limit: '50',
      }),
    ).toEqual({
      category: 'residential',
      purpose: 'rent',
      subtype: 'apartment',
      region: 'القاهرة',
      minPrice: 5000,
      maxPrice: 20000,
      minArea: 80,
      maxArea: 200,
      bedrooms: 3,
      minBathrooms: 2,
      rentPeriod: 'monthly',
      furnished: true,
      verifiedOnly: true,
      q: 'مدينة نصر',
      sort: 'price_asc',
      page: 3,
      limit: 50,
    });
  });
  it('refuses what it cannot understand instead of ignoring it', () => {
    expect(refused({ category: 'boats' })).toEqual(['category']);
    expect(refused({ category: 'land', subtype: 'apartment' })).toEqual(['subtype']);
    expect(refused({ minPrice: '-1' })).toEqual(['minPrice']);
    expect(refused({ minPrice: '1e9' })).toEqual(['minPrice']);
    expect(refused({ minPrice: '900', maxPrice: '100' })).toEqual(['maxPrice']);
    expect(refused({ furnished: 'yes' })).toEqual(['furnished']);
    expect(refused({ limit: '51' })).toEqual(['limit']);
    expect(refused({ page: '0' })).toEqual(['page']);
    expect(refused({ sort: 'cheapest' })).toEqual(['sort']);
    expect(refused({ q: 'x'.repeat(101) })).toEqual(['q']);
    // A repeated or nested parameter arrives as an array or object.
    expect(refused({ category: ['land', 'residential'] })).toEqual(['category']);
    expect(refused({ minPrice: { $gt: '' } })).toEqual(['minPrice']);
  });
  it('accepts a subtype without a category', () => {
    expect(parsed({ subtype: 'villa' }).subtype).toBe('villa');
  });
  it('reads a point and a map box, and needs the point to sort by distance', () => {
    expect(parsed({ near: '30.05,31.33', sort: 'nearest' }).near).toEqual([30.05, 31.33]);
    expect(refused({ sort: 'nearest' })).toEqual(['near']);
    expect(refused({ near: '30.05' })).toEqual(['near']);
    expect(refused({ near: '95,31' })).toEqual(['near']);
    expect(refused({ near: 'a,b' })).toEqual(['near']);
    expect(parsed({ bbox: '29.5,30.5,30.5,32' }).bbox).toEqual([29.5, 30.5, 30.5, 32]);
    // south must be below north, west before east.
    expect(refused({ bbox: '31,30,29,32' })).toEqual(['bbox']);
    expect(refused({ bbox: '29,30,31' })).toEqual(['bbox']);
    expect(refused({ bbox: '29,,31,32' })).toEqual(['bbox']);
  });
});

describe('the filter of a search', () => {
  it('only ever matches published listings', () => {
    expect(listingFilter(parsed({}))).toEqual({ status: 'published' });
    expect(listingFilter({ ...parsed({}), status: 'draft' }).status).toBe('published');
  });
  it('turns the ranges into bounds on the stored fields', () => {
    expect(
      listingFilter(
        parsed({
          minPrice: '100',
          maxArea: '300',
          minInstallment: '5000',
          maxInstallment: '9000',
          maxRemainingYears: '4',
          region: 'الجيزة',
        }),
      ),
    ).toEqual({
      status: 'published',
      governorate: 'الجيزة',
      price: { $gte: 100 },
      areaSqm: { $lte: 300 },
      'transfer.monthlyInstallment': { $gte: 5000, $lte: 9000 },
      'transfer.remainingYears': { $lte: 4 },
    });
  });
  it('matches rooms exactly, or at least that many', () => {
    expect(listingFilter(parsed({ bedrooms: '2' })).bedrooms).toBe(2);
    expect(listingFilter(parsed({ minBedrooms: '4' })).bedrooms).toEqual({ $gte: 4 });
    expect(listingFilter(parsed({ bathrooms: '1', minBathrooms: '3' })).bathrooms).toBe(1);
    expect(listingFilter(parsed({ furnished: 'false' })).furnished).toBe(false);
  });
  it('searches the text literally in the titles and the place names', () => {
    const { $or } = listingFilter(parsed({ q: 'شقة (فاخرة).*' }));
    expect($or.map((clause) => Object.keys(clause)[0])).toEqual([
      'titleAr',
      'titleEn',
      'district',
      'city',
      'governorate',
    ]);
    expect($or[0].titleAr).toEqual({ $regex: 'شقة \\(فاخرة\\)\\.\\*', $options: 'i' });
  });
  it('keeps to the box of the map, as [longitude, latitude] corners', () => {
    expect(listingFilter(parsed({ bbox: '29.5,30.5,30.5,32' })).location).toEqual({
      $geoWithin: {
        $box: [
          [30.5, 29.5],
          [32, 30.5],
        ],
      },
    });
  });
});

describe('the search pipeline', () => {
  const stages = (query) =>
    listingSearchPipeline(parsed(query)).map((stage) => Object.keys(stage)[0]);
  const facet = (query) => listingSearchPipeline(parsed(query)).at(-1).$facet;

  it('matches, sorts, then pages and counts in one go', () => {
    const pipeline = listingSearchPipeline(parsed({ category: 'land', page: '3', limit: '10' }));
    expect(pipeline[0]).toEqual({ $match: { status: 'published', category: 'land' } });
    expect(pipeline[1]).toEqual({ $sort: { publishedAt: -1, _id: -1 } });
    expect(pipeline[2].$facet.total).toEqual([{ $count: 'count' }]);
    expect(pipeline[2].$facet.items.slice(0, 2)).toEqual([{ $skip: 20 }, { $limit: 10 }]);
  });
  it.each([
    ['price_asc', { price: 1, _id: -1 }],
    ['price_desc', { price: -1, _id: -1 }],
    ['area_desc', { areaSqm: -1, _id: -1 }],
  ])('sorts by %s', (sort, expected) => {
    expect(listingSearchPipeline(parsed({ sort }))[1]).toEqual({ $sort: expected });
  });
  it('sorts by distance with $geoNear first, carrying the filter', () => {
    const pipeline = listingSearchPipeline(
      parsed({ sort: 'nearest', near: '30.05,31.33', purpose: 'sale' }),
    );
    expect(pipeline[0]).toEqual({
      $geoNear: {
        near: { type: 'Point', coordinates: [31.33, 30.05] },
        distanceField: 'distanceMeters',
        spherical: true,
        query: { status: 'published', purpose: 'sale' },
      },
    });
    expect(stages({ sort: 'nearest', near: '30.05,31.33' })).toEqual(['$geoNear', '$facet']);
  });
  it('looks the owners up only for the page it returns', () => {
    expect(stages({})).toEqual(['$match', '$sort', '$facet']);
    expect(facet({}).items.map((stage) => Object.keys(stage)[0])).toEqual([
      '$skip',
      '$limit',
      '$lookup',
      '$set',
    ]);
  });
  it('filters on verified owners before it counts', () => {
    expect(stages({ verifiedOnly: 'true' })).toEqual([
      '$match',
      '$sort',
      '$lookup',
      '$set',
      '$match',
      '$facet',
    ]);
    expect(listingSearchPipeline(parsed({ verifiedOnly: 'true' }))[4]).toEqual({
      $match: { 'owner.verificationTrustState': 'VERIFIED' },
    });
    expect(facet({ verifiedOnly: 'true' }).items).toHaveLength(2);
  });
});
