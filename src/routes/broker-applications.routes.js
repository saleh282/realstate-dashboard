'use strict';

const { BadRequestException } = require('../common/http/errors');
const { BoundedFileFields } = require('../middleware/upload');
const { UPLOAD_REQUEST_LIMITS } = require('../common/uploads/upload-policies');
const { EvidenceErrorCode } = require('../common/errors/evidence-error-codes');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const { BrokerApplicationsController } = require('../controllers/broker-applications.controller');
const { authenticate, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new BrokerApplicationsController(
    services.BrokerApplicationsService,
    services.CloudinaryAssetService,
  );
  router.post(
    '/applications',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.BROKER_APPLICATION_SUBMIT),
    BoundedFileFields([{ name: 'verificationDocument', maxCount: 2 }], {
      maxRequestBytes: UPLOAD_REQUEST_LIMITS.broker,
      multer: {
        limits: { fileSize: 10 * 1024 * 1024, files: 2 },
        fileFilter: (_request, file, callback) => {
          if (file.mimetype !== 'application/pdf') {
            return callback(
              new BadRequestException({
                message: 'صيغة مستند الوسيط غير مدعومة',
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
      sendResponse(
        res,
        await controller.submit(req, req.files, req.headers['idempotency-key']),
        201,
      ),
    ),
  );
  router.get(
    '/applications/me',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.BROKER_APPLICATION_READ_OWN),
    asyncHandler(async (req, res) => sendResponse(res, await controller.ownHistory(req), 200)),
  );
  return router;
}

Object.assign(exports, { createRouter });
