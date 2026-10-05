'use strict';

const { SystemRole } = require('../domain/auth/roles.enum');
const {
  CreatePropertyOptionDto,
} = require('../validators/property-options/create-property-option.dto');
const {
  UpdatePropertyOptionDto,
} = require('../validators/property-options/update-property-option.dto');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const {
  AdminPropertyOptionsController,
} = require('../controllers/admin-property-options.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminPropertyOptionsController(services.PropertyOptionsService);
  router.get(
    '/options',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) => sendResponse(res, await controller.options(), 200)),
  );
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.list(req.query['group']), 200),
    ),
  );
  router.post(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.create(validateDto(CreatePropertyOptionDto, req.body), req),
        201,
      ),
    ),
  );
  router.patch(
    '/:optionId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.update(
          req.params['optionId'],
          validateDto(UpdatePropertyOptionDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.delete(
    '/:optionId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.remove(req.params['optionId'], req), 200),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
