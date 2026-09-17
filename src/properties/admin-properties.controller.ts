import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, Res, StreamableFile, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { SystemRole } from '../auth/roles.enum';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReviewPropertyDto } from './dto/review-property.dto';
import { PropertiesService } from './properties.service';
import { AdminCreatePropertyDto } from './dto/create-property.dto';
import { EvidenceErrorCode } from '../common/errors/evidence-error-codes';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';

const allowedImages = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedEvidence = new Set([...allowedImages, 'application/pdf']);

@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_PROPERTY_REVIEW)
@Controller('admin/properties')
export class AdminPropertiesController {
  constructor(private readonly service: PropertiesService) {}

  @Get()
  list(@Query('page') page?: string, @Query('limit') limit?: string, @Query('status') status?: string, @Query('search') search?: string) {
    return this.service.listForAdmin({ page: Number(page), limit: Number(limit), status, search });
  }

  @Post('proxy')
  @RequireCapabilities(Capability.ADMIN_PROPERTY_PROXY_CREATE)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'images', maxCount: 20 }, { name: 'entranceImage', maxCount: 1 }, { name: 'titleDeed', maxCount: 1 }], {
    limits: { fileSize: 10 * 1024 * 1024, files: 22 },
    fileFilter: (_req, file, cb) => {
      const allowed = file.fieldname === 'titleDeed' ? allowedEvidence : allowedImages;
      return allowed.has(file.mimetype) ? cb(null, true) : cb(new BadRequestException({ message: 'صيغة أحد ملفات العقار غير مدعومة', code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED }), false);
    },
  }))
  createForAccount(
    @Req() req: any,
    @Body() dto: AdminCreatePropertyDto,
    @UploadedFiles() files: { images?: Express.Multer.File[]; entranceImage?: Express.Multer.File[]; titleDeed?: Express.Multer.File[] },
  ) {
    const { advertiserAccountId, ...propertyDto } = dto;
    return this.service.createForAdmin(req.user.userId, advertiserAccountId, propertyDto as AdminCreatePropertyDto, files, req.ip);
  }

  @Get(':propertyId')
  get(@Param('propertyId') id: string) { return this.service.getForAdmin(id); }

  @Get(':propertyId/evidence/title-deed')
  async getTitleDeed(
    @Param('propertyId') id: string,
    @Req() req: any,
    @Res({ passthrough: true }) response: Response,
  ) {
    const evidence = await this.service.downloadTitleDeedForAdmin(id, req.user.userId, req.ip);
    response.set({
      'Content-Type': evidence.contentType,
      'Content-Disposition': 'inline; filename="property-evidence"',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(evidence.buffer);
  }

  @Patch(':propertyId/status')
  review(@Param('propertyId') id: string, @Body() dto: ReviewPropertyDto, @Req() req: any) {
    return this.service.reviewForAdmin(id, dto.status, dto.reason, req.user.userId, req.ip);
  }
}
