'use strict';

const { NotFoundException } = require('../common/http/errors');
const { StreamableFile } = require('../common/http/binary-response');
class AdminKycController {
  constructor(usersService, cloudinaryAssetService) {
    this.usersService = usersService;
    this.cloudinaryAssetService = cloudinaryAssetService;
  }
  list(query) {
    return this.usersService.listKycForAdmin({
      page: query.page,
      limit: query.limit,
      status: query.status,
      search: query.search?.trim(),
    });
  }
  getDetails(targetUserId) {
    return this.usersService.getKycDetailsForAdmin(targetUserId);
  }
  async getDocument(targetUserId, document, response, req) {
    if (!['id-front', 'id-back', 'selfie'].includes(document)) {
      throw new NotFoundException('مستند التحقق غير موجود');
    }
    const asset = await this.usersService.getKycAssetForAdmin(targetUserId, document);
    const downloaded = await this.cloudinaryAssetService.downloadAuthenticatedAsset(asset);
    await this.usersService.logKycEvidenceAccess?.(req.user.userId, targetUserId, document, req.ip);
    response.set({
      'Content-Type': downloaded.contentType,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(downloaded.buffer);
  }
  review(targetUserId, dto, req) {
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

Object.assign(exports, { AdminKycController });
