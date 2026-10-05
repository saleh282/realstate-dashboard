'use strict';

const { Router } = require('express');
const { HealthController } = require('../controllers/health.controller');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new HealthController(services.HealthService);
  router.get(
    '/live',
    asyncHandler(async (req, res) => sendResponse(res, await controller.live(), 200)),
  );
  router.get(
    '/ready',
    asyncHandler(async (req, res) => sendResponse(res, await controller.ready(), 200)),
  );
  return router;
}

Object.assign(exports, { createRouter });
