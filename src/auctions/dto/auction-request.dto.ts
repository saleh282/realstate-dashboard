import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsISO8601, IsMongoId, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Types } from 'mongoose';
import { AuctionErrorCode } from '../../common/errors/auction-error-codes';
import { MONEY_MINOR_MAX } from '../../common/money/money';
import { AUCTION_NOTE_MAX_LENGTH, AuctionRequestStatus } from '../auction-request.types';
import { AuctionStatus } from '../auction.types';
import { PaginationQueryDto } from './list-auctions.dto';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const ISO = { strict: true, strictSeparator: true } as const;

/**
 * Seller-proposed terms. Money is EGP integer minor units; times are ISO-8601
 * instants (clients convert the seller's Cairo-local choice to UTC). Duration,
 * "start in the future" and positivity are enforced by the service with stable
 * codes; the DTO only rejects malformed input and unknown fields.
 */
export class AuctionRequestTermsDto {
  @IsInt() @Min(1) @Max(MONEY_MINOR_MAX) startingPriceMinor: number;
  @IsInt() @Min(1) @Max(MONEY_MINOR_MAX) minimumBidStepMinor: number;
  @IsISO8601(ISO) proposedStartAt: string;
  @IsISO8601(ISO) proposedEndAt: string;
}

/** `POST /auction-requests` — submits directly to PENDING_REVIEW (there is no server-side draft). */
export class SubmitAuctionRequestDto extends AuctionRequestTermsDto {
  @IsMongoId() propertyId: string;
}

/** `PATCH /auction-requests/mine/:requestId` */
export class UpdateAuctionRequestDto extends AuctionRequestTermsDto {
  @IsInt() @Min(1) expectedRevision: number;
}

/** `POST /auction-requests/mine/:requestId/{resubmit,withdraw}` */
export class AuctionRequestRevisionDto {
  @IsInt() @Min(1) expectedRevision: number;
}

export class ListOwnAuctionRequestsDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(AuctionRequestStatus) status?: AuctionRequestStatus;
}

export class ListAdminAuctionRequestsDto extends PaginationQueryDto {
  @IsOptional() @IsIn([...Object.values(AuctionRequestStatus), 'all']) status?: AuctionRequestStatus | 'all';
  @IsOptional() @IsMongoId() propertyId?: string;
  @IsOptional() @IsMongoId() advertiserAccountId?: string;
}

/**
 * `POST /admin/auction-requests/:requestId/review`. There is deliberately no
 * schedule field: an Admin approves the seller's schedule exactly or rejects.
 * `entryFeeMinor` (approve) and `reasonCode` (reject) are validated by the
 * service so the stable domain codes reach the client.
 */
export class ReviewAuctionRequestDto {
  @IsIn(['approve', 'reject']) decision: 'approve' | 'reject';
  @IsInt() @Min(1) expectedRevision: number;
  @IsOptional() entryFeeMinor?: unknown;
  @IsOptional() @IsString() @MaxLength(64) reasonCode?: string;
  /** Rejection only: seller-visible explanation (mandatory for OTHER). */
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(AUCTION_NOTE_MAX_LENGTH) note?: string;
  /** Admin-only note, never shown to the seller. */
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(AUCTION_NOTE_MAX_LENGTH) internalNote?: string;
}

/** `POST /admin/auctions/:auctionId/cancel` */
export class AdminCancelAuctionDto {
  @IsOptional() @IsString() @MaxLength(64) reasonCode?: string;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(AUCTION_NOTE_MAX_LENGTH) note?: string;
  @IsEnum(AuctionStatus) expectedStatus: AuctionStatus;
}

/** `GET /admin/auctions/:auctionId/bids` — ledger order, cursor on `sequence`. */
export class ListAdminAuctionBidsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2_000_000_000) afterSequence?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

@Injectable()
export class ParseAuctionRequestIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !Types.ObjectId.isValid(value) || value.length !== 24) {
      throw new BadRequestException({ message: 'معرّف طلب المزاد غير صالح', code: AuctionErrorCode.REQUEST_ID_INVALID });
    }
    return value;
  }
}
