'use strict';

const { SystemRole } = require('../domain/auth/roles.enum');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const { AdminCompaniesController } = require('../controllers/admin-companies.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminCompaniesController(services.CompanyAccountsService);
  router.post(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.COMPANY_CREATE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.create(req.body, req, req.headers['x-request-id'], res),
        201,
      ),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
