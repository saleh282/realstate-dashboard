'use strict';

const { validateListing } = require('../src/validators/listings/listing.validator');
const { requiredShots } = require('../src/domain/listings/photo-shots');
const { apartmentForSale, shopForRent, farmlandTransfer } = require('./support/listing-fixtures');

const errorsOf = (input) => Object.keys(validateListing(input).errors).sort();

describe('listing validation', () => {
  it('accepts a complete listing of each kind', () => {
    for (const listing of [apartmentForSale(), shopForRent(), farmlandTransfer()]) {
      expect(validateListing(listing).errors).toEqual({});
    }
  });
  it('names every missing required field', () => {
    expect(errorsOf({})).toEqual(
      [
        'area',
        'category',
        'contactPhone',
        'descriptionAr',
        'district',
        'governorate',
        'location',
        'price',
        'purpose',
        'subtype',
        'titleAr',
      ].sort(),
    );
    expect(errorsOf(null)).toContain('category');
  });
  it('stores the point as GeoJSON and the phone in international form', () => {
    const { value } = validateListing(apartmentForSale());
    expect(value.location).toEqual({ type: 'Point', coordinates: [31.33, 30.05] });
    expect(value.contactPhone).toBe('+201012345678');
    expect(value).toMatchObject({ showPhone: true, allowWhatsapp: true, negotiable: false });
    expect(value).not.toHaveProperty('latitude');
  });
  it('refuses a point outside Egypt', () => {
    expect(errorsOf(apartmentForSale({ latitude: 48.85, longitude: 2.35 }))).toEqual(['location']);
  });
  it('takes a subtype and amenities only from the chosen category', () => {
    expect(errorsOf(apartmentForSale({ subtype: 'shop' }))).toEqual(['subtype']);
    expect(errorsOf(apartmentForSale({ amenities: ['loading_dock'] }))).toEqual(['amenities']);
    expect(
      validateListing(apartmentForSale({ amenities: ['pool', 'pool'] })).value.amenities,
    ).toEqual(['pool']);
  });
  it('asks a home for rooms and finishing', () => {
    const { bedrooms, bathrooms, finishing, ...bare } = apartmentForSale();
    expect(errorsOf(bare)).toEqual(['bathrooms', 'bedrooms', 'finishing']);
  });
  it('drops what does not apply to the category', () => {
    const { value } = validateListing(
      shopForRent({ bedrooms: 4, powerKw: 50, waterSource: 'well', areaUnit: 'feddan' }),
    );
    expect(value).not.toHaveProperty('bedrooms');
    expect(value).not.toHaveProperty('powerKw');
    expect(value).not.toHaveProperty('waterSource');
    expect(value.areaUnit).toBe('sqm');
  });
  it('measures farmland in feddans and keeps its size in square metres', () => {
    const { value } = validateListing(farmlandTransfer());
    expect(value).toMatchObject({
      area: 5,
      areaUnit: 'feddan',
      areaSqm: 21000,
      waterSource: 'well',
    });
    expect(validateListing(apartmentForSale()).value.areaSqm).toBe(150);
  });
  it('checks the floor and the building year', () => {
    expect(errorsOf(apartmentForSale({ floor: 9, totalFloors: 5 }))).toEqual(['totalFloors']);
    expect(errorsOf(apartmentForSale({ buildingYear: 1800 }))).toEqual(['buildingYear']);
    const now = new Date('2026-06-01T00:00:00Z');
    expect(validateListing(apartmentForSale({ buildingYear: 2031 }), now).errors).toEqual({});
    expect(
      Object.keys(validateListing(apartmentForSale({ buildingYear: 2032 }), now).errors),
    ).toEqual(['buildingYear']);
  });
  it('asks a sale for how it is paid, and keeps the down payment under the price', () => {
    const { paymentMethod, ...unpaid } = apartmentForSale();
    expect(errorsOf(unpaid)).toEqual(['paymentMethod']);
    const instalments = { paymentMethod: 'installments' };
    expect(errorsOf(apartmentForSale({ ...instalments, downPayment: 2500000 }))).toEqual([
      'downPayment',
    ]);
    expect(
      validateListing(apartmentForSale({ ...instalments, downPayment: 500000 })).value,
    ).toMatchObject({
      downPayment: 500000,
    });
    // A cash sale has no down payment.
    expect(validateListing(apartmentForSale({ downPayment: 500000 })).value).not.toHaveProperty(
      'downPayment',
    );
  });
  it('asks a rental for its period and, when built for living or trade, its furnishing', () => {
    const { rentPeriod, furnished, ...bare } = shopForRent();
    expect(errorsOf(bare)).toEqual(['furnished', 'rentPeriod']);
    const warehouse = shopForRent({ category: 'industrial', subtype: 'warehouse' });
    delete warehouse.furnished;
    delete warehouse.finishing;
    expect(validateListing(warehouse).errors).toEqual({});
  });
  it('checks the instalment plan of a transfer', () => {
    expect(errorsOf(farmlandTransfer({ transfer: undefined }))).toEqual([
      'monthlyInstallment',
      'paidYears',
      'totalYears',
    ]);
    const plan = (transfer) =>
      farmlandTransfer({ transfer: { monthlyInstallment: 8000, ...transfer } });
    expect(errorsOf(plan({ totalYears: 7, paidYears: 7 }))).toEqual(['paidYears']);
    expect(errorsOf(plan({ totalYears: 41, paidYears: 1 }))).toEqual(['totalYears']);
    expect(errorsOf(plan({ totalYears: 7, paidYears: -1 }))).toEqual(['paidYears']);
    expect(validateListing(plan({ totalYears: 7, paidYears: 0 })).errors).toEqual({});
  });
  it('refuses numbers that are text, zero or negative', () => {
    expect(errorsOf(apartmentForSale({ price: '2500000' }))).toEqual(['price']);
    expect(errorsOf(apartmentForSale({ price: 0 }))).toEqual(['price']);
    expect(errorsOf(apartmentForSale({ area: -5 }))).toEqual(['area']);
    expect(errorsOf(apartmentForSale({ bedrooms: 2.5 }))).toEqual(['bedrooms']);
  });
  it('checks the length of the texts', () => {
    expect(errorsOf(apartmentForSale({ titleAr: 'شقة' }))).toEqual(['titleAr']);
    expect(errorsOf(apartmentForSale({ descriptionAr: 'قصير' }))).toEqual(['descriptionAr']);
    expect(errorsOf(apartmentForSale({ titleEn: 'x'.repeat(151) }))).toEqual(['titleEn']);
    expect(validateListing(apartmentForSale({ titleEn: '  ' })).value).not.toHaveProperty(
      'titleEn',
    );
  });
  it('needs a valid mobile and at least one way to be reached', () => {
    expect(errorsOf(apartmentForSale({ contactPhone: '12345' }))).toEqual(['contactPhone']);
    expect(errorsOf(apartmentForSale({ showPhone: false, allowWhatsapp: false }))).toEqual([
      'contact',
    ]);
    expect(validateListing(apartmentForSale({ showPhone: false })).errors).toEqual({});
  });
});

describe('required photo shots', () => {
  it('lists them per category, the facade first', () => {
    expect(requiredShots({ category: 'residential' })).toHaveLength(6);
    expect(requiredShots({ category: 'industrial' })).toHaveLength(5);
    expect(requiredShots({ category: 'land' })).toHaveLength(4);
    for (const category of ['residential', 'commercial', 'industrial', 'land']) {
      expect(requiredShots({ category })[0]).toBe('facade');
    }
  });
  it('asks a shop for its bathroom only when it has one', () => {
    expect(requiredShots({ category: 'commercial', bathrooms: 1 })).toContain('bathroom');
    expect(requiredShots({ category: 'commercial', bathrooms: 0 })).not.toContain('bathroom');
    expect(requiredShots({ category: 'commercial' })).toHaveLength(4);
  });
});
