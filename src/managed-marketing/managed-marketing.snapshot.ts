import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../common/money/money';

export type ManagedMarketingPackageSource = {
  _id: Types.ObjectId;
  version: number;
  code: string;
  nameAr: string;
  nameEn: string;
  detailsAr?: string;
  detailsEn?: string;
  includedServiceCodes: string[];
  priceMinor?: number;
  currency: typeof EGP_CURRENCY;
  isActive: boolean;
};

export function buildManagedMarketingPackageSnapshot(source: ManagedMarketingPackageSource) {
  if (!source.isActive || !isMoneyMinorAmount(source.priceMinor, { positive: true }) || source.currency !== EGP_CURRENCY) {
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
    priceMinor: source.priceMinor,
    currency: EGP_CURRENCY,
  });
}
