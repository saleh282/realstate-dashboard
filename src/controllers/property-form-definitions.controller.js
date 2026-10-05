'use strict';

/** Public, read-only form definition reads (DPF-015). No write endpoints in this phase. */
class PropertyFormDefinitionsController {
  constructor(service) {
    this.service = service;
  }
  /**
   * An immutable published/superseded version. The ETag is its content hash;
   * Express answers a matching `If-None-Match` with 304.
   */
  async getVersion(versionId, response) {
    const version = await this.service.getPublicVersion(versionId);
    response.setHeader('ETag', `"${version.contentHash}"`);
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return version;
  }
}

Object.assign(exports, { PropertyFormDefinitionsController });
