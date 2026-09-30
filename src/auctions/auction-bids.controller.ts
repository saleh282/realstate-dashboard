import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard';
import { Capability } from '../authorization/capability';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { BidErrorCode } from '../common/errors/bid-error-codes';
import { IdempotencyErrorCode } from '../common/idempotency/idempotency.service';
import { ClockService } from '../common/time/clock.service';
import { AuctionBidAcceptanceService } from './auction-bid-acceptance.service';
import { AuctionBiddingReadService } from './auction-bidding-read.service';
import { auctionValidation } from './dto/auction-validation.pipe';
import { ListBidHistoryDto } from './dto/list-bid-history.dto';
import { ParseAuctionIdPipe } from './dto/parse-auction-id.pipe';
import { PlaceBidDto } from './dto/place-bid.dto';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Read-only override for `GET bid-state` (realtime hardening). The global policy
 * (20/min per client address, per route, in-process) is kept everywhere else,
 * including every write. The open auction screen polls bid-state while its socket
 * is down (at most every 5 s ≈ 12–15/min with jitter, plus resyncs), and mobile
 * carriers put many phones behind one address: 120/min fits ~8 such viewers per
 * address. It is a cheap indexed read with no side effects.
 */
export const BID_STATE_THROTTLE = { default: { limit: 120, ttl: 60_000 } } as const;

/**
 * Bid HTTP API (MAZAD-029). A thin adapter: every acceptance decision
 * (auction state, end time, eligibility, self-bid, entitlement, minimum,
 * sequencing, anti-sniping) is MAZAD-027's `AuctionBidAcceptanceService`; the
 * controller only authenticates, authorises `BID_PLACE`, validates the shape,
 * and projects the result. The bidder is always `req.user.userId`.
 */
@Controller('auctions/:auctionId')
export class AuctionBidsController {
  constructor(
    private readonly acceptance: AuctionBidAcceptanceService,
    private readonly reads: AuctionBiddingReadService,
    private readonly clock: ClockService,
  ) {}

  @Post('bids')
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapabilities(Capability.BID_PLACE)
  async place(
    @Req() req: any,
    @Param('auctionId', ParseAuctionIdPipe) auctionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(auctionValidation(PlaceBidDto, AuctionErrorCode.REQUEST_INVALID)) dto: Record<string, any>,
  ) {
    const key = this.requireKey(idempotencyKey);
    const result = await this.acceptance.acceptBid(req.user.userId, auctionId, (dto as PlaceBidDto).amountMinor, req.ip, { key });
    return {
      message: result.replayed ? 'تم تسجيل المزايدة مسبقاً' : 'تم قبول المزايدة',
      bid: {
        auctionId: result.bid.auctionId,
        sequence: result.bid.sequence,
        amountMinor: result.bid.amountMinor,
        currency: result.bid.currency,
        acceptedAt: result.bid.acceptedAt,
      },
      auction: {
        currentEndAt: result.auction.currentEndAt,
        previousEndAt: result.auction.previousEndAt,
        extended: result.auction.extended,
        acceptedBidCount: result.auction.acceptedBidCount,
      },
      nextMinimumBidMinor: result.nextMinimumBidMinor,
      /** True when this response replays the recorded result of an earlier identical request. */
      replayed: result.replayed,
      serverTime: this.clock.now(),
    };
  }

  @Get('bid-state')
  @Throttle(BID_STATE_THROTTLE)
  bidState(@Param('auctionId', ParseAuctionIdPipe) auctionId: string) {
    return this.reads.getPublicBidState(auctionId);
  }

  /**
   * The authoritative public outcome, also after the auction left public detail (terminal).
   * For resync/recovery; never a discovery surface. Default (global) throttle.
   */
  @Get('outcome')
  outcome(@Param('auctionId', ParseAuctionIdPipe) auctionId: string) {
    return this.reads.getPublicOutcome(auctionId);
  }

  @Get('bids')
  @UseGuards(OptionalJwtAuthGuard)
  history(
    @Req() req: any,
    @Param('auctionId', ParseAuctionIdPipe) auctionId: string,
    @Query(auctionValidation(ListBidHistoryDto, AuctionErrorCode.QUERY_INVALID)) query: Record<string, any>,
  ) {
    return this.reads.getPublicBidHistory(auctionId, query as ListBidHistoryDto, req.user?.userId);
  }

  private requireKey(value: string | undefined): string {
    if (value === undefined || value === '') {
      throw new BadRequestException({ message: 'مفتاح منع التكرار (Idempotency-Key) مطلوب', code: BidErrorCode.IDEMPOTENCY_KEY_REQUIRED });
    }
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw new BadRequestException({ message: 'مفتاح منع التكرار غير صالح', code: IdempotencyErrorCode.KEY_INVALID });
    }
    return value;
  }
}
