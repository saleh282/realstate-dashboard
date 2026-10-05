'use strict';

class AdminPropertyPurposeCategoriesController {
  constructor(service) {
    this.service = service;
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
}

Object.assign(exports, { AdminPropertyPurposeCategoriesController });
