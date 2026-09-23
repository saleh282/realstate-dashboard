import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MONEY_MINOR_MAX } from '../../common/money/money';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const PROPERTY_SEARCH_SORTS = ['newest', 'price_asc', 'price_desc'] as const;
export type PropertySearchSort = (typeof PROPERTY_SEARCH_SORTS)[number];

/**
 * Query contract for `GET /properties` (MAZAD-021 public marketplace search).
 * Every field is optional; an absent field means "no filter on this
 * dimension". Auction mode is intentionally not offered here yet: the schema
 * only knows `sale`/`rent` until bidding/auctions are implemented.
 */
export class ListPublishedPropertiesDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;

  @IsOptional() @IsIn(['sale', 'rent']) operationType?: string;

  @IsOptional() @IsMongoId() purposeCategoryId?: string;
  @IsOptional() @IsMongoId() purposeSubcategoryId?: string;

  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(50) governorateCode?: string;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(100) city?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(MONEY_MINOR_MAX) minPriceMinor?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(MONEY_MINOR_MAX) maxPriceMinor?: number;

  /** Free-text keyword, matched against title/city/district (same pattern as the admin search). */
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(120) q?: string;

  @IsOptional() @IsIn(PROPERTY_SEARCH_SORTS) sort?: PropertySearchSort;
}
