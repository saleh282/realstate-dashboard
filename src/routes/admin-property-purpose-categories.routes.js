'use strict';

const { SystemRole } = require('../domain/auth/roles.enum');
const {
  CreatePropertyPurposeCategoryDto,
} = require('../validators/property-purpose-categories/create-property-purpose-category.dto');
const {
  UpdatePropertyPurposeCategoryDto,
} = require('../validators/property-purpose-categories/update-property-purpose-category.dto');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const {
  AdminPropertyPurposeCategoriesController,
} = require('../controllers/admin-property-purpose-categories.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminPropertyPurposeCategoriesController(
    services.PropertyPurposeCategoriesService,
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
        await controller.create(validateDto(CreatePropertyPurposeCategoryDto, req.body), req),
        201,
      ),
    ),
  );
  router.patch(
    '/:categoryId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.update(
          req.params['categoryId'],
          validateDto(UpdatePropertyPurposeCategoryDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
