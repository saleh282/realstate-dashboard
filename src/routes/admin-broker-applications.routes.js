'use strict';

const { ParseIntPipe } = require('../middleware/validate');
const { SystemRole } = require('../domain/auth/roles.enum');
const {
  ChangeBrokerStatusDto,
} = require('../validators/broker-applications/change-broker-status.dto');
const {
  ReviewBrokerApplicationDto,
} = require('../validators/broker-applications/review-broker-application.dto');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const {
  AdminBrokerApplicationsController,
} = require('../controllers/admin-broker-applications.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminBrokerApplicationsController(
    services.BrokerApplicationsService,
    services.CloudinaryAssetService,
  );
  router.get(
    '/broker/applications',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_BROKER_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.listApplications(
          req.query['status'],
          new ParseIntPipe({ optional: true }).transform(req.query['page']),
          new ParseIntPipe({ optional: true }).transform(req.query['limit']),
        ),
        200,
      ),
    ),
  );
  router.get(
    '/broker/applications/:applicationId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_BROKER_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.getApplication(req.params['applicationId']), 200),
    ),
  );
  router.get(
    '/broker/applications/:applicationId/documents/:documentId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_BROKER_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.getDocument(
          req.params['applicationId'],
          req.params['documentId'],
          req,
          res,
        ),
        200,
      ),
    ),
  );
  router.post(
    '/broker/applications/:applicationId/review',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_BROKER_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.review(
          req.params['applicationId'],
          validateDto(ReviewBrokerApplicationDto, req.body),
          req,
        ),
        201,
      ),
    ),
  );
  router.post(
    '/brokers/:userId/suspend',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_BROKER_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.suspend(
          req.params['userId'],
          validateDto(ChangeBrokerStatusDto, req.body),
          req,
        ),
        201,
      ),
    ),
  );
  router.post(
    '/brokers/:userId/restore',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_BROKER_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.restore(
          req.params['userId'],
          validateDto(ChangeBrokerStatusDto, req.body),
          req,
        ),
        201,
      ),
    ),
  );
  router.post(
    '/brokers/:userId/revoke',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_BROKER_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.revoke(
          req.params['userId'],
          validateDto(ChangeBrokerStatusDto, req.body),
          req,
        ),
        201,
      ),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
