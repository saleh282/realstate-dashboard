import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { CreatePropertyTypeDto } from './dto/create-property-type.dto';
import { UpdatePropertyTypeDto } from './dto/update-property-type.dto';
import { PropertyTypesService } from './property-types.service';

@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/property-types')
export class AdminPropertyTypesController {
  constructor(private readonly service: PropertyTypesService) {}

  @Get('options')
  options() { return this.service.getAdminOptions(); }

  @Get()
  list() { return this.service.listAdmin(); }

  @Post()
  create(@Body() dto: CreatePropertyTypeDto, @Req() req: any) {
    return this.service.create(dto, req.user.userId, req.ip);
  }

  @Patch(':typeId')
  update(@Param('typeId') id: string, @Body() dto: UpdatePropertyTypeDto, @Req() req: any) {
    return this.service.update(id, dto, req.user.userId, req.ip);
  }

  @Delete(':typeId')
  remove(@Param('typeId') id: string, @Req() req: any) {
    return this.service.remove(id, req.user.userId, req.ip);
  }
}
