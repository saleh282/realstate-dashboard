import { Transform, Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MONEY_MINOR_MAX } from '../../common/money/money';
import { AuctionStatus, PUBLIC_AUCTION_STATUSES } from '../auction.types';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const PUBLIC_AUCTION_SORTS = ['newest', 'ending_soon', 'starting_soon', 'price_asc', 'price_desc'] as const;
export type PublicAuctionSort = (typeof PUBLIC_AUCTION_SORTS)[number];

export class PaginationQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}

/** `GET /auctions/mine` — the caller's own auctions, any status. */
export class ListOwnAuctionsDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(AuctionStatus) status?: AuctionStatus;
}

/** `GET /admin/auctions` — operational read-only listing. */
export class ListAdminAuctionsDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(AuctionStatus) status?: AuctionStatus;
  @IsOptional() @IsMongoId() propertyId?: string;
  @IsOptional() @IsMongoId() advertiserAccountId?: string;
}

/**
 * `GET /auctions` — public discovery. Property facts (location/category)
 * are the same catalog filters `GET /properties` accepts and are evaluated
 * against the property's public-visibility gate; auction facts are status,
 * sort and a starting-price range.
 */
export class ListPublicAuctionsDto extends PaginationQueryDto {
  @IsOptional() @IsIn(PUBLIC_AUCTION_STATUSES as unknown as string[]) status?: AuctionStatus;
  @IsOptional() @IsIn(PUBLIC_AUCTION_SORTS) sort?: PublicAuctionSort;

  @IsOptional() @IsMongoId() purposeCategoryId?: string;
  @IsOptional() @IsMongoId() purposeSubcategoryId?: string;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(50) governorateCode?: string;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(100) city?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(MONEY_MINOR_MAX) minStartingPriceMinor?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(MONEY_MINOR_MAX) maxStartingPriceMinor?: number;
}
