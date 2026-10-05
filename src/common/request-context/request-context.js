'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');
// Client-supplied correlation ids are echoed in headers and logs, so only a
// conservative character set is accepted; anything else is replaced.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const storage = new AsyncLocalStorage();
function resolveRequestId(supplied) {
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}
function getRequestId(request) {
  const value = request?.requestId;
  return typeof value === 'string' && value ? value : undefined;
}
/** The id of the HTTP request currently being handled, if any. */
function currentRequestId() {
  return storage.getStore()?.requestId;
}
function requestIdMiddleware(request, response, next) {
  const requestId = resolveRequestId(request.headers['x-request-id']);
  request.requestId = requestId;
  response.setHeader('X-Request-Id', requestId);
  storage.run({ requestId }, next);
}

Object.assign(exports, { resolveRequestId, getRequestId, currentRequestId, requestIdMiddleware });
