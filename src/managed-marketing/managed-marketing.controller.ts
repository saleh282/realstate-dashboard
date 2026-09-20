import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Capability } from '../authorization/capability';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CancelManagedMarketingRequestDto, CreateManagedMarketingRequestDto } from './dto/managed-marketing.dto';
import { ManagedMarketingService } from './managed-marketing.service';

@Controller('managed-marketing')
export class ManagedMarketingController {
  constructor(private service: ManagedMarketingService) {}
  @Get('packages') listPackages() { return this.service.listActivePackages(); }
  @Get('requests/mine') @UseGuards(JwtAuthGuard, CapabilityGuard) @RequireCapabilities(Capability.MANAGED_MARKETING_REQUEST)
  mine(@Req() req: any) { return this.service.listMine(req.user.userId); }
  @Post('requests') @UseGuards(JwtAuthGuard, CapabilityGuard) @RequireCapabilities(Capability.MANAGED_MARKETING_REQUEST)
  create(@Req() req: any, @Body() dto: CreateManagedMarketingRequestDto) { return this.service.createRequest(req.user.userId, dto, req.ip); }
  @Patch('requests/:requestId/cancel') @UseGuards(JwtAuthGuard, CapabilityGuard) @RequireCapabilities(Capability.MANAGED_MARKETING_REQUEST)
  cancel(@Req() req: any, @Param('requestId') id: string, @Body() dto: CancelManagedMarketingRequestDto) { return this.service.cancel(req.user.userId, id, dto.reason, req.ip); }
}
