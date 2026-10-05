'use strict';

const { Router } = require('express');
const { PropertyTypesController } = require('../controllers/property-types.controller');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new PropertyTypesController(
    services.PropertyTypesService,
    services.PropertyFormDefinitionsService,
  );
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.list(req.query['formSchema']), 200),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
