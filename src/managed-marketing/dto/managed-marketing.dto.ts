import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

export class CreateManagedMarketingPackageDto {
  @IsString() @Matches(/^[a-z0-9][a-z0-9_-]{1,49}$/) code: string;
  @IsString() @MinLength(2) @MaxLength(100) nameAr: string;
  @IsString() @MinLength(2) @MaxLength(100) nameEn: string;
  @IsOptional() @IsString() @MaxLength(1000) detailsAr?: string;
  @IsOptional() @IsString() @MaxLength(1000) detailsEn?: string;
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) includedServiceCodes: string[];
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) benefitsAr: string[];
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) benefitsEn: string[];
  @Type(() => Number) @IsInt() @Min(1) priceMinor: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10000) sortOrder?: number;
}

export class UpdateManagedMarketingPackageDto {
  @Type(() => Number) @IsInt() @Min(1) version: number;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) nameAr?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) nameEn?: string;
  @IsOptional() @IsString() @MaxLength(1000) detailsAr?: string;
  @IsOptional() @IsString() @MaxLength(1000) detailsEn?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) includedServiceCodes?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) benefitsAr?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) benefitsEn?: string[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) priceMinor?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10000) sortOrder?: number;
}

export class CreateManagedMarketingRequestDto {
  @IsMongoId() propertyId: string;
  @IsMongoId() propertyRevisionId: string;
  @IsMongoId() packageId: string;
}

export class CancelManagedMarketingRequestDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class ReviewManagedMarketingRequestDto {
  @IsIn(['APPROVED', 'REJECTED']) status: 'APPROVED' | 'REJECTED';
  @Type(() => Number) @IsInt() @Min(0) version: number;
  @ValidateIf((dto: ReviewManagedMarketingRequestDto) => dto.status === 'REJECTED')
  @IsString() @MinLength(5) @MaxLength(1000) reason?: string;
}

/**
 * Body of `POST /managed-marketing/requests/:requestId/payment` (MAZAD-028): deliberately EMPTY. The amount, currency,
 * payer and outcome are all server-owned; the strict validation pipe rejects any field a client tries to send.
 * `_none` exists only because class-validator refuses a class with no decorated property.
 */
export class InitiateManagedMarketingPaymentDto {
  @IsOptional() @IsIn([]) _none?: never;
}
