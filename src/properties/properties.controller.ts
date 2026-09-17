import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, Res, StreamableFile, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreatePropertyDto } from './dto/create-property.dto';
import { PropertiesService } from './properties.service';
import { UpdatePropertyVisibilityDto } from './dto/update-property-visibility.dto';
import { EvidenceErrorCode } from '../common/errors/evidence-error-codes';

const allowedImages = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedDeeds = new Set([...allowedImages, 'application/pdf']);

@Controller('properties')
export class PropertiesController {
  constructor(private readonly service: PropertiesService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'images', maxCount: 20 }, { name: 'entranceImage', maxCount: 1 }, { name: 'titleDeed', maxCount: 1 }], {
    limits: { fileSize: 10 * 1024 * 1024, files: 22 },
    fileFilter: (_req, file, cb) => {
      const allowed = file.fieldname === 'titleDeed' ? allowedDeeds : allowedImages;
      return allowed.has(file.mimetype) ? cb(null, true) : cb(new BadRequestException({ message: 'صيغة أحد ملفات العقار غير مدعومة', code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED }), false);
    },
  }))
  create(@Req() req: any, @Body() dto: CreatePropertyDto, @UploadedFiles() files: { images?: Express.Multer.File[]; entranceImage?: Express.Multer.File[]; titleDeed?: Express.Multer.File[] }) {
    return this.service.createSelf(req.user.userId, dto, files, req.ip);
  }

  @Get()
  listPublished(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.service.listPublished({ page: Number(page), limit: Number(limit) });
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  mine(@Req() req: any) { return this.service.listMine(req.user.userId); }

  @Patch('mine/:propertyId/visibility')
  @UseGuards(JwtAuthGuard)
  updateVisibility(@Req() req: any, @Param('propertyId') id: string, @Body() dto: UpdatePropertyVisibilityDto) {
    return this.service.updateOwnerVisibility(req.user.userId, id, dto.isVisible);
  }

  @Get('mine/:propertyId/evidence/title-deed')
  @UseGuards(JwtAuthGuard)
  async getOwnTitleDeed(
    @Req() req: any,
    @Param('propertyId') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const evidence = await this.service.downloadTitleDeedForOwner(req.user.userId, id, req.ip);
    response.set({
      'Content-Type': evidence.contentType,
      'Content-Disposition': 'inline; filename="property-evidence"',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(evidence.buffer);
  }

  @Get(':propertyId')
  @UseGuards(JwtAuthGuard)
  get(@Req() req: any, @Param('propertyId') id: string) { return this.service.getMine(req.user.userId, id); }
}
