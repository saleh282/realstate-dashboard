'use strict';

const { BadRequestException } = require('../../common/http/errors');
const { Types } = require('mongoose');
const { EGP_CURRENCY, isMoneyMinorAmount } = require('../../common/money/money');
function buildManagedMarketingPackageSnapshot(source) {
  if (
    !source.isActive ||
    !isMoneyMinorAmount(source.priceMinor, { positive: true }) ||
    source.currency !== EGP_CURRENCY
  ) {
    throw new BadRequestException({
      message: 'باقة التسويق غير متاحة للطلب',
      code: 'MANAGED_MARKETING_PACKAGE_UNAVAILABLE',
    });
  }
  return Object.freeze({
    packageId: new Types.ObjectId(source._id),
    packageVersion: source.version,
    code: source.code,
    nameAr: source.nameAr,
    nameEn: source.nameEn,
    detailsAr: source.detailsAr,
    detailsEn: source.detailsEn,
    includedServiceCodes: Object.freeze([...source.includedServiceCodes]),
    benefitsAr: Object.freeze([...(source.benefitsAr ?? [])]),
    benefitsEn: Object.freeze([...(source.benefitsEn ?? [])]),
    priceMinor: source.priceMinor,
    currency: EGP_CURRENCY,
  });
}

Object.assign(exports, { buildManagedMarketingPackageSnapshot });
