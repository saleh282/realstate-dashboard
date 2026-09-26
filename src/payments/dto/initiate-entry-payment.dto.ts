import { IsIn, IsOptional } from 'class-validator';

/**
 * Body of `POST /auctions/:auctionId/entry-payment`: deliberately EMPTY. The
 * amount, currency, bidder, purpose and outcome are all server-owned; the
 * strict validation pipe (whitelist + forbidNonWhitelisted) rejects any field
 * a client tries to send (`amountMinor`, `bidderAccountId`, `paid`, ...).
 *
 * `_none` exists only because class-validator refuses a class with no
 * decorated property; its empty allow-list means it can never carry a value.
 */
export class InitiateEntryPaymentDto {
  @IsOptional() @IsIn([]) _none?: never;
}
