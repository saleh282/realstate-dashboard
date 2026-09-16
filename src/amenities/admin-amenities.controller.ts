import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { AmenitiesService } from './amenities.service';
import { CreateAmenityDto } from './dto/create-amenity.dto';
import { UpdateAmenityDto } from './dto/update-amenity.dto';

@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/amenities')
export class AdminAmenitiesController {
  constructor(private readonly service: AmenitiesService) {}
  @Get('options') options() { return this.service.getAdminOptions(); }
  @Get() list() { return this.service.listAdmin(); }
  @Post() create(@Body() dto: CreateAmenityDto, @Req() req: any) { return this.service.create(dto, req.user.userId, req.ip); }
  @Patch(':amenityId') update(@Param('amenityId') id: string, @Body() dto: UpdateAmenityDto, @Req() req: any) { return this.service.update(id, dto, req.user.userId, req.ip); }
  @Delete(':amenityId') remove(@Param('amenityId') id: string, @Req() req: any) { return this.service.remove(id, req.user.userId, req.ip); }
}
