'use strict';

const { SystemRole } = require('../domain/auth/roles.enum');
const { ListAuditLogsQueryDto } = require('../validators/admin/list-audit-logs-query.dto');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const { AdminAuditController } = require('../controllers/admin-audit.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminAuditController(services.AuditLogService);
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_AUDIT_READ),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.list(validateDto(ListAuditLogsQueryDto, req.query)), 200),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
