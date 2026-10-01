import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { FakePaymentsDevGuard } from './fake-payments-dev.guard';
import { FakePaymentsDevService } from './fake-payments-dev.service';

export class SettleFakePaymentDto {
  @IsIn(['success', 'failed']) outcome: 'success' | 'failed';
  /** Also poke the normal confirmation-by-reference path (what a provider callback would do). Never an outcome. */
  @IsOptional() @IsBoolean() trigger?: boolean;
}

/**
 * DEVELOPMENT ONLY (MAZAD-028): `POST /dev/fake-payments/:paymentId/settle`.
 *
 * Simulates the customer finishing a `pending` FakePaymentProvider checkout.
 * `FakePaymentsDevGuard` runs first and answers 404 unless this is a
 * local/development process running the fake provider, so the route does not
 * exist in staging/production (where the fake provider cannot even be built).
 * Authenticated and owner-scoped; it changes provider truth only and can never
 * grant an entitlement or mark anything paid.
 */
@Controller('dev/fake-payments')
@UseGuards(FakePaymentsDevGuard, JwtAuthGuard)
export class FakePaymentsDevController {
  constructor(private readonly settlement: FakePaymentsDevService) {}

  @Post(':paymentId/settle')
  @HttpCode(200)
  settle(@Req() req: any, @Param('paymentId') paymentId: string, @Body() body: SettleFakePaymentDto) {
    return this.settlement.settle(req.user.userId, paymentId, body.outcome, body.trigger === true);
  }
}
