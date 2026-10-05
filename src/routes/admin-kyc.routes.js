'use strict';

const { SystemRole } = require('../domain/auth/roles.enum');
const { ListKycQueryDto } = require('../validators/admin/list-kyc-query.dto');
const { AdminReviewKycDto } = require('../validators/admin/admin-review-kyc.dto');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const { AdminKycController } = require('../controllers/admin-kyc.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminKycController(services.UsersService, services.CloudinaryAssetService);
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_KYC_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.list(validateDto(ListKycQueryDto, req.query)), 200),
    ),
  );
  router.get(
    '/:userId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_KYC_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.getDetails(req.params['userId']), 200),
    ),
  );
  router.get(
    '/:userId/documents/:document',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_KYC_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.getDocument(req.params['userId'], req.params['document'], res, req),
        200,
      ),
    ),
  );
  router.post(
    '/:userId/review',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_KYC_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.review(
          req.params['userId'],
          validateDto(AdminReviewKycDto, req.body),
          req,
        ),
        201,
      ),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
