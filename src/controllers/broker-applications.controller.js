'use strict';

const { StreamableFile } = require('../common/http/binary-response');
class BrokerApplicationsController {
  constructor(brokerApplications, assets) {
    this.brokerApplications = brokerApplications;
    this.assets = assets;
  }
  submit(request, files, idempotencyKey) {
    return this.brokerApplications.submitApplication(
      request.user.userId,
      files?.verificationDocument ?? [],
      idempotencyKey,
      request.ip,
    );
  }
  ownHistory(request) {
    return this.brokerApplications.listOwnApplications(request.user.userId);
  }
  async download(asset, response) {
    const downloaded = await this.assets.downloadAuthenticatedAsset(asset);
    response.set({
      'Content-Type': downloaded.contentType,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(downloaded.buffer);
  }
}

Object.assign(exports, { BrokerApplicationsController });
