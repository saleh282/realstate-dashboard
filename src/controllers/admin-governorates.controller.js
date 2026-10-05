'use strict';

class AdminGovernoratesController {
  constructor(service) {
    this.service = service;
  }
  options() {
    return this.service.getAdminOptions();
  }
  list() {
    return this.service.listAdmin();
  }
  create(dto, req) {
    return this.service.create(dto, req.user.userId, req.ip);
  }
  update(id, dto, req) {
    return this.service.update(id, dto, req.user.userId, req.ip);
  }
  remove(id, req) {
    return this.service.remove(id, req.user.userId, req.ip);
  }
}

Object.assign(exports, { AdminGovernoratesController });
