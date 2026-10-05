'use strict';

const { STATUS_CODES } = require('node:http');

class HttpException extends Error {
  constructor(response, status = 500, options = {}) {
    super(
      typeof response === 'string'
        ? response
        : Array.isArray(response?.message)
          ? response.message.join(', ')
          : response?.message || STATUS_CODES[status],
      options,
    );
    this.name = this.constructor.name;
    this.status = status;
    this.response =
      typeof response === 'string' ? { message: response, statusCode: status } : response;
  }
  getStatus() {
    return this.status;
  }
  getResponse() {
    return this.response;
  }
}

const HttpStatus = Object.freeze({
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
});
exports.HttpException = HttpException;
exports.HttpStatus = HttpStatus;
for (const [name, status] of Object.entries({
  BadRequestException: 400,
  UnauthorizedException: 401,
  ForbiddenException: 403,
  NotFoundException: 404,
  ConflictException: 409,
  InternalServerErrorException: 500,
  BadGatewayException: 502,
  ServiceUnavailableException: 503,
})) {
  exports[name] = class extends HttpException {
    constructor(response = STATUS_CODES[status], options) {
      super(response, status, options);
      this.name = name;
    }
  };
}
