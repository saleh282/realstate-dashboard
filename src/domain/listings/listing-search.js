'use strict';

const {
  ListingCategory,
  ListingPurpose,
  ListingStatus,
  SUBTYPES,
  RENT_PERIODS,
} = require('./listing.types');

const ListingSort = Object.freeze({
  NEWEST: 'newest',
  PRICE_LOW: 'price_asc',
  PRICE_HIGH: 'price_desc',
  LARGEST: 'area_desc',
  NEAREST: 'nearest',
});

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_MAP_POINTS = 300;
const ALL_SUBTYPES = [...new Set(Object.values(SUBTYPES).flat())];

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reads the search of a listings request from its query string.
 *
 * Returns `{ value, errors }`; `errors` names each parameter that could not be
 * understood, so a mistyped filter is refused instead of silently ignored.
 */
function parseListingQuery(query = {}) {
  const value = {};
  const errors = {};
  const raw = (name) => {
    const item = query[name];
    return typeof item === 'string' && item.trim() !== '' ? item.trim() : undefined;
  };
  for (const [name, item] of Object.entries(query)) {
    if (item !== undefined && typeof item !== 'string') errors[name] = 'قيمة غير صحيحة';
  }
  const oneOf = (name, allowed) => {
    const item = raw(name);
    if (item === undefined) return;
    if (allowed.includes(item)) value[name] = item;
    else errors[name] = 'قيمة غير صحيحة';
  };
  const whole = (name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const item = raw(name);
    if (item === undefined) return;
    const parsed = /^\d{1,15}$/.test(item) ? Number(item) : NaN;
    if (Number.isSafeInteger(parsed) && parsed >= min && parsed <= max) value[name] = parsed;
    else errors[name] = 'رقم غير صحيح';
  };
  const bool = (name) => {
    const item = raw(name);
    if (item === undefined) return;
    if (item === 'true' || item === 'false') value[name] = item === 'true';
    else errors[name] = 'قيمة غير صحيحة';
  };
  const range = (min, max) => {
    whole(min);
    whole(max);
    if (value[min] !== undefined && value[max] !== undefined && value[min] > value[max]) {
      errors[max] = 'الحد الأقصى أقل من الحد الأدنى';
    }
  };
  /** "a,b" as two finite numbers within the given bounds. */
  const numbers = (name, count, check) => {
    const item = raw(name);
    if (item === undefined) return;
    const parts = item.split(',').map((part) => (part.trim() === '' ? NaN : Number(part)));
    if (parts.length === count && parts.every(Number.isFinite) && check(parts)) value[name] = parts;
    else errors[name] = 'إحداثيات غير صحيحة';
  };
  const validPoint = (latitude, longitude) =>
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

  oneOf('category', Object.values(ListingCategory));
  oneOf('purpose', Object.values(ListingPurpose));
  oneOf('subtype', value.category ? SUBTYPES[value.category] : ALL_SUBTYPES);
  oneOf('rentPeriod', RENT_PERIODS);
  bool('furnished');
  bool('verifiedOnly');
  range('minPrice', 'maxPrice');
  range('minArea', 'maxArea');
  range('minInstallment', 'maxInstallment');
  range('minRemainingYears', 'maxRemainingYears');
  // An exact number of rooms, or at least that many.
  whole('bedrooms', { max: 50 });
  whole('minBedrooms', { max: 50 });
  whole('bathrooms', { max: 50 });
  whole('minBathrooms', { max: 50 });

  const region = raw('region');
  if (region !== undefined) {
    if (region.length <= 80) value.region = region;
    else errors.region = 'قيمة غير صحيحة';
  }
  const text = raw('q');
  if (text !== undefined) {
    if (text.length <= 100) value.q = text;
    else errors.q = 'نص البحث طويل جداً';
  }

  // near=latitude,longitude
  numbers('near', 2, ([latitude, longitude]) => validPoint(latitude, longitude));
  // bbox=south,west,north,east
  numbers(
    'bbox',
    4,
    ([south, west, north, east]) =>
      validPoint(south, west) && validPoint(north, east) && south < north && west < east,
  );

  oneOf('sort', Object.values(ListingSort));
  value.sort ??= ListingSort.NEWEST;
  if (value.sort === ListingSort.NEAREST && !value.near && !errors.near) {
    errors.near = 'الترتيب بالأقرب يحتاج موقعك';
  }

  whole('page', { min: 1, max: 10000 });
  whole('limit', { min: 1, max: MAX_LIMIT });
  value.page ??= 1;
  value.limit ??= DEFAULT_LIMIT;

  return { value, errors };
}

/** The Mongo filter of a search, over published listings only. */
function listingFilter(search) {
  const filter = { status: ListingStatus.PUBLISHED };
  for (const field of ['category', 'purpose', 'subtype', 'rentPeriod', 'furnished']) {
    if (search[field] !== undefined) filter[field] = search[field];
  }
  if (search.region !== undefined) filter.governorate = search.region;

  const between = (field, min, max) => {
    if (min === undefined && max === undefined) return;
    filter[field] = {
      ...(min !== undefined ? { $gte: min } : {}),
      ...(max !== undefined ? { $lte: max } : {}),
    };
  };
  between('price', search.minPrice, search.maxPrice);
  between('areaSqm', search.minArea, search.maxArea);
  between('transfer.monthlyInstallment', search.minInstallment, search.maxInstallment);
  between('transfer.remainingYears', search.minRemainingYears, search.maxRemainingYears);

  if (search.bedrooms !== undefined) filter.bedrooms = search.bedrooms;
  else if (search.minBedrooms !== undefined) filter.bedrooms = { $gte: search.minBedrooms };
  if (search.bathrooms !== undefined) filter.bathrooms = search.bathrooms;
  else if (search.minBathrooms !== undefined) filter.bathrooms = { $gte: search.minBathrooms };

  if (search.q !== undefined) {
    const pattern = { $regex: escapeRegex(search.q), $options: 'i' };
    filter.$or = ['titleAr', 'titleEn', 'district', 'city', 'governorate'].map((field) => ({
      [field]: pattern,
    }));
  }
  if (search.bbox !== undefined) {
    const [south, west, north, east] = search.bbox;
    filter.location = {
      $geoWithin: {
        $box: [
          [west, south],
          [east, north],
        ],
      },
    };
  }
  return filter;
}

const SORTS = {
  [ListingSort.NEWEST]: { publishedAt: -1, _id: -1 },
  [ListingSort.PRICE_LOW]: { price: 1, _id: -1 },
  [ListingSort.PRICE_HIGH]: { price: -1, _id: -1 },
  [ListingSort.LARGEST]: { areaSqm: -1, _id: -1 },
};

/**
 * The aggregation of a search: the matching listings with their owner as
 * `owner`, and a `total` beside the requested page.
 */
function listingSearchPipeline(search) {
  const filter = listingFilter(search);
  const pipeline = [];
  if (search.sort === ListingSort.NEAREST) {
    const [latitude, longitude] = search.near;
    // $geoNear must come first and returns the nearest first.
    pipeline.push({
      $geoNear: {
        near: { type: 'Point', coordinates: [longitude, latitude] },
        distanceField: 'distanceMeters',
        spherical: true,
        query: filter,
      },
    });
  } else {
    pipeline.push({ $match: filter }, { $sort: SORTS[search.sort] });
  }
  const withOwner = [
    { $lookup: { from: 'users', localField: 'ownerId', foreignField: '_id', as: 'owner' } },
    { $set: { owner: { $first: '$owner' } } },
  ];
  // The owner is only needed before paging when the search filters on them.
  if (search.verifiedOnly) {
    pipeline.push(...withOwner, { $match: { 'owner.verificationTrustState': 'VERIFIED' } });
  }
  pipeline.push({
    $facet: {
      total: [{ $count: 'count' }],
      items: [
        { $skip: (search.page - 1) * search.limit },
        { $limit: search.limit },
        ...(search.verifiedOnly ? [] : withOwner),
      ],
    },
  });
  return pipeline;
}

module.exports = {
  ListingSort,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_MAP_POINTS,
  parseListingQuery,
  listingFilter,
  listingSearchPipeline,
};
