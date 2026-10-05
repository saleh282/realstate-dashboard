'use strict';

const { SystemRole } = require('../domain/auth/roles.enum');
const { Capability } = require('../domain/authorization/capability');
const {
  ArchiveFormDefinitionDto,
  CreateFormDefinitionDto,
  DiscardFormDraftDto,
  ExpectedFormVersionDto,
  PublishFormDraftDto,
  UpdateFormDraftDto,
} = require('../validators/property-form-definitions/admin-form-definition.dto');
const { Router } = require('express');
const {
  AdminPropertyFormDefinitionsController,
} = require('../controllers/admin-property-form-definitions.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
const actor = (req) => ({ userId: req.user.userId, ip: req.ip });
function createRouter(services) {
  const router = Router();
  const controller = new AdminPropertyFormDefinitionsController(
    services.AdminPropertyFormDefinitionsService,
  );
  router.get(
    '/options',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) => sendResponse(res, await controller.options(), 200)),
  );
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) => sendResponse(res, await controller.list(), 200)),
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
        await controller.create(validateDto(CreateFormDefinitionDto, req.body), req),
        201,
      ),
    ),
  );
  router.get(
    '/:definitionId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.get(req.params['definitionId']), 200),
    ),
  );
  router.get(
    '/:definitionId/versions/:versionId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.getVersion(req.params['definitionId'], req.params['versionId']),
        200,
      ),
    ),
  );
  router.post(
    '/:definitionId/draft',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.createDraft(
          req.params['definitionId'],
          validateDto(ExpectedFormVersionDto, req.body),
          req,
        ),
        201,
      ),
    ),
  );
  router.put(
    '/:definitionId/draft',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.updateDraft(
          req.params['definitionId'],
          validateDto(UpdateFormDraftDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.post(
    '/:definitionId/draft/discard',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.discardDraft(
          req.params['definitionId'],
          validateDto(DiscardFormDraftDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.post(
    '/:definitionId/draft/validate',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.validateDraft(req.params['definitionId']), 200),
    ),
  );
  router.get(
    '/:definitionId/draft/diff',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_CATALOG_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.diffDraft(req.params['definitionId']), 200),
    ),
  );
  router.post(
    '/:definitionId/publish',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_FORM_DEFINITION_PUBLISH),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.publish(
          req.params['definitionId'],
          validateDto(PublishFormDraftDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.post(
    '/:definitionId/archive',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_FORM_DEFINITION_PUBLISH),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.archive(
          req.params['definitionId'],
          validateDto(ArchiveFormDefinitionDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.post(
    '/:definitionId/restore',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_FORM_DEFINITION_PUBLISH),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.restore(
          req.params['definitionId'],
          validateDto(ExpectedFormVersionDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
