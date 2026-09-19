import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, StreamableFile, UploadedFile, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { SystemRole } from '../auth/roles.enum';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminPropertyMediaDto, ReviewPropertyDto, UpdateAdminPropertyMediaDto, UpdatePropertyLifecycleDto } from './dto/review-property.dto';
import { PropertyLifecycleStatus } from './property.types';
import { PropertiesService } from './properties.service';
import { AdminCreatePropertyDto, CreatePropertyDto } from './dto/create-property.dto';
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
  @UseInterceptors(FileFieldsInterceptor([{ name: 'images', maxCount: 20 }, { name: 'titleDeed', maxCount: 1 }], {
    limits: { fileSize: 10 * 1024 * 1024, files: 22 },
    fileFilter: (_req, file, cb) => {
      const allowed = file.fieldname === 'titleDeed' ? allowedEvidence : allowedImages;
      return allowed.has(file.mimetype) ? cb(null, true) : cb(new BadRequestException({ message: 'صيغة أحد ملفات العقار غير مدعومة', code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED }), false);
    },
  }))
  createForAccount(
    @Req() req: any,
    @Body() dto: AdminCreatePropertyDto,
    @UploadedFiles() files: { images?: Express.Multer.File[]; titleDeed?: Express.Multer.File[] },
  ) {
    const { advertiserAccountId, ...propertyDto } = dto;
    return this.service.createForAdmin(req.user.userId, advertiserAccountId, propertyDto as AdminCreatePropertyDto, files, req.ip);
  }

  @Post(':propertyId/revisions/proxy')
  @RequireCapabilities(Capability.ADMIN_PROPERTY_PROXY_CREATE)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'images', maxCount: 20 }, { name: 'titleDeed', maxCount: 1 }], {
    limits: { fileSize: 10 * 1024 * 1024, files: 22 },
    fileFilter: (_req, file, cb) => {
      const allowed = file.fieldname === 'titleDeed' ? allowedEvidence : allowedImages;
      return allowed.has(file.mimetype) ? cb(null, true) : cb(new BadRequestException({ message: 'صيغة أحد ملفات العقار غير مدعومة', code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED }), false);
    },
  }))
  createRevisionForAccount(@Param('propertyId') id: string, @Req() req: any, @Body() dto: CreatePropertyDto, @UploadedFiles() files: { images?: Express.Multer.File[]; titleDeed?: Express.Multer.File[] }) {
    return this.service.createDraftRevisionForAdmin(req.user.userId, id, dto, files, req.ip);
  }

  @Get(':propertyId')
  get(@Param('propertyId') id: string) { return this.service.getForAdmin(id); }

  @Post(':propertyId/revisions/:revisionId/media')
  @UseInterceptors(FileInterceptor('image', {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => allowedImages.has(file.mimetype)
      ? cb(null, true)
      : cb(new BadRequestException({ message: 'صيغة صورة العقار غير مدعومة', code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED }), false),
  }))
  addPlatformMedia(@Param('propertyId') propertyId: string, @Param('revisionId') revisionId: string, @Body() dto: AdminPropertyMediaDto, @UploadedFile() image: Express.Multer.File, @Req() req: any) {
    return this.service.addPlatformMediaForAdmin(propertyId, revisionId, dto.tagCode, dto.version, image, req.user.userId, req.ip);
  }

  @Put(':propertyId/revisions/:revisionId/media/:mediaId')
  @UseInterceptors(FileInterceptor('image', {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => allowedImages.has(file.mimetype)
      ? cb(null, true)
      : cb(new BadRequestException({ message: 'صيغة صورة العقار غير مدعومة', code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED }), false),
  }))
  replacePlatformMedia(@Param('propertyId') propertyId: string, @Param('revisionId') revisionId: string, @Param('mediaId') mediaId: string, @Body() dto: AdminPropertyMediaDto, @UploadedFile() image: Express.Multer.File, @Req() req: any) {
    return this.service.replacePlatformMediaForAdmin(propertyId, revisionId, mediaId, dto.tagCode, dto.version, image, req.user.userId, req.ip);
  }

  @Patch(':propertyId/revisions/:revisionId/media/:mediaId')
  updatePlatformMedia(@Param('propertyId') propertyId: string, @Param('revisionId') revisionId: string, @Param('mediaId') mediaId: string, @Body() dto: UpdateAdminPropertyMediaDto, @Req() req: any) {
    return this.service.updatePlatformMediaForAdmin(propertyId, revisionId, mediaId, dto, req.user.userId, req.ip);
  }

  @Delete(':propertyId/revisions/:revisionId/media/:mediaId')
  removePlatformMedia(@Param('propertyId') propertyId: string, @Param('revisionId') revisionId: string, @Param('mediaId') mediaId: string, @Body() dto: UpdateAdminPropertyMediaDto, @Req() req: any) {
    return this.service.removePlatformMediaForAdmin(propertyId, revisionId, mediaId, dto.version, req.user.userId, req.ip);
  }

  @Get(':propertyId/revisions/:revisionId/media/:mediaId')
  async getPlatformMedia(@Param('propertyId') propertyId: string, @Param('revisionId') revisionId: string, @Param('mediaId') mediaId: string, @Req() req: any, @Res({ passthrough: true }) response: Response) {
    const media = await this.service.downloadPublicMediaForAdmin(propertyId, revisionId, mediaId, req.user.userId, req.ip);
    response.set({
      'Content-Type': media.contentType,
      'Content-Disposition': 'inline; filename="property-photo"',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(media.buffer);
  }

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

  @Get(':propertyId/revisions/:revisionId/evidence/:evidenceIndex')
  async getPrivateEvidence(
    @Param('propertyId') id: string,
    @Param('revisionId') revisionId: string,
    @Param('evidenceIndex') rawIndex: string,
    @Req() req: any,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!/^\d+$/.test(rawIndex)) throw new BadRequestException({ message: 'معرّف ملف الإثبات غير صالح', code: EvidenceErrorCode.NOT_FOUND });
    const evidence = await this.service.downloadPrivateEvidenceForAdmin(id, revisionId, Number(rawIndex), req.user.userId, req.ip);
    response.set({
      'Content-Type': evidence.contentType,
      'Content-Disposition': 'inline; filename="property-evidence"',
      'Cache-Control': 'private, no-store, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(evidence.buffer);
  }

  @Patch(':propertyId/status')
  review(@Param('propertyId') id: string, @Body() dto: ReviewPropertyDto, @Req() req: any) {
    return this.service.reviewForAdmin(id, dto.revisionId, dto.version, dto.status, dto.reason, req.user.userId, req.ip);
  }

  @Patch(':propertyId/revisions/:revisionId/review')
  reviewRevision(@Param('propertyId') id: string, @Param('revisionId') revisionId: string, @Body() dto: ReviewPropertyDto, @Req() req: any) {
    if (dto.revisionId !== revisionId) throw new BadRequestException({ message: 'معرّف النسخة غير متطابق', code: 'PROPERTY_STATE_CONFLICT' });
    return this.service.reviewForAdmin(id, revisionId, dto.version, dto.status, dto.reason, req.user.userId, req.ip);
  }

  @Patch(':propertyId/lifecycle')
  updateLifecycle(@Param('propertyId') id: string, @Body() dto: UpdatePropertyLifecycleDto, @Req() req: any) {
    if (dto.status === 'archived') throw new BadRequestException({ message: 'الإيقاف العادي ينفذه المعلن', code: 'PROPERTY_STATE_CONFLICT' });
    return this.service.forceLifecycleForAdmin(id, dto.status as PropertyLifecycleStatus.ACTIVE | PropertyLifecycleStatus.ADMIN_HIDDEN, dto.version, dto.reason, req.user.userId, req.ip);
  }
}
