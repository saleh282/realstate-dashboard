'use strict';

const { Router } = require('express');
const {
  FakePaymentsDevController,
  SettleFakePaymentDto,
} = require('../controllers/fake-payments-dev.controller');
const { authenticate, fakePaymentsOnly } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new FakePaymentsDevController(services.FakePaymentsDevService);
  router.post(
    '/:paymentId/settle',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    fakePaymentsOnly(services),
    authenticate(services.JwtStrategy),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.settle(
          req,
          req.params['paymentId'],
          validateDto(SettleFakePaymentDto, req.body),
        ),
        200,
      ),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
