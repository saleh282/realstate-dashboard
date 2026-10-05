'use strict';

class PropertyPurposeCategoriesController {
  constructor(service) {
    this.service = service;
  }
  list() {
    return this.service.listPublic();
  }
}

Object.assign(exports, { PropertyPurposeCategoriesController });
