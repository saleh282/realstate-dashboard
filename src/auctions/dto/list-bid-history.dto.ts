import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** `GET /auctions/:auctionId/bids` — cursor pagination over the ledger order (`sequence` ascending). */
export class ListBidHistoryDto {
  /** Return only bids with a greater sequence; pass the previous page's `nextAfterSequence`. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2_000_000_000) afterSequence?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
