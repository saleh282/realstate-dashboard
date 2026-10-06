'use strict';

const ListingCategory = Object.freeze({
  RESIDENTIAL: 'residential',
  COMMERCIAL: 'commercial',
  INDUSTRIAL: 'industrial',
  LAND: 'land',
});

const ListingPurpose = Object.freeze({
  SALE: 'sale',
  RENT: 'rent',
  // The advertiser hands an instalment contract over to the buyer.
  TRANSFER: 'transfer',
});

const ListingStatus = Object.freeze({
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  PUBLISHED: 'published',
  REJECTED: 'rejected',
  CLOSED: 'closed',
});

const SUBTYPES = Object.freeze({
  residential: ['apartment', 'villa', 'duplex', 'studio'],
  commercial: ['shop', 'office', 'clinic'],
  industrial: ['factory', 'warehouse', 'workshop'],
  // For land these are the land uses.
  land: ['residential', 'industrial', 'agricultural'],
});

const AMENITIES = Object.freeze({
  residential: [
    'elevator',
    'garage',
    'security',
    'garden',
    'balcony',
    'natural_gas',
    'central_ac',
    'pool',
    'gym',
  ],
  commercial: [
    'elevator',
    'garage',
    'security',
    'central_ac',
    'cctv',
    'fiber_internet',
    'glass_front',
  ],
  industrial: ['storage_yard', 'loading_dock', 'fire_safety', 'cctv', 'security', 'worker_housing'],
  land: ['fenced', 'water', 'electricity', 'sewage', 'main_road', 'corner'],
});

const AreaUnit = Object.freeze({ SQM: 'sqm', FEDDAN: 'feddan' });
const SQM_PER_FEDDAN = 4200;

const FINISHINGS = Object.freeze(['core_and_shell', 'semi_finished', 'finished', 'super_lux']);
const LEGAL_STATUSES = Object.freeze(['registered', 'preliminary_contract', 'power_of_attorney']);
const WATER_SOURCES = Object.freeze(['well', 'canal', 'none']);
const PAYMENT_METHODS = Object.freeze(['cash', 'installments', 'both']);
const RENT_PERIODS = Object.freeze(['monthly', 'yearly']);

const MAX_PHOTOS = 20;
/** Listings one account may have open (anything but closed) at a time. */
const MAX_OPEN_LISTINGS = 20;

module.exports = {
  ListingCategory,
  ListingPurpose,
  ListingStatus,
  SUBTYPES,
  AMENITIES,
  AreaUnit,
  SQM_PER_FEDDAN,
  FINISHINGS,
  LEGAL_STATUSES,
  WATER_SOURCES,
  PAYMENT_METHODS,
  RENT_PERIODS,
  MAX_PHOTOS,
  MAX_OPEN_LISTINGS,
};
