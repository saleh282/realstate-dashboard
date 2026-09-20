import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Capability } from '../authorization/capability';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SystemRole } from '../auth/roles.enum';
import { CreateManagedMarketingPackageDto, ReviewManagedMarketingRequestDto, UpdateManagedMarketingPackageDto } from './dto/managed-marketing.dto';
import { ManagedMarketingService } from './managed-marketing.service';

@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_MANAGED_MARKETING_MANAGE)
@Controller('admin/managed-marketing')
export class AdminManagedMarketingController {
  constructor(private service: ManagedMarketingService) {}
  @Get('packages') packages() { return this.service.listPackagesAdmin(); }
  @Post('packages') createPackage(@Body() dto: CreateManagedMarketingPackageDto, @Req() req: any) { return this.service.createPackage(dto, req.user.userId, req.ip); }
  @Patch('packages/:packageId') updatePackage(@Param('packageId') id: string, @Body() dto: UpdateManagedMarketingPackageDto, @Req() req: any) { return this.service.updatePackage(id, dto, req.user.userId, req.ip); }
  @Get('requests') requests(@Query('status') status?: string) { return this.service.listRequestsAdmin(status); }
  @Patch('requests/:requestId/review') review(@Param('requestId') id: string, @Body() dto: ReviewManagedMarketingRequestDto, @Req() req: any) { return this.service.review(id, dto, req.user.userId, req.ip); }
}
