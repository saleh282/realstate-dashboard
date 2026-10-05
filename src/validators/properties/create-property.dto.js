'use strict';

const { Transform, Type } = require('class-transformer');
const {
  Allow,
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} = require('class-validator');
const {
  decodeMinorUnitTransport,
  EGP_CURRENCY,
  MONEY_MINOR_MAX,
} = require('../../common/money/money');
const { PropertyMarketingMode } = require('../../domain/properties/property.types');
const jsonArray = ({ value }) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value.split(',').filter(Boolean);
  }
};
const bool = ({ value }) => value === true || value === 'true';
class CreatePropertyDto {}
Min(0)(CreatePropertyDto.prototype, 'expectedRevisionVersion');
IsInt()(CreatePropertyDto.prototype, 'expectedRevisionVersion');
Type(() => Number)(CreatePropertyDto.prototype, 'expectedRevisionVersion');
IsOptional()(CreatePropertyDto.prototype, 'expectedRevisionVersion');
IsIn(['sale', 'rent'])(CreatePropertyDto.prototype, 'operationType');
IsMongoId()(CreatePropertyDto.prototype, 'purposeCategoryId');
IsMongoId()(CreatePropertyDto.prototype, 'purposeSubcategoryId');
IsMongoId({ each: true })(CreatePropertyDto.prototype, 'purposeSubcategoryIds');
IsArray()(CreatePropertyDto.prototype, 'purposeSubcategoryIds');
Transform(jsonArray)(CreatePropertyDto.prototype, 'purposeSubcategoryIds');
IsOptional()(CreatePropertyDto.prototype, 'purposeSubcategoryIds');
Allow()(CreatePropertyDto.prototype, 'propertyTypeCode');
IsOptional()(CreatePropertyDto.prototype, 'propertyTypeCode');
MaxLength(150)(CreatePropertyDto.prototype, 'title');
MinLength(5)(CreatePropertyDto.prototype, 'title');
IsString()(CreatePropertyDto.prototype, 'title');
MaxLength(3000)(CreatePropertyDto.prototype, 'description');
MinLength(20)(CreatePropertyDto.prototype, 'description');
IsString()(CreatePropertyDto.prototype, 'description');
MaxLength(50)(CreatePropertyDto.prototype, 'governorateCode');
IsNotEmpty()(CreatePropertyDto.prototype, 'governorateCode');
IsString()(CreatePropertyDto.prototype, 'governorateCode');
MaxLength(100)(CreatePropertyDto.prototype, 'city');
IsNotEmpty()(CreatePropertyDto.prototype, 'city');
IsString()(CreatePropertyDto.prototype, 'city');
MaxLength(100)(CreatePropertyDto.prototype, 'district');
IsNotEmpty()(CreatePropertyDto.prototype, 'district');
IsString()(CreatePropertyDto.prototype, 'district');
MaxLength(200)(CreatePropertyDto.prototype, 'street');
IsString()(CreatePropertyDto.prototype, 'street');
IsOptional()(CreatePropertyDto.prototype, 'street');
MaxLength(500)(CreatePropertyDto.prototype, 'additionalAddressDetails');
IsString()(CreatePropertyDto.prototype, 'additionalAddressDetails');
IsOptional()(CreatePropertyDto.prototype, 'additionalAddressDetails');
Max(90)(CreatePropertyDto.prototype, 'latitude');
Min(-90)(CreatePropertyDto.prototype, 'latitude');
IsNumber()(CreatePropertyDto.prototype, 'latitude');
Type(() => Number)(CreatePropertyDto.prototype, 'latitude');
Max(180)(CreatePropertyDto.prototype, 'longitude');
Min(-180)(CreatePropertyDto.prototype, 'longitude');
IsNumber()(CreatePropertyDto.prototype, 'longitude');
Type(() => Number)(CreatePropertyDto.prototype, 'longitude');
Min(1)(CreatePropertyDto.prototype, 'area');
IsNumber()(CreatePropertyDto.prototype, 'area');
Type(() => Number)(CreatePropertyDto.prototype, 'area');
Max(100)(CreatePropertyDto.prototype, 'bedrooms');
Min(1)(CreatePropertyDto.prototype, 'bedrooms');
IsInt()(CreatePropertyDto.prototype, 'bedrooms');
Type(() => Number)(CreatePropertyDto.prototype, 'bedrooms');
IsOptional()(CreatePropertyDto.prototype, 'bedrooms');
Max(100)(CreatePropertyDto.prototype, 'livingRooms');
Min(1)(CreatePropertyDto.prototype, 'livingRooms');
IsInt()(CreatePropertyDto.prototype, 'livingRooms');
Type(() => Number)(CreatePropertyDto.prototype, 'livingRooms');
IsOptional()(CreatePropertyDto.prototype, 'livingRooms');
Max(100)(CreatePropertyDto.prototype, 'kitchens');
Min(1)(CreatePropertyDto.prototype, 'kitchens');
IsInt()(CreatePropertyDto.prototype, 'kitchens');
Type(() => Number)(CreatePropertyDto.prototype, 'kitchens');
IsOptional()(CreatePropertyDto.prototype, 'kitchens');
Max(100)(CreatePropertyDto.prototype, 'bathrooms');
Min(1)(CreatePropertyDto.prototype, 'bathrooms');
IsInt()(CreatePropertyDto.prototype, 'bathrooms');
Type(() => Number)(CreatePropertyDto.prototype, 'bathrooms');
IsOptional()(CreatePropertyDto.prototype, 'bathrooms');
Max(300)(CreatePropertyDto.prototype, 'floor');
Min(-10)(CreatePropertyDto.prototype, 'floor');
IsInt()(CreatePropertyDto.prototype, 'floor');
Type(() => Number)(CreatePropertyDto.prototype, 'floor');
IsOptional()(CreatePropertyDto.prototype, 'floor');
Max(300)(CreatePropertyDto.prototype, 'totalFloors');
Min(1)(CreatePropertyDto.prototype, 'totalFloors');
IsInt()(CreatePropertyDto.prototype, 'totalFloors');
Type(() => Number)(CreatePropertyDto.prototype, 'totalFloors');
IsOptional()(CreatePropertyDto.prototype, 'totalFloors');
Max(2200)(CreatePropertyDto.prototype, 'buildingYear');
Min(1800)(CreatePropertyDto.prototype, 'buildingYear');
IsInt()(CreatePropertyDto.prototype, 'buildingYear');
Type(() => Number)(CreatePropertyDto.prototype, 'buildingYear');
IsOptional()(CreatePropertyDto.prototype, 'buildingYear');
IsNotEmpty()(CreatePropertyDto.prototype, 'finishingStatusCode');
IsString()(CreatePropertyDto.prototype, 'finishingStatusCode');
IsOptional()(CreatePropertyDto.prototype, 'finishingStatusCode');
IsNotEmpty()(CreatePropertyDto.prototype, 'deliveryStatusCode');
IsString()(CreatePropertyDto.prototype, 'deliveryStatusCode');
IsOptional()(CreatePropertyDto.prototype, 'deliveryStatusCode');
IsMongoId()(CreatePropertyDto.prototype, 'formDefinitionVersionId');
IsOptional()(CreatePropertyDto.prototype, 'formDefinitionVersionId');
Allow()(CreatePropertyDto.prototype, 'attributes');
IsOptional()(CreatePropertyDto.prototype, 'attributes');
IsMongoId()(CreatePropertyDto.prototype, 'formDefinitionId');
IsOptional()(CreatePropertyDto.prototype, 'formDefinitionId');
Min(1)(CreatePropertyDto.prototype, 'formDefinitionVersion');
IsInt()(CreatePropertyDto.prototype, 'formDefinitionVersion');
Type(() => Number)(CreatePropertyDto.prototype, 'formDefinitionVersion');
IsOptional()(CreatePropertyDto.prototype, 'formDefinitionVersion');
Matches(/^[a-f0-9]{64}$/)(CreatePropertyDto.prototype, 'formContentHash');
IsOptional()(CreatePropertyDto.prototype, 'formContentHash');
IsString({ each: true })(CreatePropertyDto.prototype, 'amenityCodes');
ArrayMaxSize(100)(CreatePropertyDto.prototype, 'amenityCodes');
ArrayUnique()(CreatePropertyDto.prototype, 'amenityCodes');
IsArray()(CreatePropertyDto.prototype, 'amenityCodes');
Transform(jsonArray)(CreatePropertyDto.prototype, 'amenityCodes');
Max(MONEY_MINOR_MAX)(CreatePropertyDto.prototype, 'totalPriceMinor');
Min(1)(CreatePropertyDto.prototype, 'totalPriceMinor');
IsInt()(CreatePropertyDto.prototype, 'totalPriceMinor');
Transform(({ value }) => decodeMinorUnitTransport(value))(
  CreatePropertyDto.prototype,
  'totalPriceMinor',
);
Allow()(CreatePropertyDto.prototype, 'downPaymentMinor');
IsOptional()(CreatePropertyDto.prototype, 'downPaymentMinor');
IsIn([EGP_CURRENCY])(CreatePropertyDto.prototype, 'currency');
IsOptional()(CreatePropertyDto.prototype, 'currency');
Allow()(CreatePropertyDto.prototype, 'totalPrice');
IsOptional()(CreatePropertyDto.prototype, 'totalPrice');
Allow()(CreatePropertyDto.prototype, 'downPayment');
IsOptional()(CreatePropertyDto.prototype, 'downPayment');
IsBoolean()(CreatePropertyDto.prototype, 'isPriceNegotiable');
Transform(bool)(CreatePropertyDto.prototype, 'isPriceNegotiable');
IsString({ each: true })(CreatePropertyDto.prototype, 'paymentMethodCodes');
ArrayMaxSize(20)(CreatePropertyDto.prototype, 'paymentMethodCodes');
ArrayUnique()(CreatePropertyDto.prototype, 'paymentMethodCodes');
ArrayNotEmpty()(CreatePropertyDto.prototype, 'paymentMethodCodes');
IsArray()(CreatePropertyDto.prototype, 'paymentMethodCodes');
Transform(jsonArray)(CreatePropertyDto.prototype, 'paymentMethodCodes');
Allow()(CreatePropertyDto.prototype, 'paymentMethodCode');
IsOptional()(CreatePropertyDto.prototype, 'paymentMethodCode');
IsEnum(PropertyMarketingMode)(CreatePropertyDto.prototype, 'marketingMode');
IsString({ each: true })(CreatePropertyDto.prototype, 'imageLabels');
ArrayMaxSize(20)(CreatePropertyDto.prototype, 'imageLabels');
IsArray()(CreatePropertyDto.prototype, 'imageLabels');
Transform(jsonArray)(CreatePropertyDto.prototype, 'imageLabels');
IsString({ each: true })(CreatePropertyDto.prototype, 'imageSlotIds');
ArrayMaxSize(20)(CreatePropertyDto.prototype, 'imageSlotIds');
ArrayUnique()(CreatePropertyDto.prototype, 'imageSlotIds');
IsArray()(CreatePropertyDto.prototype, 'imageSlotIds');
Transform(jsonArray)(CreatePropertyDto.prototype, 'imageSlotIds');
Min(0)(CreatePropertyDto.prototype, 'coverImageIndex');
IsInt()(CreatePropertyDto.prototype, 'coverImageIndex');
Type(() => Number)(CreatePropertyDto.prototype, 'coverImageIndex');
Allow()(CreatePropertyDto.prototype, 'advertiserType');
IsOptional()(CreatePropertyDto.prototype, 'advertiserType');
IsBoolean()(CreatePropertyDto.prototype, 'hidePhone');
Transform(bool)(CreatePropertyDto.prototype, 'hidePhone');
class AdminCreatePropertyDto extends CreatePropertyDto {}
IsMongoId()(AdminCreatePropertyDto.prototype, 'advertiserAccountId');

Object.assign(exports, { CreatePropertyDto, AdminCreatePropertyDto });
