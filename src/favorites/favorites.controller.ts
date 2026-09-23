import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';
import { CreateFavoriteDto } from './dto/create-favorite.dto';
import { ListFavoritesDto } from './dto/list-favorites.dto';
import { FavoritesService } from './favorites.service';

@Controller('favorites')
@UseGuards(JwtAuthGuard, CapabilityGuard)
@RequireCapabilities(Capability.FAVORITE_MANAGE_OWN)
export class FavoritesController {
  constructor(private readonly service: FavoritesService) {}

  @Post()
  add(@Req() req: any, @Body() dto: CreateFavoriteDto) {
    return this.service.add(req.user.userId, dto.propertyId);
  }

  @Get()
  list(@Req() req: any, @Query() query: ListFavoritesDto) {
    return this.service.list(req.user.userId, query);
  }

  /** Lightweight full favorited-id set the client caches for instant favorite-state checks. */
  @Get('ids')
  ids(@Req() req: any) {
    return this.service.ids(req.user.userId);
  }

  @Delete(':propertyId')
  remove(@Req() req: any, @Param('propertyId') propertyId: string) {
    return this.service.remove(req.user.userId, propertyId);
  }
}
