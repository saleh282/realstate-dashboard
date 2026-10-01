import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Capability } from '../authorization/capability';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CancelManagedMarketingRequestDto, CreateManagedMarketingRequestDto, InitiateManagedMarketingPaymentDto } from './dto/managed-marketing.dto';
import { ManagedMarketingService } from './managed-marketing.service';
import { ManagedMarketingPaymentService } from '../payments/managed-marketing-payment.service';
import { ClockService } from '../common/time/clock.service';

@Controller('managed-marketing')
export class ManagedMarketingController {
  constructor(private service: ManagedMarketingService, private payments: ManagedMarketingPaymentService, private clock: ClockService) {}
  @Get('packages') listPackages() { return this.service.listActivePackages(); }
  @Get('requests/mine') @UseGuards(JwtAuthGuard, CapabilityGuard) @RequireCapabilities(Capability.MANAGED_MARKETING_REQUEST)
  mine(@Req() req: any) { return this.service.listMine(req.user.userId); }
  @Post('requests') @UseGuards(JwtAuthGuard, CapabilityGuard) @RequireCapabilities(Capability.MANAGED_MARKETING_REQUEST)
  create(@Req() req: any, @Body() dto: CreateManagedMarketingRequestDto) { return this.service.createRequest(req.user.userId, dto, req.ip); }
  @Patch('requests/:requestId/cancel') @UseGuards(JwtAuthGuard, CapabilityGuard) @RequireCapabilities(Capability.MANAGED_MARKETING_REQUEST)
  cancel(@Req() req: any, @Param('requestId') id: string, @Body() dto: CancelManagedMarketingRequestDto) { return this.service.cancel(req.user.userId, id, dto.reason, req.ip); }

  /**
   * MAZAD-028: opens (or returns) the payment attempt of the caller's OWN Admin-approved request. The body is EMPTY:
   * the amount is the request's immutable package snapshot price and the payer is the authenticated account. Initiating
   * grants nothing — the request becomes PAID only through server-side confirmation of a provider-verified outcome, and
   * there is no route that confirms a payment.
   */
  @Post('requests/:requestId/payment') @UseGuards(JwtAuthGuard, CapabilityGuard) @RequireCapabilities(Capability.MANAGED_MARKETING_REQUEST)
  async pay(@Req() req: any, @Param('requestId') id: string, @Body() _body: InitiateManagedMarketingPaymentDto) {
    const payment = await this.payments.initiate(req.user.userId, id, req.ip);
    return {
      message: payment.reused ? 'محاولة الدفع قائمة بالفعل' : 'تم بدء عملية الدفع',
      payment: {
        paymentId: payment.paymentId, requestId: payment.requestId, amountMinor: payment.amountMinor, currency: payment.currency,
        status: payment.status, clientHandoff: payment.clientHandoff ?? null, reused: payment.reused,
      },
      serverTime: this.clock.now(),
    };
  }
}
