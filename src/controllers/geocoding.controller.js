'use strict';

class GeocodingController {
  constructor(service) {
    this.service = service;
  }
  reverse(query) {
    return this.service.reverse(query.latitude, query.longitude, query.language);
  }
  // The map picker searches as the user types (debounced), so allow a few
  // more calls than an explicit search button would need.
  search(query) {
    return this.service.search(query.query, query.language);
  }
}

Object.assign(exports, { GeocodingController });
