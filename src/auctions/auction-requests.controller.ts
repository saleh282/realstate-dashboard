import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Capability } from '../authorization/capability';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { AuctionRequestsService } from './auction-requests.service';
import { auctionValidation } from './dto/auction-validation.pipe';
import {
  AuctionRequestRevisionDto,
  ListOwnAuctionRequestsDto,
  ParseAuctionRequestIdPipe,
  SubmitAuctionRequestDto,
  UpdateAuctionRequestDto,
} from './dto/auction-request.dto';

/**
 * MAZAD-035 seller API for auction requests. The acting account is always
 * `req.user.userId`; no body field can name an advertiser, a status, a fee or
 * a revision anchor. Fixed paths (`mine`, `eligible-properties`) come before
 * parameterised ones.
 */
@UseGuards(JwtAuthGuard, CapabilityGuard)
@Controller('auction-requests')
export class AuctionRequestsController {
  constructor(private readonly requests: AuctionRequestsService) {}

  @Post()
  @RequireCapabilities(Capability.AUCTION_CREATE_OWN)
  submit(@Req() req: any, @Body(auctionValidation(SubmitAuctionRequestDto, AuctionErrorCode.REQUEST_INVALID)) dto: Record<string, any>) {
    const input = dto as SubmitAuctionRequestDto;
    return this.requests.submit(req.user.userId, {
      propertyId: input.propertyId,
      startingPriceMinor: input.startingPriceMinor,
      minimumBidStepMinor: input.minimumBidStepMinor,
      proposedStartAt: new Date(input.proposedStartAt),
      proposedEndAt: new Date(input.proposedEndAt),
    }, req.ip);
  }

  @Get('eligible-properties')
  @RequireCapabilities(Capability.AUCTION_READ_OWN)
  eligibleProperties(@Req() req: any) {
    return this.requests.listEligibleProperties(req.user.userId);
  }

  @Get('mine')
  @RequireCapabilities(Capability.AUCTION_READ_OWN)
  listMine(@Req() req: any, @Query(auctionValidation(ListOwnAuctionRequestsDto, AuctionErrorCode.QUERY_INVALID)) query: Record<string, any>) {
    return this.requests.listMine(req.user.userId, query as ListOwnAuctionRequestsDto);
  }

  @Get('mine/:requestId')
  @RequireCapabilities(Capability.AUCTION_READ_OWN)
  getMine(@Req() req: any, @Param('requestId', ParseAuctionRequestIdPipe) id: string) {
    return this.requests.getMine(req.user.userId, id);
  }

  @Patch('mine/:requestId')
  @RequireCapabilities(Capability.AUCTION_MANAGE_OWN)
  update(@Req() req: any, @Param('requestId', ParseAuctionRequestIdPipe) id: string, @Body(auctionValidation(UpdateAuctionRequestDto, AuctionErrorCode.REQUEST_INVALID)) dto: Record<string, any>) {
    const input = dto as UpdateAuctionRequestDto;
    return this.requests.update(req.user.userId, id, {
      startingPriceMinor: input.startingPriceMinor,
      minimumBidStepMinor: input.minimumBidStepMinor,
      proposedStartAt: new Date(input.proposedStartAt),
      proposedEndAt: new Date(input.proposedEndAt),
      expectedRevision: input.expectedRevision,
    }, req.ip);
  }

  @Post('mine/:requestId/resubmit')
  @RequireCapabilities(Capability.AUCTION_MANAGE_OWN)
  resubmit(@Req() req: any, @Param('requestId', ParseAuctionRequestIdPipe) id: string, @Body(auctionValidation(AuctionRequestRevisionDto, AuctionErrorCode.REQUEST_INVALID)) dto: Record<string, any>) {
    return this.requests.resubmit(req.user.userId, id, { expectedRevision: (dto as AuctionRequestRevisionDto).expectedRevision }, req.ip);
  }

  @Post('mine/:requestId/withdraw')
  @RequireCapabilities(Capability.AUCTION_MANAGE_OWN)
  withdraw(@Req() req: any, @Param('requestId', ParseAuctionRequestIdPipe) id: string, @Body(auctionValidation(AuctionRequestRevisionDto, AuctionErrorCode.REQUEST_INVALID)) dto: Record<string, any>) {
    return this.requests.withdraw(req.user.userId, id, { expectedRevision: (dto as AuctionRequestRevisionDto).expectedRevision }, req.ip);
  }
}
