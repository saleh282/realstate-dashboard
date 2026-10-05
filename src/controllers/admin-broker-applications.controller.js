'use strict';

const { StreamableFile } = require('../common/http/binary-response');
class AdminBrokerApplicationsController {
  constructor(brokerApplications, assets) {
    this.brokerApplications = brokerApplications;
    this.assets = assets;
  }
  listApplications(status, page, limit) {
    return this.brokerApplications.listApplicationsForAdmin(status, page, limit);
  }
  getApplication(applicationId) {
    return this.brokerApplications.getApplicationForAdmin(applicationId);
  }
  async getDocument(applicationId, documentId, request, response) {
    const asset = await this.brokerApplications.getEvidenceForAdmin(
      request.user.userId,
      applicationId,
      documentId,
      request.ip,
    );
    const downloaded = await this.assets.downloadAuthenticatedAsset(asset);
    response.set({
      'Content-Type': downloaded.contentType,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(downloaded.buffer);
  }
  review(applicationId, dto, request) {
    return this.brokerApplications.reviewApplication({
      applicationId,
      decision: dto.decision,
      reason: dto.reason,
      expectedVersion: dto.expectedVersion,
      actorUserId: request.user.userId,
      ip: request.ip,
    });
  }
  suspend(userId, dto, request) {
    return this.brokerApplications.suspendBroker(
      userId,
      dto.expectedVersion,
      dto.reason.trim(),
      this.actor(request),
    );
  }
  restore(userId, dto, request) {
    return this.brokerApplications.restoreBroker(
      userId,
      dto.expectedVersion,
      dto.reason.trim(),
      this.actor(request),
    );
  }
  revoke(userId, dto, request) {
    return this.brokerApplications.revokeBroker(
      userId,
      dto.expectedVersion,
      dto.reason.trim(),
      this.actor(request),
    );
  }
  actor(request) {
    return { actorUserId: request.user.userId, ip: request.ip };
  }
}

Object.assign(exports, { AdminBrokerApplicationsController });
