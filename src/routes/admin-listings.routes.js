'use strict';

const { Router } = require('express');
const { ListingsController } = require('../controllers/listings.controller');
const { Capability } = require('../domain/authorization/capability');
const { authenticate, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');

/** The review of listings before they are published. Staff only. */
function createRouter(services) {
  const router = Router();
  const controller = new ListingsController(services.ListingsService);
  const staff = [
    rateLimit({ default: { limit: 60, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.ADMIN_LISTING_REVIEW),
  ];
  const handle = (action) =>
    asyncHandler(async (req, res) => sendResponse(res, await controller[action](req), 200));

  router.get('/', ...staff, handle('reviewQueue'));
  router.get('/:id', ...staff, handle('reviewOne'));
  router.post('/:id/approve', ...staff, handle('approve'));
  router.post('/:id/reject', ...staff, handle('reject'));
  return router;
}

module.exports = { createRouter };
