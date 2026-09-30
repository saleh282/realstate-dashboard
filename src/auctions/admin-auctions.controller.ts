import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Capability } from '../authorization/capability';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { AuctionAdminService } from './auction-admin.service';
import { AuctionLifecycleService } from './auction-lifecycle.service';
import { AuctionsQueryService } from './auctions-query.service';
import { AdminCancelAuctionDto, ListAdminAuctionBidsDto } from './dto/auction-request.dto';
import { auctionValidation } from './dto/auction-validation.pipe';
import { ParseAuctionIdPipe } from './dto/parse-auction-id.pipe';
import { ListAdminAuctionsDto } from './dto/list-auctions.dto';

/**
 * Staff operational auction API (MAZAD-025, completed by MAZAD-035). Reads
 * (list, detail with fee/bidding/payment/entitlement summaries, the staff bid
 * ledger) need ADMIN_AUCTION_READ; cancellation needs ADMIN_AUCTION_CANCEL.
 * Review of new auctions happens on the separate AuctionRequest
 * (`/admin/auction-requests`). Nothing here can alter a bid or pick a winner.
 */
@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_AUCTION_READ)
@Controller('admin/auctions')
export class AdminAuctionsController {
  constructor(
    private readonly queries: AuctionsQueryService,
    private readonly operations: AuctionAdminService,
    private readonly lifecycle: AuctionLifecycleService,
  ) {}

  @Get()
  list(@Query(auctionValidation(ListAdminAuctionsDto, AuctionErrorCode.QUERY_INVALID)) query: Record<string, any>) {
    return this.queries.listForAdmin(query as ListAdminAuctionsDto);
  }

  @Get(':auctionId')
  get(@Param('auctionId', ParseAuctionIdPipe) id: string) {
    return this.operations.getDetail(id);
  }

  @Get(':auctionId/bids')
  ledger(@Param('auctionId', ParseAuctionIdPipe) id: string, @Query(auctionValidation(ListAdminAuctionBidsDto, AuctionErrorCode.QUERY_INVALID)) query: Record<string, any>) {
    return this.operations.listBids(id, query as ListAdminAuctionBidsDto);
  }

  @Post(':auctionId/cancel')
  @RequireCapabilities(Capability.ADMIN_AUCTION_CANCEL)
  cancel(@Req() req: any, @Param('auctionId', ParseAuctionIdPipe) id: string, @Body(auctionValidation(AdminCancelAuctionDto, AuctionErrorCode.REQUEST_INVALID)) dto: Record<string, any>) {
    const input = dto as AdminCancelAuctionDto;
    return this.lifecycle.cancelByAdmin(req.user.userId, id, { reasonCode: input.reasonCode, note: input.note, expectedStatus: input.expectedStatus }, req.ip);
  }
}
