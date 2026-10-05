'use strict';

const jwt = require('jsonwebtoken');
class JwtService {
  constructor(defaults = {}) {
    this.defaults = defaults;
  }
  sign(payload, options = {}) {
    const { secret = this.defaults.secret, ...settings } = options;
    return jwt.sign(payload, secret, { ...this.defaults.signOptions, ...settings });
  }
  verify(token, options = {}) {
    const { secret = this.defaults.secret, ...settings } = options;
    return jwt.verify(token, secret, {
      algorithms: ['HS256'],
      ...this.defaults.verifyOptions,
      ...settings,
    });
  }
  decode(token, options) {
    return jwt.decode(token, options);
  }
  async signAsync(payload, options) {
    return this.sign(payload, options);
  }
  async verifyAsync(token, options) {
    return this.verify(token, options);
  }
}
module.exports = { JwtService };
