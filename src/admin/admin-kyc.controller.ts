import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { UsersService } from '../users/users.service';
import { ListKycQueryDto } from './dto/list-kyc-query.dto';
import { AdminReviewKycDto } from './dto/admin-review-kyc.dto';
import { CloudinaryAssetService } from '../config/cloudinary-asset.service';

@Roles(UserRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/kyc')
export class AdminKycController {
  constructor(
    private readonly usersService: UsersService,
    private readonly cloudinaryAssetService: CloudinaryAssetService,
  ) {}

  @Get()
  list(@Query() query: ListKycQueryDto) {
    return this.usersService.listKycForAdmin({
      page: query.page,
      limit: query.limit,
      status: query.status,
      search: query.search?.trim(),
    });
  }

  @Get(':userId')
  getDetails(@Param('userId') targetUserId: string) {
    return this.usersService.getKycDetailsForAdmin(targetUserId);
  }

  @Get(':userId/documents/:document')
  async getDocument(
    @Param('userId') targetUserId: string,
    @Param('document') document: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!['id-front', 'id-back', 'selfie'].includes(document)) {
      throw new NotFoundException('مستند التحقق غير موجود');
    }
    const asset = await this.usersService.getKycAssetForAdmin(
      targetUserId,
      document as 'id-front' | 'id-back' | 'selfie',
    );
    const downloaded =
      await this.cloudinaryAssetService.downloadAuthenticatedAsset(asset);

    response.set({
      'Content-Type': downloaded.contentType,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(downloaded.buffer);
  }

  @Post(':userId/review')
  review(
    @Param('userId') targetUserId: string,
    @Body() dto: AdminReviewKycDto,
    @Req() req: any,
  ) {
    return this.usersService.reviewKycForAdmin({
      actorUserId: req.user.userId,
      targetUserId,
      decision: dto.decision,
      rejectionReason: dto.rejectionReason,
      expectedVersion: dto.version,
      ip: req.ip,
    });
  }
}
