'use strict';

class AuthController {
  constructor(authService) {
    this.authService = authService;
  }
  register(dto, req) {
    return this.authService.register(dto, req.ip);
  }
  login(dto, req) {
    const device = req.headers['x-device-name'] ?? req.headers['user-agent'] ?? 'unknown';
    return this.authService.login(dto, req.ip, device);
  }
  forgotPassword(dto) {
    return this.authService.forgotPassword(dto);
  }
  resendOtp(dto) {
    return this.authService.resendOtp(dto);
  }
  verifyOtp(dto) {
    return this.authService.verifyOtp(dto);
  }
  resetPassword(dto, req) {
    return this.authService.resetPassword(dto, req.ip);
  }
  requestAccountRecovery(dto) {
    return this.authService.requestAccountRecovery(dto);
  }
  confirmAccountRecovery(dto, req) {
    return this.authService.confirmAccountRecovery(dto, req.ip);
  }
  refresh(dto, req) {
    const device = req.headers['x-device-name'] ?? req.headers['user-agent'] ?? undefined;
    return this.authService.refresh(dto.refreshToken, device);
  }
  logout(req) {
    return this.authService.logout(req.user.userId, req.user.sessionId, req.ip);
  }
  logoutAll(req) {
    return this.authService.logoutAll(req.user.userId, req.ip);
  }
}

Object.assign(exports, { AuthController });
