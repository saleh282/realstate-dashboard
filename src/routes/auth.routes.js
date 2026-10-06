'use strict';

const { HttpStatus } = require('../common/http/errors');
const { RegisterDto } = require('../validators/auth/register.dto');
const { LoginDto } = require('../validators/auth/login.dto');
const {
  ForgotPasswordDto,
  ResendOtpDto,
  ResetPasswordDto,
  VerifyOtpDto,
} = require('../validators/auth/password-reset.dto');
const { RefreshTokenDto } = require('../validators/auth/refresh-token.dto');
const {
  ConfirmAccountRecoveryDto,
  RequestAccountRecoveryDto,
} = require('../validators/account-deletion/account-recovery.dto');
const { Router } = require('express');
const { AuthController } = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { validateDto } = require('../middleware/validate');
const { asyncHandler, sendResponse } = require('../views/response');
function createRouter(services) {
  const router = Router();
  const controller = new AuthController(services.AuthService);
  router.post(
    '/register',
    rateLimit({ default: { limit: 3, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.register(validateDto(RegisterDto, req.body), req), 201),
    ),
  );
  router.post(
    '/login',
    rateLimit({ default: { limit: 5, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.login(validateDto(LoginDto, req.body), req),
        HttpStatus.OK,
      ),
    ),
  );
  router.post(
    '/forgot-password',
    rateLimit({ default: { limit: 3, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.forgotPassword(validateDto(ForgotPasswordDto, req.body)),
        HttpStatus.OK,
      ),
    ),
  );
  router.post(
    '/resend-otp',
    rateLimit({ default: { limit: 3, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.resendOtp(validateDto(ResendOtpDto, req.body)),
        HttpStatus.OK,
      ),
    ),
  );
  router.post(
    '/verify-otp',
    rateLimit({ default: { limit: 5, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.verifyOtp(validateDto(VerifyOtpDto, req.body)),
        HttpStatus.OK,
      ),
    ),
  );
  router.post(
    '/reset-password',
    rateLimit({ default: { limit: 5, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.resetPassword(validateDto(ResetPasswordDto, req.body), req),
        HttpStatus.OK,
      ),
    ),
  );
  router.post(
    '/account-recovery/request',
    rateLimit({ default: { limit: 3, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.requestAccountRecovery(validateDto(RequestAccountRecoveryDto, req.body)),
        HttpStatus.OK,
      ),
    ),
  );
  router.post(
    '/account-recovery/confirm',
    rateLimit({ default: { limit: 5, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.confirmAccountRecovery(
          validateDto(ConfirmAccountRecoveryDto, req.body),
          req,
        ),
        HttpStatus.OK,
      ),
    ),
  );
  router.post(
    '/refresh',
    rateLimit({ default: { limit: 10, ttl: 60000 } }),
    asyncHandler(async (req, res) =>
      sendResponse(
        res,
        await controller.refresh(validateDto(RefreshTokenDto, req.body), req),
        HttpStatus.OK,
      ),
    ),
  );
  router.post(
    '/logout',
    rateLimit({ default: { limit: 20, ttl: 60000 } }),
    authenticate(services.JwtStrategy),
    asyncHandler(async (req, res) =>
      sendResponse(res, await controller.logout(req), HttpStatus.OK),
    ),
  );
  return router;
}

Object.assign(exports, { createRouter });
