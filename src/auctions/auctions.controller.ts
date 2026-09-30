import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Capability } from '../authorization/capability';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { AuctionLifecycleService } from './auction-lifecycle.service';
import { AuctionsQueryService } from './auctions-query.service';
import { AuctionsService } from './auctions.service';
import { ParseAuctionIdPipe } from './dto/parse-auction-id.pipe';
import { auctionValidation } from './dto/auction-validation.pipe';
import { CancelAuctionDto } from './dto/cancel-auction.dto';
import { ListOwnAuctionsDto, ListPublicAuctionsDto } from './dto/list-auctions.dto';

/**
 * Marketplace auction API (MAZAD-025). Params typed as plain objects on
 * purpose: `auctionValidation` (not the global pipe) validates them so the
 * client receives stable AUCTION_* error codes. The acting account is always
 * `req.user.userId` from the verified token; no request field can name it.
 * Route order matters: the fixed `mine` paths are declared before `:auctionId`.
 */
@Controller('auctions')
export class AuctionsController {
  constructor(
    private readonly auctions: AuctionsService,
    private readonly lifecycle: AuctionLifecycleService,
    private readonly queries: AuctionsQueryService,
  ) {}

  /**
   * MAZAD-035: retired. Creating a SCHEDULED auction without Admin review is no
   * longer possible; this route answers 409 AUCTION_REVIEW_REQUIRED (after the
   * same authentication/capability checks as before) and clients submit an
   * auction request via `POST /auction-requests` instead.
   */
  @Post()
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapabilities(Capability.AUCTION_CREATE_OWN)
  create() {
    return this.auctions.rejectDirectCreation();
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapabilities(Capability.AUCTION_READ_OWN)
  listMine(@Req() req: any, @Query(auctionValidation(ListOwnAuctionsDto, AuctionErrorCode.QUERY_INVALID)) query: Record<string, any>) {
    return this.queries.listMine(req.user.userId, query as ListOwnAuctionsDto);
  }

  @Get('mine/:auctionId')
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapabilities(Capability.AUCTION_READ_OWN)
  getMine(@Req() req: any, @Param('auctionId', ParseAuctionIdPipe) id: string) {
    return this.queries.getMine(req.user.userId, id);
  }

  @Post('mine/:auctionId/cancel')
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapabilities(Capability.AUCTION_MANAGE_OWN)
  cancel(
    @Req() req: any,
    @Param('auctionId', ParseAuctionIdPipe) id: string,
    @Body(auctionValidation(CancelAuctionDto, AuctionErrorCode.REQUEST_INVALID)) dto: Record<string, any>,
  ) {
    const input = dto as CancelAuctionDto;
    return this.lifecycle.cancel(req.user.userId, id, input.reason, req.ip, input.expectedStatus);
  }

  @Get()
  listPublic(@Query(auctionValidation(ListPublicAuctionsDto, AuctionErrorCode.QUERY_INVALID)) query: Record<string, any>) {
    return this.queries.listPublic(query as ListPublicAuctionsDto);
  }

  @Get(':auctionId')
  getPublic(@Param('auctionId', ParseAuctionIdPipe) id: string) {
    return this.queries.getPublic(id);
  }
}
