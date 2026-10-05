'use strict';

const { getRequestId, resolveRequestId } = require('../common/request-context/request-context');
class AdminCompaniesController {
  constructor(companies) {
    this.companies = companies;
  }
  create(payload, request, suppliedRequestId, response) {
    const requestId = getRequestId(request) ?? resolveRequestId(suppliedRequestId);
    response.setHeader('X-Request-Id', requestId);
    return this.companies.create(payload, {
      actorUserId: request.user.userId,
      requestId,
      ip: request.ip,
    });
  }
}

Object.assign(exports, { AdminCompaniesController });
