'use strict';

const allowedKycMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
class KycController {
  constructor(kycService) {
    this.kycService = kycService;
  }
  submit(req, files) {
    return this.kycService.submit(req.user.userId, files);
  }
  getStatus(req) {
    return this.kycService.getStatus(req.user.userId);
  }
}

Object.assign(exports, { KycController });
