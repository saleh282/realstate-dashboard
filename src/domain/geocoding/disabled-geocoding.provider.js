'use strict';

const { ServiceUnavailableException } = require('../../common/http/errors');
/** Selected with GEOCODING_PROVIDER=disabled: address lookup is switched off. */
class DisabledGeocodingProvider {
  unavailable() {
    throw new ServiceUnavailableException({ message: 'خدمة تحديد العنوان غير مفعلة' });
  }
  async reverse() {
    return this.unavailable();
  }
  async search() {
    return this.unavailable();
  }
}

Object.assign(exports, { DisabledGeocodingProvider });
