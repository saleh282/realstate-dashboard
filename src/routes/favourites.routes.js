'use strict';

const { Router } = require('express');
const { Capability } = require('../domain/authorization/capability');
const { authenticate, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { asyncHandler, sendResponse } = require('../views/response');

/** The signed-in account's favourite listings. */
function createRouter(services) {
  const router = Router();
  const mine = [
    rateLimit({ default: { limit: 60, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.FAVOURITE_MANAGE_OWN),
  ];
  const favourites = () => services.FavouritesService;

  router.get(
    '/',
    ...mine,
    asyncHandler(async (req, res) => sendResponse(res, await favourites().list(req.user.userId))),
  );
  router.put(
    '/:listingId',
    ...mine,
    asyncHandler(async (req, res) =>
      sendResponse(res, await favourites().add(req.user.userId, req.params.listingId)),
    ),
  );
  router.delete(
    '/:listingId',
    ...mine,
    asyncHandler(async (req, res) =>
      sendResponse(res, await favourites().remove(req.user.userId, req.params.listingId)),
    ),
  );
  return router;
}

module.exports = { createRouter };
