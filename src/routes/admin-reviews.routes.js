'use strict';

const { Router } = require('express');
const { Capability } = require('../domain/authorization/capability');
const { authenticate, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');

const actorOf = (req) => ({ userId: req.user.userId, ip: req.ip });

/** A private document goes out as itself, never cached and never guessed at. */
function sendDocument(res, file) {
  res.set({
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  });
  return sendResponse(res, file, 200);
}

/** Staff review identity checks. Mounted at /admin/kyc. */
function createKycRouter(services) {
  const router = Router();
  const reviews = () => services.AccountReviewsService;
  const staff = [
    rateLimit({ default: { limit: 60, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.ADMIN_KYC_REVIEW),
  ];
  router.get(
    '/',
    ...staff,
    asyncHandler(async (req, res) => sendResponse(res, await reviews().kycQueue(req.query))),
  );
  router.get(
    '/:userId',
    ...staff,
    asyncHandler(async (req, res) => sendResponse(res, await reviews().kycOne(req.params.userId))),
  );
  router.get(
    '/:userId/documents/:document',
    ...staff,
    asyncHandler(async (req, res) =>
      sendDocument(
        res,
        await reviews().kycDocument(actorOf(req), req.params.userId, req.params.document),
      ),
    ),
  );
  router.post(
    '/:userId/approve',
    ...staff,
    asyncHandler(async (req, res) =>
      sendResponse(res, await reviews().approveKyc(actorOf(req), req.params.userId)),
    ),
  );
  router.post(
    '/:userId/reject',
    ...staff,
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await reviews().rejectKyc(actorOf(req), req.params.userId, req.body?.reason),
      ),
    ),
  );
  return router;
}

/** Staff review broker applications. Mounted at /admin/broker-applications. */
function createBrokerRouter(services) {
  const router = Router();
  const reviews = () => services.AccountReviewsService;
  const staff = [
    rateLimit({ default: { limit: 60, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.ADMIN_BROKER_REVIEW),
  ];
  router.get(
    '/',
    ...staff,
    asyncHandler(async (req, res) => sendResponse(res, await reviews().brokerQueue(req.query))),
  );
  router.get(
    '/:id',
    ...staff,
    asyncHandler(async (req, res) => sendResponse(res, await reviews().brokerOne(req.params.id))),
  );
  router.get(
    '/:id/document',
    ...staff,
    asyncHandler(async (req, res) =>
      sendDocument(res, await reviews().brokerDocument(actorOf(req), req.params.id)),
    ),
  );
  router.post(
    '/:id/approve',
    ...staff,
    asyncHandler(async (req, res) =>
      sendResponse(res, await reviews().approveBroker(actorOf(req), req.params.id)),
    ),
  );
  router.post(
    '/:id/reject',
    ...staff,
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await reviews().rejectBroker(actorOf(req), req.params.id, req.body?.reason),
      ),
    ),
  );
  return router;
}

module.exports = { createKycRouter, createBrokerRouter };
