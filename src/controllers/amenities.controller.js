'use strict';

class AmenitiesController {
  constructor(service) {
    this.service = service;
  }
  list() {
    return this.service.listPublic();
  }
}

Object.assign(exports, { AmenitiesController });
