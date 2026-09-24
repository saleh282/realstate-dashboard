import { IsISO8601, IsInt, IsMongoId, Max, Min } from 'class-validator';
import { MONEY_MINOR_MAX } from '../../common/money/money';

/**
 * Body of `POST /auctions`. Deliberately carries no advertiser/owner,
 * property-revision, status, currency or rule-snapshot fields: attribution
 * and the frozen anchor come from backend state, and unknown fields are
 * rejected by `auctionValidation`. Money is EGP integer minor units.
 */
export class CreateAuctionDto {
  @IsMongoId() propertyId: string;
  @IsInt() @Min(1) @Max(MONEY_MINOR_MAX) startingPriceMinor: number;
  @IsInt() @Min(1) @Max(MONEY_MINOR_MAX) minimumBidStepMinor: number;
  @IsISO8601({ strict: true, strictSeparator: true }) scheduledStartAt: string;
  @IsISO8601({ strict: true, strictSeparator: true }) scheduledEndAt: string;
}
