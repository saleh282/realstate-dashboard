'use strict';
const multer = require('multer');
const { getUploadBudget } = require('../common/uploads/upload-budget');
const ticketsByRequest = new WeakMap();
class BudgetedMemoryStorage {
  _handleFile(request, file, callback) {
    const ticket = ticketsByRequest.get(request);
    const chunks = [];
    let size = 0;
    let finished = false;
    const fail = (error) => {
      if (finished) return;
      finished = true;
      ticket?.unreserve(size);
      chunks.length = 0;
      size = 0;
      callback(error);
    };
    file.stream.on('data', (chunk) => {
      if (finished) return;
      try {
        ticket?.reserve(chunk.length);
      } catch (error) {
        fail(error);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    file.stream.once('error', fail);
    file.stream.once('end', () => {
      if (finished) return;
      finished = true;
      callback(null, { buffer: Buffer.concat(chunks), size });
    });
  }
  _removeFile(request, file, callback) {
    ticketsByRequest.get(request)?.unreserve(file.size ?? 0);
    delete file.buffer;
    callback(null);
  }
}

function bound(parser, options) {
  return (req, res, next) => {
    let ticket;
    try {
      const declared = Number.parseInt(String(req.headers['content-length'] || ''), 10);
      ticket = getUploadBudget().admit({
        userKey: req.user?.userId ? 'user:' + req.user.userId : 'ip:' + req.ip,
        maxRequestBytes: options.maxRequestBytes,
        declaredContentLength: Number.isFinite(declared) ? declared : undefined,
      });
      ticketsByRequest.set(req, ticket);
      res.once('close', () => ticket.release());
      parser(req, res, (error) => {
        if (error) ticket.release();
        // Match the previous HTTP adapter's per-file size status.
        if (error?.code === 'LIMIT_FILE_SIZE') {
          const { HttpException } = require('../common/http/errors');
          error = new HttpException({ message: 'File too large' }, 413);
        }
        next(error);
      });
    } catch (error) {
      ticket?.release();
      next(error);
    }
  };
}
function parser(options) {
  return multer({
    ...options.multer,
    storage: new BudgetedMemoryStorage(),
    limits: { fieldSize: 256 * 1024, fields: 100, parts: 150, ...options.multer.limits },
  });
}
function BoundedFileFields(fields, options) {
  return bound(parser(options).fields(fields), options);
}
function BoundedFile(field, options) {
  return bound(parser(options).single(field), options);
}
module.exports = { BudgetedMemoryStorage, BoundedFileFields, BoundedFile };
