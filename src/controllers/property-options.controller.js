'use strict';

class PropertyOptionsController {
  constructor(service) {
    this.service = service;
  }
  list() {
    return this.service.listPublic();
  }
}

Object.assign(exports, { PropertyOptionsController });
