'use strict';

const { Capability } = require('../domain/authorization/capability');
const {
  CancelManagedMarketingRequestDto,
  CreateManagedMarketingRequestDto,
  InitiateManagedMarketingPaymentDto,
} = require('../validators/managed-marketing/managed-marketing.dto');
const { Router } = require('express');
const { ManagedMarketingController } = require('../controllers/managed-marketing.controller');
const { authenticate, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new ManagedMarketingController(
    services.ManagedMarketingService,
    services.ManagedMarketingPaymentService,
    services.ClockService,
  );
  router.get(
    '/packages',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    asyncHandler(async (req, res) => sendResponse(res, await controller.listPackages(), 200)),
  );
  router.get(
    '/requests/mine',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.MANAGED_MARKETING_REQUEST),
    asyncHandler(async (req, res) => sendResponse(res, await controller.mine(req), 200)),
  );
  router.post(
    '/requests',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.MANAGED_MARKETING_REQUEST),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.create(req, validateDto(CreateManagedMarketingRequestDto, req.body)),
        201,
      ),
    ),
  );
  router.patch(
    '/requests/:requestId/cancel',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.MANAGED_MARKETING_REQUEST),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.cancel(
          req,
          req.params['requestId'],
          validateDto(CancelManagedMarketingRequestDto, req.body),
        ),
        200,
      ),
    ),
  );
  router.post(
    '/requests/:requestId/payment',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.MANAGED_MARKETING_REQUEST),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.pay(
          req,
          req.params['requestId'],
          validateDto(InitiateManagedMarketingPaymentDto, req.body),
        ),
        201,
      ),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
