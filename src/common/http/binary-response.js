'use strict';

// Binary responses bypass the JSON API envelope.
class StreamableFile {
  constructor(body, options = {}) {
    this.body = body;
    this.options = options;
  }
  getStream() {
    return Buffer.isBuffer(this.body) ? require('node:stream').Readable.from(this.body) : this.body;
  }
}
module.exports = { StreamableFile };
