import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ParseAuctionIdPipe } from '../auctions/dto/parse-auction-id.pipe';
import { auctionValidation } from '../auctions/dto/auction-validation.pipe';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Capability } from '../authorization/capability';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { ClockService } from '../common/time/clock.service';
import { AuctionEntryEntitlementService } from './auction-entry-entitlement.service';
import { AuctionEntryPaymentService } from './auction-entry-payment.service';
import { InitiateEntryPaymentDto } from './dto/initiate-entry-payment.dto';

/**
 * Entry-payment HTTP API (MAZAD-034A). A thin adapter over the MAZAD-028
 * services: it authenticates, authorises `PAYMENT_ENTRY_INITIATE`, validates the
 * shape and projects the result. The bidder is always `req.user.userId`.
 *
 * There is NO route that confirms, completes or marks a payment: success
 * exists only through the server-side confirmation service, from a
 * server-verified provider outcome.
 */
@Controller('auctions/:auctionId')
@UseGuards(JwtAuthGuard, CapabilityGuard)
@RequireCapabilities(Capability.PAYMENT_ENTRY_INITIATE)
export class AuctionEntryPaymentsController {
  constructor(
    private readonly entitlement: AuctionEntryEntitlementService,
    private readonly initiation: AuctionEntryPaymentService,
    private readonly clock: ClockService,
  ) {}

  @Get('entry-entitlement')
  status(@Req() req: any, @Param('auctionId', ParseAuctionIdPipe) auctionId: string) {
    return this.entitlement.getStatus(req.user.userId, auctionId);
  }

  @Post('entry-payment')
  async initiate(
    @Req() req: any,
    @Param('auctionId', ParseAuctionIdPipe) auctionId: string,
    @Body(auctionValidation(InitiateEntryPaymentDto, AuctionErrorCode.REQUEST_INVALID)) _body: Record<string, any>,
  ) {
    const payment = await this.initiation.initiate(req.user.userId, auctionId, req.ip);
    return {
      message: payment.reused ? 'محاولة الدفع قائمة بالفعل' : 'تم بدء عملية الدفع',
      payment: {
        paymentId: payment.paymentId,
        auctionId: payment.auctionId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        status: payment.status,
        providerReference: payment.providerReference ?? null,
        clientHandoff: payment.clientHandoff ?? null,
        reused: payment.reused,
      },
      serverTime: this.clock.now(),
    };
  }
}
