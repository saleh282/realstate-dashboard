'use strict';

const { SystemRole } = require('../domain/auth/roles.enum');
const { CreatePropertyTypeDto } = require('../validators/property-types/create-property-type.dto');
const { UpdatePropertyTypeDto } = require('../validators/property-types/update-property-type.dto');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const { AdminPropertyTypesController } = require('../controllers/admin-property-types.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminPropertyTypesController(services.PropertyTypesService);
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
    asyncHandler(async (req, res) => sendResponse(res, await controller.list(), 200)),
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
        await controller.create(validateDto(CreatePropertyTypeDto, req.body), req),
        201,
      ),
    ),
  );
  router.patch(
    '/:typeId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.update(
          req.params['typeId'],
          validateDto(UpdatePropertyTypeDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.delete(
    '/:typeId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.remove(req.params['typeId'], req), 200),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
