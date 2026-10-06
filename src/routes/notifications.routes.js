'use strict';

const { NotificationErrorCode } = require('../common/errors/notification-error-codes');
const { ListNotificationsDto } = require('../validators/notifications/list-notifications.dto');
const {
  notificationValidation,
} = require('../validators/notifications/notification-validation.pipe');
const {
  UpdateNotificationPreferencesDto,
} = require('../validators/notifications/update-notification-preferences.dto');
const { Router } = require('express');
const { NotificationsController } = require('../controllers/notifications.controller');
const { authenticate } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new NotificationsController(services.NotificationsService);
  router.get(
    '/',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.list(
          req,
          notificationValidation(
            ListNotificationsDto,
            NotificationErrorCode.QUERY_INVALID,
          ).transform(req.query),
        ),
        200,
      ),
    ),
  );
  router.get(
    '/unread-count',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    asyncHandler(async (req, res) => sendResponse(res, await controller.unreadCount(req), 200)),
  );
  router.get(
    '/preferences',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    asyncHandler(async (req, res) => sendResponse(res, await controller.preferences(req), 200)),
  );
  router.patch(
    '/preferences',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.updatePreferences(
          req,
          notificationValidation(
            UpdateNotificationPreferencesDto,
            NotificationErrorCode.PREFERENCE_INVALID,
          ).transform(req.body),
        ),
        200,
      ),
    ),
  );
  router.patch(
    '/read-all',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    asyncHandler(async (req, res) => sendResponse(res, await controller.markAllRead(req), 200)),
  );
  router.patch(
    '/:notificationId/read',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.markRead(req, req.params['notificationId']), 200),
    ),
  );
  // The phone this account is signed in on, for push notifications.
  router.put(
    '/devices',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    asyncHandler(async (req, res) =>
      sendResponse(res, await services.PushService.register(req.user.userId, req.body), 200),
    ),
  );
  // No sign-in: it is called while signing out, and the token itself is what proves the phone.
  router.delete(
    '/devices',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(res, await services.PushService.unregister(req.body), 200),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
