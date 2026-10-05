'use strict';

const { SystemRole } = require('../domain/auth/roles.enum');
const { DeleteAdminUserDto } = require('../validators/admin/delete-admin-user.dto');
const { ListUsersQueryDto } = require('../validators/admin/list-users-query.dto');
const { UpdateUserStatusDto } = require('../validators/admin/update-user-status.dto');
const { RevokeSessionsDto } = require('../validators/admin/revoke-sessions.dto');
const { UpdateUserRoleDto } = require('../validators/admin/update-user-role.dto');
const { Capability } = require('../domain/authorization/capability');
const {
  AnonymizeAccountDto,
  LegalHoldDto,
} = require('../validators/account-deletion/legal-hold.dto');
const { Router } = require('express');
const { AdminUsersController } = require('../controllers/admin-users.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AdminUsersController(
    services.UsersService,
    services.AccountDeletionService,
  );
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_ACCOUNT_READ),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.list(validateDto(ListUsersQueryDto, req.query)), 200),
    ),
  );
  router.get(
    '/:userId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_ACCOUNT_READ),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.getDetails(req.params['userId']), 200),
    ),
  );
  router.patch(
    '/:userId/status',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.updateStatus(
          req.params['userId'],
          validateDto(UpdateUserStatusDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.post(
    '/:userId/revoke-sessions',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.revokeSessions(
          req.params['userId'],
          validateDto(RevokeSessionsDto, req.body),
          req,
        ),
        201,
      ),
    ),
  );
  router.delete(
    '/:userId/photo',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.removePhoto(
          req.params['userId'],
          validateDto(RevokeSessionsDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.patch(
    '/:userId/role',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.SUPER_ADMIN_ROLE_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.updateRole(
          req.params['userId'],
          validateDto(UpdateUserRoleDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.delete(
    '/:userId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.delete(
          req.params['userId'],
          validateDto(DeleteAdminUserDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.get(
    '/:userId/deletion',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_ACCOUNT_READ),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.getDeletionImpact(req.params['userId']), 200),
    ),
  );
  router.post(
    '/:userId/deletion/legal-hold',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.placeLegalHold(
          req.params['userId'],
          validateDto(LegalHoldDto, req.body),
          req,
        ),
        201,
      ),
    ),
  );
  router.delete(
    '/:userId/deletion/legal-hold',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.removeLegalHold(
          req.params['userId'],
          validateDto(LegalHoldDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.post(
    '/:userId/deletion/anonymize',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.anonymize(
          req.params['userId'],
          validateDto(AnonymizeAccountDto, req.body),
          req,
        ),
        201,
      ),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
