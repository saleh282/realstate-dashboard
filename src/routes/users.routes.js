'use strict';

const { BadRequestException } = require('../common/http/errors');
const { BoundedFile } = require('../middleware/upload');
const { UPLOAD_REQUEST_LIMITS } = require('../common/uploads/upload-policies');
const { EvidenceErrorCode } = require('../common/errors/evidence-error-codes');
const { DeleteAccountDto } = require('../validators/users/delete-account.dto');
const { UpdateProfileDto } = require('../validators/users/update-profile.dto');
const { ChangePasswordDto } = require('../validators/users/change-password.dto');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const { UsersController } = require('../controllers/users.controller');
const { authenticate, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
const allowedPhotoMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
function createRouter(services) {
  const router = Router();
  const controller = new UsersController(services.UsersService, services.AccountDeletionService);
  router.get(
    '/me',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.ACCOUNT_SELF_READ),
    asyncHandler(async (req, res) => sendResponse(res, await controller.getProfile(req), 200)),
  );
  router.get(
    '/profile',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.ACCOUNT_SELF_READ),
    asyncHandler(async (req, res) => sendResponse(res, await controller.getProfileAlias(req), 200)),
  );
  router.get(
    '/me/capabilities',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.ACCOUNT_SELF_READ),
    asyncHandler(async (req, res) => sendResponse(res, await controller.capabilities(req), 200)),
  );
  router.patch(
    '/me',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.ACCOUNT_SELF_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.updateProfile(req, validateDto(UpdateProfileDto, req.body)),
        200,
      ),
    ),
  );
  router.put(
    '/me/photo',
    rateLimit({ default: { limit: 10, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.ACCOUNT_SELF_MANAGE),
    BoundedFile('photo', {
      maxRequestBytes: UPLOAD_REQUEST_LIMITS.profilePhoto,
      multer: {
        limits: { fileSize: 5 * 1024 * 1024, files: 1 },
        fileFilter: (_req, file, callback) => {
          if (!allowedPhotoMimeTypes.has(file.mimetype)) {
            return callback(
              new BadRequestException({
                message: 'صيغة الصورة غير مدعومة',
                code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED,
              }),
              false,
            );
          }
          callback(null, true);
        },
      },
    }),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.updatePhoto(req, req.file), 200),
    ),
  );
  router.delete(
    '/me/photo',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.ACCOUNT_SELF_MANAGE),
    asyncHandler(async (req, res) => sendResponse(res, await controller.removePhoto(req), 200)),
  );
  router.patch(
    '/me/password',
    rateLimit({ default: { limit: 5, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.ACCOUNT_SELF_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.changePassword(req, validateDto(ChangePasswordDto, req.body)),
        200,
      ),
    ),
  );
  router.delete(
    '/me',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.ACCOUNT_SELF_MANAGE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.deleteAccount(req, validateDto(DeleteAccountDto, req.body)),
        200,
      ),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
