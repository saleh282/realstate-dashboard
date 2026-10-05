'use strict';

class AdminManagedMarketingController {
  constructor(service) {
    this.service = service;
  }
  packages() {
    return this.service.listPackagesAdmin();
  }
  createPackage(dto, req) {
    return this.service.createPackage(dto, req.user.userId, req.ip);
  }
  updatePackage(id, dto, req) {
    return this.service.updatePackage(id, dto, req.user.userId, req.ip);
  }
  requests(status) {
    return this.service.listRequestsAdmin(status);
  }
  review(id, dto, req) {
    return this.service.review(id, dto, req.user.userId, req.ip);
  }
}

Object.assign(exports, { AdminManagedMarketingController });
