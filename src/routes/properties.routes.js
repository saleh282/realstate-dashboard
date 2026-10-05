'use strict';

const { BadRequestException } = require('../common/http/errors');
const { BoundedFileFields } = require('../middleware/upload');
const { UPLOAD_REQUEST_LIMITS } = require('../common/uploads/upload-policies');
const { CreatePropertyDto } = require('../validators/properties/create-property.dto');
const {
  ListPublishedPropertiesDto,
} = require('../validators/properties/list-published-properties.dto');
const { GetFilterMetadataDto } = require('../validators/properties/get-filter-metadata.dto');
const {
  UpdatePropertyVisibilityDto,
} = require('../validators/properties/update-property-visibility.dto');
const { SubmitPropertyRevisionDto } = require('../validators/properties/review-property.dto');
const { EvidenceErrorCode } = require('../common/errors/evidence-error-codes');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const { PropertiesController } = require('../controllers/properties.controller');
const { authenticate, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
const allowedImages = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedDeeds = new Set([...allowedImages, 'application/pdf']);
function createRouter(services) {
  const router = Router();
  const controller = new PropertiesController(services.PropertiesService);
  router.post(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.PROPERTY_CREATE),
    BoundedFileFields(
      [
        { name: 'images', maxCount: 20 },
        { name: 'titleDeed', maxCount: 1 },
      ],
      {
        maxRequestBytes: UPLOAD_REQUEST_LIMITS.propertyOwner,
        multer: {
          limits: { fileSize: 10 * 1024 * 1024, files: 22 },
          fileFilter: (_req, file, cb) => {
            const allowed = file.fieldname === 'titleDeed' ? allowedDeeds : allowedImages;
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
        await controller.create(
          req,
          validateDto(CreatePropertyDto, req.body),
          req.files,
          req.headers['idempotency-key'],
        ),
        201,
      ),
    ),
  );
  router.post(
    '/mine/:propertyId/revisions',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.PROPERTY_MANAGE_OWN),
    BoundedFileFields(
      [
        { name: 'images', maxCount: 20 },
        { name: 'titleDeed', maxCount: 1 },
      ],
      {
        maxRequestBytes: UPLOAD_REQUEST_LIMITS.propertyOwner,
        multer: {
          limits: { fileSize: 10 * 1024 * 1024, files: 22 },
          fileFilter: (_req, file, cb) => {
            const allowed = file.fieldname === 'titleDeed' ? allowedDeeds : allowedImages;
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
        await controller.createRevision(
          req,
          req.params['propertyId'],
          validateDto(CreatePropertyDto, req.body),
          req.files,
          req.headers['idempotency-key'],
        ),
        201,
      ),
    ),
  );
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.listPublished(validateDto(ListPublishedPropertiesDto, req.query)),
        200,
      ),
    ),
  );
  router.get(
    '/filter-metadata',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.getFilterMetadata(validateDto(GetFilterMetadataDto, req.query)),
        200,
      ),
    ),
  );
  router.get(
    '/mine',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.PROPERTY_READ_OWN),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.mine(req, req.query['page'], req.query['limit']), 200),
    ),
  );
  router.get(
    '/mine/:propertyId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.PROPERTY_READ_OWN),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.getMine(req, req.params['propertyId']), 200),
    ),
  );
  router.patch(
    '/mine/:propertyId/visibility',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.PROPERTY_MANAGE_OWN),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.updateVisibility(
          req,
          req.params['propertyId'],
          validateDto(UpdatePropertyVisibilityDto, req.body),
        ),
        200,
      ),
    ),
  );
  router.post(
    '/mine/:propertyId/revisions/submit',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.PROPERTY_MANAGE_OWN),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.submitRevision(
          req,
          req.params['propertyId'],
          validateDto(SubmitPropertyRevisionDto, req.body),
          req.headers['idempotency-key'],
        ),
        201,
      ),
    ),
  );
  router.get(
    '/mine/:propertyId/evidence/title-deed',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.PROPERTY_READ_OWN),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.getOwnTitleDeed(req, req.params['propertyId'], res), 200),
    ),
  );
  router.get(
    '/mine/:propertyId/revisions/:revisionId/evidence/:evidenceIndex',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.PROPERTY_READ_OWN),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.getOwnPrivateEvidence(
          req,
          req.params['propertyId'],
          req.params['revisionId'],
          req.params['evidenceIndex'],
          res,
        ),
        200,
      ),
    ),
  );
  router.get(
    '/:propertyId',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.getPublished(req.params['propertyId']), 200),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
