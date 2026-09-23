import { BadRequestException } from '@nestjs/common';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../common/money/money';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';

/**
 * Bumped only if the approved auction rules themselves change (a future,
 * explicitly-versioned decision). Auctions created under V1 keep this value
 * forever in their frozen `ruleSnapshot`, so a later V2 rule change can
 * never silently reinterpret an already-created auction.
 */
export const AUCTION_RULE_SNAPSHOT_VERSION_V1 = 1;

/** Frozen V1 decision: "final 5 minutes" anti-sniping window. */
export const AUCTION_ANTI_SNIPING_WINDOW_SECONDS_V1 = 5 * 60;
/** Frozen V1 decision: "extend by 5 minutes repeatedly with no cap". */
export const AUCTION_ANTI_SNIPING_EXTENSION_SECONDS_V1 = 5 * 60;

export type AuctionRuleSnapshotInput = {
  startingPriceMinor: number;
  minimumBidStepMinor: number;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
};

/**
 * Builds the immutable record of the rules an auction was created under.
 * This is the single source of truth `ruleSnapshot` on the `Auction`
 * document is populated from (see `schemas/auction.schema.ts`) — later bid
 * acceptance, anti-sniping extension, and closing logic (MAZAD-024+) must
 * read the numbers *from this snapshot*, never from any mutable/global
 * config, so an already-created auction's terms can never silently drift
 * out from under it.
 *
 * Money/schedule shape validation lives here (reused by both the service
 * and, indirectly, the schema's own field validators) so "starting price
 * must be positive" / "minimum bid step must be positive" / "end after
 * start" can never be bypassed by a caller that skips this function.
 */
export function buildAuctionRuleSnapshot(input: AuctionRuleSnapshotInput) {
  if (!isMoneyMinorAmount(input.startingPriceMinor, { positive: true })) {
    throw new BadRequestException({
      message: 'سعر بدء المزاد يجب أن يكون رقمًا صحيحًا موجبًا بوحدات العملة الصغرى ضمن النطاق الآمن',
      code: AuctionErrorCode.STARTING_PRICE_INVALID,
    });
  }
  if (!isMoneyMinorAmount(input.minimumBidStepMinor, { positive: true })) {
    throw new BadRequestException({
      message: 'الحد الأدنى لخطوة المزايدة يجب أن يكون رقمًا صحيحًا موجبًا بوحدات العملة الصغرى ضمن النطاق الآمن',
      code: AuctionErrorCode.MINIMUM_BID_STEP_INVALID,
    });
  }
  const start = input.scheduledStartAt;
  const end = input.scheduledEndAt;
  if (!(start instanceof Date) || Number.isNaN(start.getTime()) || !(end instanceof Date) || Number.isNaN(end.getTime())) {
    throw new BadRequestException({ message: 'مواعيد بدء وانتهاء المزاد غير صالحة', code: AuctionErrorCode.SCHEDULE_INVALID });
  }
  if (end.getTime() <= start.getTime()) {
    throw new BadRequestException({ message: 'يجب أن يكون موعد انتهاء المزاد بعد موعد بدئه', code: AuctionErrorCode.SCHEDULE_INVALID });
  }

  return Object.freeze({
    version: AUCTION_RULE_SNAPSHOT_VERSION_V1,
    startingPriceMinor: input.startingPriceMinor,
    minimumBidStepMinor: input.minimumBidStepMinor,
    currency: EGP_CURRENCY,
    scheduledStartAt: start,
    scheduledEndAt: end,
    // Frozen V1 business rules, preserved as data so bid acceptance,
    // anti-sniping and closing (MAZAD-024+) read them from the auction
    // itself instead of re-encoding the same decisions a second time.
    hasReservePrice: false,
    advertiserSelfBidForbidden: true,
    adminBiddingForbidden: true,
    bidsAreImmutable: true,
    serverTimeAuthoritative: true,
    automaticWinnerDetermination: true,
    secondPlacePromotionOnCancellation: false,
    antiSnipingWindowSeconds: AUCTION_ANTI_SNIPING_WINDOW_SECONDS_V1,
    antiSnipingExtensionSeconds: AUCTION_ANTI_SNIPING_EXTENSION_SECONDS_V1,
  });
}
