'use strict';

const { BadRequestException } = require('../common/http/errors');
const { StreamableFile } = require('../common/http/binary-response');
const { EvidenceErrorCode } = require('../common/errors/evidence-error-codes');
const allowedImages = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedEvidence = new Set([...allowedImages, 'application/pdf']);
class AdminPropertiesController {
  constructor(service) {
    this.service = service;
  }
  list(page, limit, status, search) {
    return this.service.listForAdmin({ page: Number(page), limit: Number(limit), status, search });
  }
  createForAccount(req, dto, files) {
    const { advertiserAccountId, ...propertyDto } = dto;
    return this.service.createForAdmin(
      req.user.userId,
      advertiserAccountId,
      propertyDto,
      files,
      req.ip,
    );
  }
  createRevisionForAccount(id, req, dto, files) {
    return this.service.createDraftRevisionForAdmin(req.user.userId, id, dto, files, req.ip);
  }
  get(id) {
    return this.service.getForAdmin(id);
  }
  addPlatformMedia(propertyId, revisionId, dto, image, req) {
    return this.service.addPlatformMediaForAdmin(
      propertyId,
      revisionId,
      dto.tagCode,
      dto.version,
      image,
      req.user.userId,
      req.ip,
    );
  }
  replacePlatformMedia(propertyId, revisionId, mediaId, dto, image, req) {
    return this.service.replacePlatformMediaForAdmin(
      propertyId,
      revisionId,
      mediaId,
      dto.tagCode,
      dto.version,
      image,
      req.user.userId,
      req.ip,
    );
  }
  updatePlatformMedia(propertyId, revisionId, mediaId, dto, req) {
    return this.service.updatePlatformMediaForAdmin(
      propertyId,
      revisionId,
      mediaId,
      dto,
      req.user.userId,
      req.ip,
    );
  }
  removePlatformMedia(propertyId, revisionId, mediaId, dto, req) {
    return this.service.removePlatformMediaForAdmin(
      propertyId,
      revisionId,
      mediaId,
      dto.version,
      req.user.userId,
      req.ip,
    );
  }
  async getPlatformMedia(propertyId, revisionId, mediaId, req, response) {
    const media = await this.service.downloadPublicMediaForAdmin(
      propertyId,
      revisionId,
      mediaId,
      req.user.userId,
      req.ip,
    );
    response.set({
      'Content-Type': media.contentType,
      'Content-Disposition': 'inline; filename="property-photo"',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(media.buffer);
  }
  async getTitleDeed(id, req, response) {
    const evidence = await this.service.downloadTitleDeedForAdmin(id, req.user.userId, req.ip);
    response.set({
      'Content-Type': evidence.contentType,
      'Content-Disposition': 'inline; filename="property-evidence"',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(evidence.buffer);
  }
  async getPrivateEvidence(id, revisionId, rawIndex, req, response) {
    if (!/^\d+$/.test(rawIndex))
      throw new BadRequestException({
        message: 'معرّف ملف الإثبات غير صالح',
        code: EvidenceErrorCode.NOT_FOUND,
      });
    const evidence = await this.service.downloadPrivateEvidenceForAdmin(
      id,
      revisionId,
      Number(rawIndex),
      req.user.userId,
      req.ip,
    );
    response.set({
      'Content-Type': evidence.contentType,
      'Content-Disposition': 'inline; filename="property-evidence"',
      'Cache-Control': 'private, no-store, max-age=0',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(evidence.buffer);
  }
  review(id, dto, req) {
    return this.service.reviewForAdmin(
      id,
      dto.revisionId,
      dto.version,
      dto.status,
      dto.reason,
      req.user.userId,
      req.ip,
    );
  }
  reviewRevision(id, revisionId, dto, req) {
    if (dto.revisionId !== revisionId)
      throw new BadRequestException({
        message: 'معرّف النسخة غير متطابق',
        code: 'PROPERTY_STATE_CONFLICT',
      });
    return this.service.reviewForAdmin(
      id,
      revisionId,
      dto.version,
      dto.status,
      dto.reason,
      req.user.userId,
      req.ip,
    );
  }
  updateLifecycle(id, dto, req) {
    if (dto.status === 'archived')
      throw new BadRequestException({
        message: 'الإيقاف العادي ينفذه المعلن',
        code: 'PROPERTY_STATE_CONFLICT',
      });
    return this.service.forceLifecycleForAdmin(
      id,
      dto.status,
      dto.version,
      dto.reason,
      req.user.userId,
      req.ip,
    );
  }
}

Object.assign(exports, { AdminPropertiesController });
