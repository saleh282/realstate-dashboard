'use strict';

const { BadRequestException } = require('../common/http/errors');
const { BoundedFileFields } = require('../middleware/upload');
const { UPLOAD_REQUEST_LIMITS } = require('../common/uploads/upload-policies');
const { EvidenceErrorCode } = require('../common/errors/evidence-error-codes');
const { Capability } = require('../domain/authorization/capability');
const { Router } = require('express');
const { KycController } = require('../controllers/kyc.controller');
const { authenticate, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');
const allowedKycMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
function createRouter(services) {
  const router = Router();
  const controller = new KycController(services.KycService);
  router.post(
    '/submit',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.KYC_SELF_SUBMIT),
    BoundedFileFields(
      [
        { name: 'idFront', maxCount: 1 },
        { name: 'idBack', maxCount: 1 },
        { name: 'selfie', maxCount: 1 },
      ],
      {
        maxRequestBytes: UPLOAD_REQUEST_LIMITS.kyc,
        multer: {
          limits: { fileSize: 5 * 1024 * 1024, files: 3 }, // 5MB per file
          fileFilter: (_req, file, callback) => {
            if (!allowedKycMimeTypes.has(file.mimetype)) {
              return callback(
                new BadRequestException({
                  message: 'صيغة ملف التحقق غير مدعومة',
                  code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED,
                }),
                false,
              );
            }
            callback(null, true);
          },
        },
      },
    ),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.submit(req, req.files), 201),
    ),
  );
  router.get(
    '/status',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.KYC_SELF_READ),
    asyncHandler(async (req, res) => sendResponse(res, await controller.getStatus(req), 200)),
  );
  return router;
}

Object.assign(exports, { createRouter });
