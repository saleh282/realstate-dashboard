'use strict';

const { Router } = require('express');
const { AmenitiesController } = require('../controllers/amenities.controller');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AmenitiesController(services.AmenitiesService);
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    asyncHandler(async (req, res) => sendResponse(res, await controller.list(), 200)),
  );
  return router;
}

Object.assign(exports, { createRouter });
