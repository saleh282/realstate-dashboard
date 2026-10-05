'use strict';

const { Router } = require('express');
const { LegalDocumentsController } = require('../controllers/legal-documents.controller');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new LegalDocumentsController(services.LegalDocumentsService);
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    asyncHandler(async (req, res) => sendResponse(res, await controller.list(), 200)),
  );
  router.get(
    '/:type',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.get(req.params['type']), 200),
    ),
  );
  router.get(
    '/:type/page',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.page(req.params['type'], req.query['lang'], res), 200),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
