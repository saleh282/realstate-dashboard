'use strict';

/** A complete, acceptable listing of each kind, as a client sends it. */
const apartmentForSale = (overrides = {}) => ({
  category: 'residential',
  purpose: 'sale',
  subtype: 'apartment',
  titleAr: 'شقة للبيع في مدينة نصر',
  descriptionAr: 'شقة واسعة قريبة من كل الخدمات والمواصلات',
  area: 150,
  bedrooms: 3,
  bathrooms: 2,
  finishing: 'finished',
  amenities: ['elevator', 'garage'],
  latitude: 30.05,
  longitude: 31.33,
  governorate: 'القاهرة',
  district: 'مدينة نصر',
  price: 2500000,
  paymentMethod: 'cash',
  contactPhone: '01012345678',
  ...overrides,
});

const shopForRent = (overrides = {}) => ({
  category: 'commercial',
  purpose: 'rent',
  subtype: 'shop',
  titleAr: 'محل للإيجار على شارع رئيسي',
  descriptionAr: 'محل بواجهة زجاجية على شارع تجاري حيوي',
  area: 60,
  finishing: 'finished',
  latitude: 30.06,
  longitude: 31.25,
  governorate: 'القاهرة',
  district: 'وسط البلد',
  price: 20000,
  rentPeriod: 'monthly',
  furnished: false,
  contactPhone: '01012345678',
  ...overrides,
});

const farmlandTransfer = (overrides = {}) => ({
  category: 'land',
  purpose: 'transfer',
  subtype: 'agricultural',
  titleAr: 'أرض زراعية بالتقسيط للتنازل',
  descriptionAr: 'أرض زراعية مستوية على طريق ممهد وبها بئر مياه',
  area: 5,
  areaUnit: 'feddan',
  waterSource: 'well',
  streets: 2,
  latitude: 30.4,
  longitude: 30.9,
  governorate: 'البحيرة',
  district: 'وادي النطرون',
  price: 400000,
  transfer: { monthlyInstallment: 8000, totalYears: 7, paidYears: 2, developer: 'شركة الريف' },
  contactPhone: '01012345678',
  ...overrides,
});

module.exports = { apartmentForSale, shopForRent, farmlandTransfer };
