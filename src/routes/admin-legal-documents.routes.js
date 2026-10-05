'use strict';

const { SystemRole } = require('../domain/auth/roles.enum');
const { Capability } = require('../domain/authorization/capability');
const {
  CreateLegalDocumentDraftDto,
  ListLegalDocumentsQueryDto,
  UpdateLegalDocumentDraftDto,
} = require('../validators/legal-documents/legal-document.dto');
const { Router } = require('express');
const {
  AdminLegalDocumentsController,
} = require('../controllers/admin-legal-documents.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminLegalDocumentsController(services.LegalDocumentsService);
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.list(validateDto(ListLegalDocumentsQueryDto, req.query)),
        200,
      ),
    ),
  );
  router.get(
    '/:documentId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.get(req.params['documentId']), 200),
    ),
  );
  router.post(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.create(validateDto(CreateLegalDocumentDraftDto, req.body), req),
        201,
      ),
    ),
  );
  router.patch(
    '/:documentId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.update(
          req.params['documentId'],
          validateDto(UpdateLegalDocumentDraftDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.post(
    '/:documentId/publish',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.publish(req.params['documentId'], req), 201),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
