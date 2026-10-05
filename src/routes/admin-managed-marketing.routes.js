'use strict';

const { Capability } = require('../domain/authorization/capability');
const { SystemRole } = require('../domain/auth/roles.enum');
const {
  CreateManagedMarketingPackageDto,
  ReviewManagedMarketingRequestDto,
  UpdateManagedMarketingPackageDto,
} = require('../validators/managed-marketing/managed-marketing.dto');
const { Router } = require('express');
const {
  AdminManagedMarketingController,
} = require('../controllers/admin-managed-marketing.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminManagedMarketingController(services.ManagedMarketingService);
  router.get(
    '/packages',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_MANAGED_MARKETING_MANAGE),
    asyncHandler(async (req, res) => sendResponse(res, await controller.packages(), 200)),
  );
  router.post(
    '/packages',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_MANAGED_MARKETING_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.createPackage(
          validateDto(CreateManagedMarketingPackageDto, req.body),
          req,
        ),
        201,
      ),
    ),
  );
  router.patch(
    '/packages/:packageId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_MANAGED_MARKETING_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.updatePackage(
          req.params['packageId'],
          validateDto(UpdateManagedMarketingPackageDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.get(
    '/requests',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_MANAGED_MARKETING_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.requests(req.query['status']), 200),
    ),
  );
  router.patch(
    '/requests/:requestId/review',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_MANAGED_MARKETING_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.review(
          req.params['requestId'],
          validateDto(ReviewManagedMarketingRequestDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
