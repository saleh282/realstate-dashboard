import { Transform, Type } from 'class-transformer';
import { Allow, ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsMongoId, IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { decodeMinorUnitTransport, EGP_CURRENCY, MONEY_MINOR_MAX } from '../../common/money/money';
import { PropertyMarketingMode } from '../property.types';

const jsonArray = ({ value }: { value: unknown }) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value.split(',').filter(Boolean); }
};
const bool = ({ value }: { value: unknown }) => value === true || value === 'true';

export class CreatePropertyDto {
  @IsIn(['sale', 'rent']) operationType: string;
  @IsMongoId() purposeCategoryId: string;
  @IsMongoId() purposeSubcategoryId: string;
  /** @deprecated Accepted only as a non-authoritative compatibility hint. */
  @IsOptional() @Allow() propertyTypeCode?: unknown;
  @IsString() @MinLength(5) @MaxLength(150) title: string;
  @IsString() @MinLength(20) @MaxLength(3000) description: string;
  @IsString() @IsNotEmpty() @MaxLength(50) governorateCode: string;
  @IsString() @IsNotEmpty() @MaxLength(100) city: string;
  @IsString() @IsNotEmpty() @MaxLength(100) district: string;
  @IsOptional() @IsString() @MaxLength(200) street?: string;
  @IsOptional() @IsString() @MaxLength(500) additionalAddressDetails?: string;
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) latitude: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) longitude: number;
  @Type(() => Number) @IsNumber() @Min(1) area: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) bedrooms: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) livingRooms: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) kitchens: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) bathrooms: number;
  @Type(() => Number) @IsInt() @Min(-10) @Max(300) floor: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(300) totalFloors: number;
  @Type(() => Number) @IsInt() @Min(1800) @Max(2200) buildingYear: number;
  @IsString() @IsNotEmpty() finishingStatusCode: string;
  @IsString() @IsNotEmpty() deliveryStatusCode: string;
  @Transform(jsonArray) @IsArray() @ArrayUnique() @ArrayMaxSize(100) @IsString({ each: true }) amenityCodes: string[];
  @Transform(({ value }) => decodeMinorUnitTransport(value)) @IsInt() @Min(1) @Max(MONEY_MINOR_MAX) totalPriceMinor: number;
  /** @deprecated Historical read field; rejected for new writes. */
  @IsOptional() @Allow() downPaymentMinor?: unknown;
  @IsOptional() @IsIn([EGP_CURRENCY]) currency?: typeof EGP_CURRENCY;
  /** @deprecated Temporary request compatibility only; never persisted. */
  @IsOptional() @Allow() totalPrice?: unknown;
  /** @deprecated Temporary request compatibility only; never persisted. */
  @IsOptional() @Allow() downPayment?: unknown;
  @Transform(bool) @IsBoolean() isPriceNegotiable: boolean;
  @Transform(jsonArray) @IsArray() @ArrayNotEmpty() @ArrayUnique() @ArrayMaxSize(20) @IsString({ each: true }) paymentMethodCodes: string[];
  /** @deprecated Historical read field; rejected for new writes. */
  @IsOptional() @Allow() paymentMethodCode?: unknown;
  @IsEnum(PropertyMarketingMode) marketingMode: PropertyMarketingMode;
  @Transform(jsonArray) @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) imageLabels: string[];
  @Transform(jsonArray) @IsArray() @ArrayUnique() @ArrayMaxSize(20) @IsString({ each: true }) imageSlotIds: string[];
  @Type(() => Number) @IsInt() @Min(0) coverImageIndex: number;
  /** @deprecated Ignored as authority; the server derives the snapshot. */
  @IsOptional() @Allow() advertiserType?: unknown;
  @Transform(bool) @IsBoolean() hidePhone: boolean;
}

export class AdminCreatePropertyDto extends CreatePropertyDto {
  @IsMongoId()
  advertiserAccountId: string;
}
