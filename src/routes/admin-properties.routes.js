'use strict';

const { BadRequestException } = require('../common/http/errors');
const { BoundedFile, BoundedFileFields } = require('../middleware/upload');
const { UPLOAD_REQUEST_LIMITS } = require('../common/uploads/upload-policies');
const { SystemRole } = require('../domain/auth/roles.enum');
const {
  AdminPropertyMediaDto,
  ReviewPropertyDto,
  UpdateAdminPropertyMediaDto,
  UpdatePropertyLifecycleDto,
} = require('../validators/properties/review-property.dto');
const {
  AdminCreatePropertyDto,
  CreatePropertyDto,
} = require('../validators/properties/create-property.dto');
const { EvidenceErrorCode } = require('../common/errors/evidence-error-codes');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const { AdminPropertiesController } = require('../controllers/admin-properties.controller');
const { authenticate, requireRoles, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
const allowedImages = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedEvidence = new Set([...allowedImages, 'application/pdf']);
function createRouter(services) {
  const router = Router();
  const controller = new AdminPropertiesController(services.PropertiesService);
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.list(
          req.query['page'],
          req.query['limit'],
          req.query['status'],
          req.query['search'],
        ),
        200,
      ),
    ),
  );
  router.post(
    '/proxy',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_PROXY_CREATE),
    BoundedFileFields(
      [
        { name: 'images', maxCount: 20 },
        { name: 'titleDeed', maxCount: 1 },
      ],
      {
        maxRequestBytes: UPLOAD_REQUEST_LIMITS.propertyAdmin,
        multer: {
          limits: { fileSize: 10 * 1024 * 1024, files: 22 },
          fileFilter: (_req, file, cb) => {
            const allowed = file.fieldname === 'titleDeed' ? allowedEvidence : allowedImages;
            return allowed.has(file.mimetype)
              ? cb(null, true)
              : cb(
                  new BadRequestException({
                    message: 'صيغة أحد ملفات العقار غير مدعومة',
                    code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED,
                  }),
                  false,
                );
          },
        },
      },
    ),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.createForAccount(
          req,
          validateDto(AdminCreatePropertyDto, req.body),
          req.files,
        ),
        201,
      ),
    ),
  );
  router.post(
    '/:propertyId/revisions/proxy',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_PROXY_CREATE),
    BoundedFileFields(
      [
        { name: 'images', maxCount: 20 },
        { name: 'titleDeed', maxCount: 1 },
      ],
      {
        maxRequestBytes: UPLOAD_REQUEST_LIMITS.propertyAdmin,
        multer: {
          limits: { fileSize: 10 * 1024 * 1024, files: 22 },
          fileFilter: (_req, file, cb) => {
            const allowed = file.fieldname === 'titleDeed' ? allowedEvidence : allowedImages;
            return allowed.has(file.mimetype)
              ? cb(null, true)
              : cb(
                  new BadRequestException({
                    message: 'صيغة أحد ملفات العقار غير مدعومة',
                    code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED,
                  }),
                  false,
                );
          },
        },
      },
    ),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.createRevisionForAccount(
          req.params['propertyId'],
          req,
          validateDto(CreatePropertyDto, req.body),
          req.files,
        ),
        201,
      ),
    ),
  );
  router.get(
    '/:propertyId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.get(req.params['propertyId']), 200),
    ),
  );
  router.post(
    '/:propertyId/revisions/:revisionId/media',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_REVIEW),
    BoundedFile('image', {
      maxRequestBytes: UPLOAD_REQUEST_LIMITS.adminSingleMedia,
      multer: {
        limits: { fileSize: 10 * 1024 * 1024, files: 1 },
        fileFilter: (_req, file, cb) =>
          allowedImages.has(file.mimetype)
            ? cb(null, true)
            : cb(
                new BadRequestException({
                  message: 'صيغة صورة العقار غير مدعومة',
                  code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED,
                }),
                false,
              ),
      },
    }),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.addPlatformMedia(
          req.params['propertyId'],
          req.params['revisionId'],
          validateDto(AdminPropertyMediaDto, req.body),
          req.file,
          req,
        ),
        201,
      ),
    ),
  );
  router.put(
    '/:propertyId/revisions/:revisionId/media/:mediaId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_REVIEW),
    BoundedFile('image', {
      maxRequestBytes: UPLOAD_REQUEST_LIMITS.adminSingleMedia,
      multer: {
        limits: { fileSize: 10 * 1024 * 1024, files: 1 },
        fileFilter: (_req, file, cb) =>
          allowedImages.has(file.mimetype)
            ? cb(null, true)
            : cb(
                new BadRequestException({
                  message: 'صيغة صورة العقار غير مدعومة',
                  code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED,
                }),
                false,
              ),
      },
    }),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.replacePlatformMedia(
          req.params['propertyId'],
          req.params['revisionId'],
          req.params['mediaId'],
          validateDto(AdminPropertyMediaDto, req.body),
          req.file,
          req,
        ),
        200,
      ),
    ),
  );
  router.patch(
    '/:propertyId/revisions/:revisionId/media/:mediaId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.updatePlatformMedia(
          req.params['propertyId'],
          req.params['revisionId'],
          req.params['mediaId'],
          validateDto(UpdateAdminPropertyMediaDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.delete(
    '/:propertyId/revisions/:revisionId/media/:mediaId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.removePlatformMedia(
          req.params['propertyId'],
          req.params['revisionId'],
          req.params['mediaId'],
          validateDto(UpdateAdminPropertyMediaDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.get(
    '/:propertyId/revisions/:revisionId/media/:mediaId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.getPlatformMedia(
          req.params['propertyId'],
          req.params['revisionId'],
          req.params['mediaId'],
          req,
          res,
        ),
        200,
      ),
    ),
  );
  router.get(
    '/:propertyId/evidence/title-deed',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.getTitleDeed(req.params['propertyId'], req, res), 200),
    ),
  );
  router.get(
    '/:propertyId/revisions/:revisionId/evidence/:evidenceIndex',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.getPrivateEvidence(
          req.params['propertyId'],
          req.params['revisionId'],
          req.params['evidenceIndex'],
          req,
          res,
        ),
        200,
      ),
    ),
  );
  router.patch(
    '/:propertyId/status',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.review(
          req.params['propertyId'],
          validateDto(ReviewPropertyDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.patch(
    '/:propertyId/revisions/:revisionId/review',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.reviewRevision(
          req.params['propertyId'],
          req.params['revisionId'],
          validateDto(ReviewPropertyDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  router.patch(
    '/:propertyId/lifecycle',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireRoles(SystemRole.ADMIN),
    requireCapabilities(Capability.ADMIN_PROPERTY_REVIEW),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.updateLifecycle(
          req.params['propertyId'],
          validateDto(UpdatePropertyLifecycleDto, req.body),
          req,
        ),
        200,
      ),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
