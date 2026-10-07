'use strict';
const { Router } = require('express');
const { Capability } = require('../domain/authorization/capability');
const { authenticate, requireCapabilities } = require('../middleware/auth');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const staff = [authenticate(services.JwtStrategy), requireCapabilities(Capability.ADMIN_USER_MANAGE)];
  router.get('/', ...staff, asyncHandler(async (req, res) => sendResponse(res, await services.UsersService.adminList(req.query))));
  router.post('/:id/status', ...staff, asyncHandler(async (req, res) => sendResponse(res, await services.UsersService.adminSetStatus(req.user.userId, req.params.id, req.body?.status, req.body?.reason, req.ip))));
  return router;
}
module.exports = { createRouter };
