import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, Res, StreamableFile, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreatePropertyDto } from './dto/create-property.dto';
import { PropertiesService } from './properties.service';
import { UpdatePropertyVisibilityDto } from './dto/update-property-visibility.dto';
import { SubmitPropertyRevisionDto } from './dto/review-property.dto';
import { EvidenceErrorCode } from '../common/errors/evidence-error-codes';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';
import { PropertyLifecycleStatus } from './property.types';

const allowedImages = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedDeeds = new Set([...allowedImages, 'application/pdf']);

@Controller('properties')
export class PropertiesController {
  constructor(private readonly service: PropertiesService) {}

  @Post()
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapabilities(Capability.PROPERTY_CREATE)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'images', maxCount: 20 }, { name: 'titleDeed', maxCount: 1 }], {
    limits: { fileSize: 10 * 1024 * 1024, files: 22 },
    fileFilter: (_req, file, cb) => {
      const allowed = file.fieldname === 'titleDeed' ? allowedDeeds : allowedImages;
      return allowed.has(file.mimetype) ? cb(null, true) : cb(new BadRequestException({ message: 'صيغة أحد ملفات العقار غير مدعومة', code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED }), false);
    },
  }))
  create(@Req() req: any, @Body() dto: CreatePropertyDto, @UploadedFiles() files: { images?: Express.Multer.File[]; titleDeed?: Express.Multer.File[] }) {
    return this.service.createSelf(req.user.userId, dto, files, req.ip);
  }

  @Post('mine/:propertyId/revisions')
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapabilities(Capability.PROPERTY_MANAGE_OWN)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'images', maxCount: 20 }, { name: 'titleDeed', maxCount: 1 }], {
    limits: { fileSize: 10 * 1024 * 1024, files: 22 },
    fileFilter: (_req, file, cb) => {
      const allowed = file.fieldname === 'titleDeed' ? allowedDeeds : allowedImages;
      return allowed.has(file.mimetype) ? cb(null, true) : cb(new BadRequestException({ message: 'صيغة أحد ملفات العقار غير مدعومة', code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED }), false);
    },
  }))
  createRevision(@Req() req: any, @Param('propertyId') id: string, @Body() dto: CreatePropertyDto, @UploadedFiles() files: { images?: Express.Multer.File[]; titleDeed?: Express.Multer.File[] }) {
    return this.service.createDraftRevision(req.user.userId, id, dto, files, req.ip);
  }

  @Get()
  listPublished(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.service.listPublished({ page: Number(page), limit: Number(limit) });
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapabilities(Capability.PROPERTY_READ_OWN)
  mine(@Req() req: any) { return this.service.listMine(req.user.userId); }

  @Patch('mine/:propertyId/visibility')
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapabilities(Capability.PROPERTY_MANAGE_OWN)
  updateVisibility(@Req() req: any, @Param('propertyId') id: string, @Body() dto: UpdatePropertyVisibilityDto) {
    return this.service.updateLifecycle(req.user.userId, id, dto.isVisible ? PropertyLifecycleStatus.ACTIVE : PropertyLifecycleStatus.ARCHIVED, dto.version, req.ip);
  }

  @Post('mine/:propertyId/revisions/submit')
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapabilities(Capability.PROPERTY_MANAGE_OWN)
  submitRevision(@Req() req: any, @Param('propertyId') id: string, @Body() dto: SubmitPropertyRevisionDto) {
    return this.service.submitRevision(req.user.userId, id, dto.revisionId, dto.version, req.ip);
  }

  @Get('mine/:propertyId/evidence/title-deed')
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapabilities(Capability.PROPERTY_READ_OWN)
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

  @Get('mine/:propertyId/revisions/:revisionId/evidence/:evidenceIndex')
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapabilities(Capability.PROPERTY_READ_OWN)
  async getOwnPrivateEvidence(
    @Req() req: any,
    @Param('propertyId') id: string,
    @Param('revisionId') revisionId: string,
    @Param('evidenceIndex') rawIndex: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!/^\d+$/.test(rawIndex)) throw new BadRequestException({ message: 'معرّف ملف الإثبات غير صالح', code: EvidenceErrorCode.NOT_FOUND });
    const evidence = await this.service.downloadPrivateEvidenceForOwner(req.user.userId, id, revisionId, Number(rawIndex), req.ip);
    response.set({
      'Content-Type': evidence.contentType,
      'Content-Disposition': 'inline; filename="property-evidence"',
      'Cache-Control': 'private, no-store, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(evidence.buffer);
  }

  @Get(':propertyId')
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapabilities(Capability.PROPERTY_READ_OWN)
  get(@Req() req: any, @Param('propertyId') id: string) { return this.service.getMine(req.user.userId, id); }
}
