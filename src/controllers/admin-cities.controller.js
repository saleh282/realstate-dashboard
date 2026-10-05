'use strict';

class AdminCitiesController {
  constructor(service) {
    this.service = service;
  }
  options() {
    return this.service.getCityAdminOptions();
  }
  list() {
    return this.service.listCitiesAdmin();
  }
  create(dto, req) {
    return this.service.createCity(dto, req.user.userId, req.ip);
  }
  update(id, dto, req) {
    return this.service.updateCity(id, dto, req.user.userId, req.ip);
  }
  remove(id, req) {
    return this.service.removeCity(id, req.user.userId, req.ip);
  }
}

Object.assign(exports, { AdminCitiesController });
