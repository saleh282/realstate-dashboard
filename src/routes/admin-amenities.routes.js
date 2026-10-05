'use strict';

const { SystemRole } = require('../domain/auth/roles.enum');
const { CreateAmenityDto } = require('../validators/amenities/create-amenity.dto');
const { UpdateAmenityDto } = require('../validators/amenities/update-amenity.dto');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const { AdminAmenitiesController } = require('../controllers/admin-amenities.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminAmenitiesController(services.AmenitiesService);
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
      sendResponse(res, await controller.create(validateDto(CreateAmenityDto, req.body), req), 201),
    ),
  );
  router.patch(
    '/:amenityId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.update(
          req.params['amenityId'],
          validateDto(UpdateAmenityDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.delete(
    '/:amenityId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.remove(req.params['amenityId'], req), 200),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
