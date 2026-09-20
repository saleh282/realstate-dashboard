import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Capability } from '../authorization/capability';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { CapabilityGuard } from '../authorization/capability.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { CreateCityDto } from './dto/create-city.dto';
import { UpdateCityDto } from './dto/update-city.dto';
import { GovernoratesService } from './governorates.service';

@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_CATALOG_MANAGE)
@Controller('admin/cities')
export class AdminCitiesController {
  constructor(private readonly service: GovernoratesService) {}

  @Get('options') options() { return this.service.getCityAdminOptions(); }
  @Get() list() { return this.service.listCitiesAdmin(); }
  @Post() create(@Body() dto: CreateCityDto, @Req() req: any) { return this.service.createCity(dto, req.user.userId, req.ip); }
  @Patch(':cityId') update(@Param('cityId') id: string, @Body() dto: UpdateCityDto, @Req() req: any) { return this.service.updateCity(id, dto, req.user.userId, req.ip); }
  @Delete(':cityId') remove(@Param('cityId') id: string, @Req() req: any) { return this.service.removeCity(id, req.user.userId, req.ip); }
}
