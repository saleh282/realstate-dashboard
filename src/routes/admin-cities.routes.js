'use strict';

const { Capability } = require('../domain/authorization/capability');
const { SystemRole } = require('../domain/auth/roles.enum');
const { CreateCityDto } = require('../validators/governorates/create-city.dto');
const { UpdateCityDto } = require('../validators/governorates/update-city.dto');
const { Router } = require('express');
const { AdminCitiesController } = require('../controllers/admin-cities.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminCitiesController(services.GovernoratesService);
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
      sendResponse(res, await controller.create(validateDto(CreateCityDto, req.body), req), 201),
    ),
  );
  router.patch(
    '/:cityId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.update(req.params['cityId'], validateDto(UpdateCityDto, req.body), req),
        200,
      ),
    ),
  );
  router.delete(
    '/:cityId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.remove(req.params['cityId'], req), 200),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
