'use strict';

const { Router } = require('express');
const { GovernoratesController } = require('../controllers/governorates.controller');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new GovernoratesController(services.GovernoratesService);
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    asyncHandler(async (req, res) => sendResponse(res, await controller.list(), 200)),
  );
  return router;
}

Object.assign(exports, { createRouter });
