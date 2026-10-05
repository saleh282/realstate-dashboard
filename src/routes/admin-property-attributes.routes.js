'use strict';

const { SystemRole } = require('../domain/auth/roles.enum');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const {
  AdminPropertyAttributesController,
} = require('../controllers/admin-property-attributes.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminPropertyAttributesController(
    services.AdminPropertyFormDefinitionsService,
  );
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) => sendResponse(res, await controller.list(), 200)),
  );
  return router;
}

Object.assign(exports, { createRouter });
