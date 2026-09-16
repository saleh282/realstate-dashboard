import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { SystemRole } from '../auth/roles.enum';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReviewPropertyDto } from './dto/review-property.dto';
import { PropertiesService } from './properties.service';

@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/properties')
export class AdminPropertiesController {
  constructor(private readonly service: PropertiesService) {}

  @Get()
  list(@Query('page') page?: string, @Query('limit') limit?: string, @Query('status') status?: string, @Query('search') search?: string) {
    return this.service.listForAdmin({ page: Number(page), limit: Number(limit), status, search });
  }

  @Get(':propertyId')
  get(@Param('propertyId') id: string) { return this.service.getForAdmin(id); }

  @Patch(':propertyId/status')
  review(@Param('propertyId') id: string, @Body() dto: ReviewPropertyDto, @Req() req: any) {
    return this.service.reviewForAdmin(id, dto.status, dto.reason, req.user.userId, req.ip);
  }
}
