import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Capability } from '../authorization/capability';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { AuctionsQueryService } from './auctions-query.service';
import { auctionValidation } from './dto/auction-validation.pipe';
import { ParseAuctionIdPipe } from './dto/parse-auction-id.pipe';
import { ListAdminAuctionsDto } from './dto/list-auctions.dto';

/**
 * Staff operational read API (MAZAD-025). Read-only by design: the frozen V1
 * contract has no auction review/approval step (auctions go straight to
 * SCHEDULED on creation) and no admin marketplace participation, so there is
 * nothing to approve, reject, cancel or override here. Admin accounts stay
 * administrative-only; the marketplace create/cancel routes reject them.
 */
@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_AUCTION_READ)
@Controller('admin/auctions')
export class AdminAuctionsController {
  constructor(private readonly queries: AuctionsQueryService) {}

  @Get()
  list(@Query(auctionValidation(ListAdminAuctionsDto, AuctionErrorCode.QUERY_INVALID)) query: Record<string, any>) {
    return this.queries.listForAdmin(query as ListAdminAuctionsDto);
  }

  @Get(':auctionId')
  get(@Param('auctionId', ParseAuctionIdPipe) id: string) {
    return this.queries.getForAdmin(id);
  }
}
