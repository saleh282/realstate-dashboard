'use strict';

const { BadRequestException } = require('../common/http/errors');
const { StreamableFile } = require('../common/http/binary-response');
const { EvidenceErrorCode } = require('../common/errors/evidence-error-codes');
const { PropertyLifecycleStatus } = require('../domain/properties/property.types');
const allowedImages = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedDeeds = new Set([...allowedImages, 'application/pdf']);
class PropertiesController {
  constructor(service) {
    this.service = service;
  }
  create(req, dto, files, idempotencyKey) {
    return this.service.createSelf(req.user.userId, dto, files, req.ip, idempotencyKey);
  }
  createRevision(req, id, dto, files, idempotencyKey) {
    return this.service.createDraftRevision(
      req.user.userId,
      id,
      dto,
      files,
      req.ip,
      idempotencyKey,
    );
  }
  listPublished(query) {
    return this.service.listPublished(query);
  }
  /** Phase 9 (Search & Facets): must be registered before `:propertyId` so it never gets swallowed by that route. */
  getFilterMetadata(query) {
    return this.service.getFilterMetadata(query);
  }
  mine(req, page, limit) {
    return this.service.listMine(req.user.userId, { page: Number(page), limit: Number(limit) });
  }
  getMine(req, id) {
    return this.service.getMine(req.user.userId, id);
  }
  updateVisibility(req, id, dto) {
    return this.service.updateLifecycle(
      req.user.userId,
      id,
      dto.isVisible ? PropertyLifecycleStatus.ACTIVE : PropertyLifecycleStatus.ARCHIVED,
      dto.version,
      req.ip,
    );
  }
  submitRevision(req, id, dto, idempotencyKey) {
    return this.service.submitRevision(
      req.user.userId,
      id,
      dto.revisionId,
      dto.version,
      req.ip,
      idempotencyKey,
    );
  }
  async getOwnTitleDeed(req, id, response) {
    const evidence = await this.service.downloadTitleDeedForOwner(req.user.userId, id, req.ip);
    response.set({
      'Content-Type': evidence.contentType,
      'Content-Disposition': 'inline; filename="property-evidence"',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(evidence.buffer);
  }
  async getOwnPrivateEvidence(req, id, revisionId, rawIndex, response) {
    if (!/^\d+$/.test(rawIndex))
      throw new BadRequestException({
        message: 'معرّف ملف الإثبات غير صالح',
        code: EvidenceErrorCode.NOT_FOUND,
      });
    const evidence = await this.service.downloadPrivateEvidenceForOwner(
      req.user.userId,
      id,
      revisionId,
      Number(rawIndex),
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
  getPublished(id) {
    return this.service.getPublished(id);
  }
}

Object.assign(exports, { PropertiesController });
