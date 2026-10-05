'use strict';

/**
 * DPF-030: the Attribute Registry, read-only. Keys, data types, units,
 * origins, hard bounds, facets and catalog links are engineering-owned
 * (seed/migration only), so V1 exposes no registry write route.
 */
class AdminPropertyAttributesController {
  constructor(service) {
    this.service = service;
  }
  list() {
    return this.service.listAttributes();
  }
}

Object.assign(exports, { AdminPropertyAttributesController });
