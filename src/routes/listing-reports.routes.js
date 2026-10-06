'use strict';

const { Router } = require('express');
const { Capability } = require('../domain/authorization/capability');
const { authenticate, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');

/** An account reports a published listing. Mounted beside the listings routes. */
function createRouter(services) {
  const router = Router();
  router.post(
    '/:id/reports',
    rateLimit({ default: { limit: 10, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.LISTING_REPORT),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await services.ListingReportsService.report(req.user.userId, req.params.id, req.body),
        201,
      ),
    ),
  );
  return router;
}

/** Staff read the reports and mark them as looked at. */
function createAdminRouter(services) {
  const router = Router();
  const staff = [
    rateLimit({ default: { limit: 60, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.ADMIN_LISTING_REVIEW),
  ];
  router.get(
    '/',
    ...staff,
    asyncHandler(async (req, res) =>
      sendResponse(res, await services.ListingReportsService.queue(req.query), 200),
    ),
  );
  router.post(
    '/:id/review',
    ...staff,
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await services.ListingReportsService.review(
          { userId: req.user.userId, ip: req.ip },
          req.params.id,
        ),
        200,
      ),
    ),
  );
  return router;
}

module.exports = { createRouter, createAdminRouter };
