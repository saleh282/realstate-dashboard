import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuctionStatus } from '../auction.types';

/**
 * Body of `POST /auctions/mine/:auctionId/cancel`.
 * `reason` is required by the lifecycle service only for an ACTIVE auction.
 * `expectedStatus` is the optimistic-concurrency guard: the status the client
 * last saw. If the auction has since moved (e.g. SCHEDULED -> ACTIVE, which
 * changes the reason requirement) the request fails with
 * `AUCTION_STATE_CONFLICT` instead of cancelling under a stale assumption.
 */
export class CancelAuctionDto {
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)) @IsString() @MaxLength(1000) reason?: string;
  @IsOptional() @IsEnum(AuctionStatus) expectedStatus?: AuctionStatus;
}
