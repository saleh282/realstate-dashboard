'use strict';

const { Types } = require('mongoose');
const {
  buildManagedMarketingPackageSnapshot,
} = require('../src/domain/managed-marketing/managed-marketing.snapshot');
describe('MAZAD-020B managed-marketing contract', () => {
  const source = {
    _id: new Types.ObjectId(),
    version: 7,
    code: 'custom',
    nameAr: 'باقة مخصصة',
    nameEn: 'Custom',
    detailsAr: 'تفاصيل معتمدة',
    includedServiceCodes: ['inspection'],
    benefitsAr: ['معاينة العقار'],
    benefitsEn: ['Property inspection'],
    priceMinor: 123_400,
    currency: 'EGP',
    isActive: true,
  };
  it('copies server price and benefits into an immutable request snapshot', () => {
    const snapshot = buildManagedMarketingPackageSnapshot(source);
    source.benefitsAr.push('changed');
    source.priceMinor = 1;
    expect(snapshot).toMatchObject({
      packageVersion: 7,
      priceMinor: 123_400,
      benefitsAr: ['معاينة العقار'],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.benefitsAr)).toBe(true);
  });
  it('does not allow inactive or unpriced packages to be requested', () => {
    expect(() => buildManagedMarketingPackageSnapshot({ ...source, isActive: false })).toThrow(
      'باقة التسويق غير متاحة',
    );
    expect(() =>
      buildManagedMarketingPackageSnapshot({ ...source, priceMinor: undefined }),
    ).toThrow('باقة التسويق غير متاحة');
  });
});
