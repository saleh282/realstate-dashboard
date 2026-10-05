'use strict';

const { Capability } = require('../domain/authorization/capability');
const {
  ReverseGeocodingQueryDto,
  SearchGeocodingQueryDto,
} = require('../validators/geocoding/geocoding.dto');
const { Router } = require('express');
const { GeocodingController } = require('../controllers/geocoding.controller');
const { authenticate, requireCapabilities } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new GeocodingController(services.GeocodingService);
  router.get(
    '/reverse',
    rateLimit({ default: { ttl: 60_000, limit: 30 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.GEOCODING_USE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.reverse(validateDto(ReverseGeocodingQueryDto, req.query)),
        200,
      ),
    ),
  );
  router.get(
    '/search',
    rateLimit({ default: { ttl: 60_000, limit: 30 } }),
    authenticate(services.JwtStrategy),
    requireCapabilities(Capability.GEOCODING_USE),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.search(validateDto(SearchGeocodingQueryDto, req.query)),
        200,
      ),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
