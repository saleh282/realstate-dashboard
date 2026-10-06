'use strict';

const { Router } = require('express');
const { BadRequestException } = require('../common/http/errors');
const { EvidenceErrorCode } = require('../common/errors/evidence-error-codes');
const { UPLOAD_REQUEST_LIMITS } = require('../common/uploads/upload-policies');
const { ListingsController } = require('../controllers/listings.controller');
const { Capability } = require('../domain/authorization/capability');
const { authenticate, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { BoundedFile } = require('../middleware/upload');
const { asyncHandler, sendResponse } = require('../views/response');

const MIB = 1024 * 1024;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime']);

/** One uploaded file in `field`, refused early when its declared type is not allowed. */
function upload(field, types, maxFileBytes, maxRequestBytes, message) {
  return BoundedFile(field, {
    maxRequestBytes,
    multer: {
      limits: { fileSize: maxFileBytes, files: 1 },
      fileFilter: (_req, file, callback) =>
        types.has(file.mimetype)
          ? callback(null, true)
          : callback(
              new BadRequestException({ message, code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED }),
              false,
            ),
    },
  });
}

function createRouter(services) {
  const router = Router();
  const controller = new ListingsController(services.ListingsService);
  const reads = rateLimit({ default: { limit: 60, ttl: 60000 } });
  const writes = rateLimit({ default: { limit: 20, ttl: 60000 } });
  const uploads = rateLimit({ default: { limit: 40, ttl: 60000 } });
  const signedIn = authenticate(services.JwtStrategy);
  const own = [signedIn, requireCapabilities(Capability.LISTING_MANAGE_OWN)];
  // Changing what a listing says needs an account in good standing, like posting one.
  const edit = [signedIn, requireCapabilities(Capability.LISTING_CREATE)];
  const photo = upload(
    'photo',
    PHOTO_TYPES,
    8 * MIB,
    UPLOAD_REQUEST_LIMITS.listingPhoto,
    'صيغة الصورة غير مدعومة',
  );
  const video = upload(
    'video',
    VIDEO_TYPES,
    50 * MIB,
    UPLOAD_REQUEST_LIMITS.listingVideo,
    'صيغة الفيديو غير مدعومة',
  );
  const handle = (action, status = 200) =>
    asyncHandler(async (req, res) => sendResponse(res, await controller[action](req), status));

  // What everyone sees. No sign-in: guests browse.
  router.get('/', reads, handle('search'));
  router.get('/map', reads, handle('map'));

  // The advertiser's own listings.
  router.get('/mine', reads, ...own, handle('mine'));
  router.get('/mine/:id', reads, ...own, handle('mineOne'));
  router.post('/', writes, ...edit, handle('create', 201));
  router.put('/:id', writes, ...edit, handle('update'));
  router.delete('/:id', writes, ...own, handle('remove'));
  router.post('/:id/submit', writes, ...edit, handle('submit'));
  router.post('/:id/close', writes, ...own, handle('close'));
  router.post('/:id/reopen', writes, ...edit, handle('reopen'));

  router.put('/:id/photos/order', writes, ...edit, handle('orderPhotos'));
  router.put('/:id/photos/:shot', uploads, ...edit, photo, handle('putShot'));
  router.post('/:id/photos', uploads, ...edit, photo, handle('addPhoto', 201));
  router.delete('/:id/photos/:photoId', writes, ...edit, handle('removePhoto'));
  router.put('/:id/video', writes, ...edit, video, handle('putVideo'));
  router.delete('/:id/video', writes, ...edit, handle('removeVideo'));

  // Last, so it does not shadow the fixed paths above.
  router.get('/:id', reads, handle('publicOne'));
  return router;
}

module.exports = { createRouter };
