import { IsDefined } from 'class-validator';

/**
 * Body of `POST /auctions/:auctionId/bids`. The ONLY client field is the
 * amount; bidder identity, time, sequence, price and end time are server-owned
 * and any extra field is rejected (whitelist + forbidNonWhitelisted in
 * `auctionValidation`). The amount's type/range is validated by the
 * acceptance service so its stable BID_AMOUNT_INVALID / BID_MONEY_RANGE_EXCEEDED
 * codes reach the client (the idempotency key travels in the header).
 */
export class PlaceBidDto {
  @IsDefined() amountMinor: unknown;
}
