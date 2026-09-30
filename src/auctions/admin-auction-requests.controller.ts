import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { Capability } from '../authorization/capability';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { AuctionRequestsService } from './auction-requests.service';
import { auctionValidation } from './dto/auction-validation.pipe';
import { ListAdminAuctionRequestsDto, ParseAuctionRequestIdPipe, ReviewAuctionRequestDto } from './dto/auction-request.dto';

/**
 * MAZAD-035 Admin review queue. Reads need ADMIN_AUCTION_READ; the decision
 * needs ADMIN_AUCTION_REVIEW (any active ADMIN or SUPER_ADMIN — ordinary
 * moderation is not SUPER_ADMIN-only).
 */
@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_AUCTION_READ)
@Controller('admin/auction-requests')
export class AdminAuctionRequestsController {
  constructor(private readonly requests: AuctionRequestsService) {}

  @Get()
  list(@Query(auctionValidation(ListAdminAuctionRequestsDto, AuctionErrorCode.QUERY_INVALID)) query: Record<string, any>) {
    return this.requests.listForAdmin(query as ListAdminAuctionRequestsDto);
  }

  @Get(':requestId')
  get(@Param('requestId', ParseAuctionRequestIdPipe) id: string) {
    return this.requests.getForAdmin(id);
  }

  @Post(':requestId/review')
  @RequireCapabilities(Capability.ADMIN_AUCTION_REVIEW)
  review(@Req() req: any, @Param('requestId', ParseAuctionRequestIdPipe) id: string, @Body(auctionValidation(ReviewAuctionRequestDto, AuctionErrorCode.REQUEST_INVALID)) dto: Record<string, any>) {
    const input = dto as ReviewAuctionRequestDto;
    return this.requests.review(req.user.userId, id, input, req.ip);
  }
}
