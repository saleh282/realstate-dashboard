import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { CreatePropertyPurposeCategoryDto } from './dto/create-property-purpose-category.dto';
import { UpdatePropertyPurposeCategoryDto } from './dto/update-property-purpose-category.dto';
import { PropertyPurposeCategoriesService } from './property-purpose-categories.service';

@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/property-purpose-categories')
export class AdminPropertyPurposeCategoriesController {
  constructor(private readonly service: PropertyPurposeCategoriesService) {}
  @Get() list() { return this.service.listAdmin(); }
  @Post() create(@Body() dto: CreatePropertyPurposeCategoryDto, @Req() req: any) { return this.service.create(dto, req.user.userId, req.ip); }
  @Patch(':categoryId') update(@Param('categoryId') id: string, @Body() dto: UpdatePropertyPurposeCategoryDto, @Req() req: any) { return this.service.update(id, dto, req.user.userId, req.ip); }
}
