'use strict';

const { pipeline } = require('node:stream');
const { StreamableFile } = require('../common/http/binary-response');

function responseBody(result) {
  if (result === undefined || result === null)
    return { success: true, message: 'تمت العملية بنجاح', data: null };
  if (typeof result === 'object' && 'message' in result) {
    const { message, ...data } = result;
    return { success: true, message, data: Object.keys(data).length ? data : null };
  }
  return { success: true, message: 'تمت العملية بنجاح', data: result };
}

function sendResponse(res, result, status = 200) {
  if (res.headersSent) return;
  // A controller may deliberately set a non-default status (e.g. replayed creation).
  if (res.statusCode === 200) res.status(status);
  if (result instanceof StreamableFile) {
    if (!res.hasHeader('Content-Type')) res.type(result.options.type || 'application/octet-stream');
    if (Buffer.isBuffer(result.body)) return res.send(result.body);
    return pipeline(result.body, res, (error) => {
      if (error) res.destroy(error);
    });
  }
  return res.json(responseBody(result));
}
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve()
    .then(() => handler(req, res, next))
    .catch(next);
module.exports = { responseBody, sendResponse, asyncHandler };
