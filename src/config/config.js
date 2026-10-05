'use strict';

class ConfigService {
  constructor(values = process.env) {
    this.values = values;
  }
  get(key, fallback) {
    return this.values[key] ?? fallback;
  }
  getOrThrow(key) {
    const value = this.get(key);
    if (value === undefined) throw new Error(`Missing configuration: ${key}`);
    return value;
  }
}
module.exports = { ConfigService };
