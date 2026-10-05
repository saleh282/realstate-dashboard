'use strict';

class GovernoratesController {
  constructor(service) {
    this.service = service;
  }
  list() {
    return this.service.listPublic();
  }
}

Object.assign(exports, { GovernoratesController });
