'use strict';

const { SystemRole } = require('../domain/auth/roles.enum');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const { AdminOperationsController } = require('../controllers/admin-operations.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminOperationsController(services.OperationalStatusService);
  router.get(
    '/status',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_DASHBOARD_READ),
    asyncHandler(async (req, res) => sendResponse(res, await controller.status(), 200)),
  );
  return router;
}

Object.assign(exports, { createRouter });
