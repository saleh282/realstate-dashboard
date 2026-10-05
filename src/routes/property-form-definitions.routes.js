'use strict';

const { Router } = require('express');
const {
  PropertyFormDefinitionsController,
} = require('../controllers/property-form-definitions.controller');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new PropertyFormDefinitionsController(services.PropertyFormDefinitionsService);
  router.get(
    '/versions/:versionId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.getVersion(req.params['versionId'], res), 200),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
