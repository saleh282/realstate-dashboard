'use strict';

class AdminLegalDocumentsController {
  constructor(service) {
    this.service = service;
  }
  list(query) {
    return this.service.listAdmin(query.type);
  }
  get(id) {
    return this.service.getAdmin(id);
  }
  create(dto, req) {
    return this.service.createDraft(dto, req.user.userId, req.ip);
  }
  update(id, dto, req) {
    return this.service.updateDraft(id, dto, req.user.userId, req.ip);
  }
  publish(id, req) {
    return this.service.publish(id, req.user.userId, req.ip);
  }
}

Object.assign(exports, { AdminLegalDocumentsController });
