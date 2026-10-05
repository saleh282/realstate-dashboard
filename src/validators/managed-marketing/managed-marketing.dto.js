'use strict';

const { Type } = require('class-transformer');
const {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} = require('class-validator');
class CreateManagedMarketingPackageDto {}
Matches(/^[a-z0-9][a-z0-9_-]{1,49}$/)(CreateManagedMarketingPackageDto.prototype, 'code');
IsString()(CreateManagedMarketingPackageDto.prototype, 'code');
MaxLength(100)(CreateManagedMarketingPackageDto.prototype, 'nameAr');
MinLength(2)(CreateManagedMarketingPackageDto.prototype, 'nameAr');
IsString()(CreateManagedMarketingPackageDto.prototype, 'nameAr');
MaxLength(100)(CreateManagedMarketingPackageDto.prototype, 'nameEn');
MinLength(2)(CreateManagedMarketingPackageDto.prototype, 'nameEn');
IsString()(CreateManagedMarketingPackageDto.prototype, 'nameEn');
MaxLength(1000)(CreateManagedMarketingPackageDto.prototype, 'detailsAr');
IsString()(CreateManagedMarketingPackageDto.prototype, 'detailsAr');
IsOptional()(CreateManagedMarketingPackageDto.prototype, 'detailsAr');
MaxLength(1000)(CreateManagedMarketingPackageDto.prototype, 'detailsEn');
IsString()(CreateManagedMarketingPackageDto.prototype, 'detailsEn');
IsOptional()(CreateManagedMarketingPackageDto.prototype, 'detailsEn');
IsString({ each: true })(CreateManagedMarketingPackageDto.prototype, 'includedServiceCodes');
ArrayMaxSize(30)(CreateManagedMarketingPackageDto.prototype, 'includedServiceCodes');
IsArray()(CreateManagedMarketingPackageDto.prototype, 'includedServiceCodes');
IsString({ each: true })(CreateManagedMarketingPackageDto.prototype, 'benefitsAr');
ArrayMaxSize(30)(CreateManagedMarketingPackageDto.prototype, 'benefitsAr');
IsArray()(CreateManagedMarketingPackageDto.prototype, 'benefitsAr');
IsString({ each: true })(CreateManagedMarketingPackageDto.prototype, 'benefitsEn');
ArrayMaxSize(30)(CreateManagedMarketingPackageDto.prototype, 'benefitsEn');
IsArray()(CreateManagedMarketingPackageDto.prototype, 'benefitsEn');
Min(1)(CreateManagedMarketingPackageDto.prototype, 'priceMinor');
IsInt()(CreateManagedMarketingPackageDto.prototype, 'priceMinor');
Type(() => Number)(CreateManagedMarketingPackageDto.prototype, 'priceMinor');
IsBoolean()(CreateManagedMarketingPackageDto.prototype, 'isActive');
IsOptional()(CreateManagedMarketingPackageDto.prototype, 'isActive');
Max(10000)(CreateManagedMarketingPackageDto.prototype, 'sortOrder');
Min(0)(CreateManagedMarketingPackageDto.prototype, 'sortOrder');
IsInt()(CreateManagedMarketingPackageDto.prototype, 'sortOrder');
Type(() => Number)(CreateManagedMarketingPackageDto.prototype, 'sortOrder');
IsOptional()(CreateManagedMarketingPackageDto.prototype, 'sortOrder');
class UpdateManagedMarketingPackageDto {}
Min(1)(UpdateManagedMarketingPackageDto.prototype, 'version');
IsInt()(UpdateManagedMarketingPackageDto.prototype, 'version');
Type(() => Number)(UpdateManagedMarketingPackageDto.prototype, 'version');
MaxLength(100)(UpdateManagedMarketingPackageDto.prototype, 'nameAr');
MinLength(2)(UpdateManagedMarketingPackageDto.prototype, 'nameAr');
IsString()(UpdateManagedMarketingPackageDto.prototype, 'nameAr');
IsOptional()(UpdateManagedMarketingPackageDto.prototype, 'nameAr');
MaxLength(100)(UpdateManagedMarketingPackageDto.prototype, 'nameEn');
MinLength(2)(UpdateManagedMarketingPackageDto.prototype, 'nameEn');
IsString()(UpdateManagedMarketingPackageDto.prototype, 'nameEn');
IsOptional()(UpdateManagedMarketingPackageDto.prototype, 'nameEn');
MaxLength(1000)(UpdateManagedMarketingPackageDto.prototype, 'detailsAr');
IsString()(UpdateManagedMarketingPackageDto.prototype, 'detailsAr');
IsOptional()(UpdateManagedMarketingPackageDto.prototype, 'detailsAr');
MaxLength(1000)(UpdateManagedMarketingPackageDto.prototype, 'detailsEn');
IsString()(UpdateManagedMarketingPackageDto.prototype, 'detailsEn');
IsOptional()(UpdateManagedMarketingPackageDto.prototype, 'detailsEn');
IsString({ each: true })(UpdateManagedMarketingPackageDto.prototype, 'includedServiceCodes');
ArrayMaxSize(30)(UpdateManagedMarketingPackageDto.prototype, 'includedServiceCodes');
IsArray()(UpdateManagedMarketingPackageDto.prototype, 'includedServiceCodes');
IsOptional()(UpdateManagedMarketingPackageDto.prototype, 'includedServiceCodes');
IsString({ each: true })(UpdateManagedMarketingPackageDto.prototype, 'benefitsAr');
ArrayMaxSize(30)(UpdateManagedMarketingPackageDto.prototype, 'benefitsAr');
IsArray()(UpdateManagedMarketingPackageDto.prototype, 'benefitsAr');
IsOptional()(UpdateManagedMarketingPackageDto.prototype, 'benefitsAr');
IsString({ each: true })(UpdateManagedMarketingPackageDto.prototype, 'benefitsEn');
ArrayMaxSize(30)(UpdateManagedMarketingPackageDto.prototype, 'benefitsEn');
IsArray()(UpdateManagedMarketingPackageDto.prototype, 'benefitsEn');
IsOptional()(UpdateManagedMarketingPackageDto.prototype, 'benefitsEn');
Min(1)(UpdateManagedMarketingPackageDto.prototype, 'priceMinor');
IsInt()(UpdateManagedMarketingPackageDto.prototype, 'priceMinor');
Type(() => Number)(UpdateManagedMarketingPackageDto.prototype, 'priceMinor');
IsOptional()(UpdateManagedMarketingPackageDto.prototype, 'priceMinor');
IsBoolean()(UpdateManagedMarketingPackageDto.prototype, 'isActive');
IsOptional()(UpdateManagedMarketingPackageDto.prototype, 'isActive');
Max(10000)(UpdateManagedMarketingPackageDto.prototype, 'sortOrder');
Min(0)(UpdateManagedMarketingPackageDto.prototype, 'sortOrder');
IsInt()(UpdateManagedMarketingPackageDto.prototype, 'sortOrder');
Type(() => Number)(UpdateManagedMarketingPackageDto.prototype, 'sortOrder');
IsOptional()(UpdateManagedMarketingPackageDto.prototype, 'sortOrder');
class CreateManagedMarketingRequestDto {}
IsMongoId()(CreateManagedMarketingRequestDto.prototype, 'propertyId');
IsMongoId()(CreateManagedMarketingRequestDto.prototype, 'propertyRevisionId');
IsMongoId()(CreateManagedMarketingRequestDto.prototype, 'packageId');
class CancelManagedMarketingRequestDto {}
MaxLength(1000)(CancelManagedMarketingRequestDto.prototype, 'reason');
IsString()(CancelManagedMarketingRequestDto.prototype, 'reason');
IsOptional()(CancelManagedMarketingRequestDto.prototype, 'reason');
class ReviewManagedMarketingRequestDto {}
IsIn(['APPROVED', 'REJECTED'])(ReviewManagedMarketingRequestDto.prototype, 'status');
Min(0)(ReviewManagedMarketingRequestDto.prototype, 'version');
IsInt()(ReviewManagedMarketingRequestDto.prototype, 'version');
Type(() => Number)(ReviewManagedMarketingRequestDto.prototype, 'version');
MaxLength(1000)(ReviewManagedMarketingRequestDto.prototype, 'reason');
MinLength(5)(ReviewManagedMarketingRequestDto.prototype, 'reason');
IsString()(ReviewManagedMarketingRequestDto.prototype, 'reason');
ValidateIf((dto) => dto.status === 'REJECTED')(
  ReviewManagedMarketingRequestDto.prototype,
  'reason',
);
/**
 * Body of `POST /managed-marketing/requests/:requestId/payment` (MAZAD-028): deliberately EMPTY. The amount, currency,
 * payer and outcome are all server-owned; the strict validation pipe rejects any field a client tries to send.
 * `_none` exists only because class-validator refuses a class with no decorated property.
 */
class InitiateManagedMarketingPaymentDto {}
IsIn([])(InitiateManagedMarketingPaymentDto.prototype, '_none');
IsOptional()(InitiateManagedMarketingPaymentDto.prototype, '_none');

Object.assign(exports, {
  CreateManagedMarketingPackageDto,
  UpdateManagedMarketingPackageDto,
  CreateManagedMarketingRequestDto,
  CancelManagedMarketingRequestDto,
  ReviewManagedMarketingRequestDto,
  InitiateManagedMarketingPaymentDto,
});
