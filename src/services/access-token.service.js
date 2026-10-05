'use strict';

const { ForbiddenException, UnauthorizedException } = require('../common/http/errors');
const {
  AccountStatus,
  resolveAccountStatus,
  resolveAccountType,
  resolveBrokerStatus,
  resolveSystemRole,
  resolveVerificationTrustState,
} = require('../domain/users/identity.types');
const { AuthErrorCode } = require('../common/errors/auth-error-codes');
const { ACCESS_TOKEN_TYPE } = require('../domain/auth/token-types');
class JwtStrategy {
  constructor(config, usersService, refreshTokenService) {
    this.usersService = usersService;
    this.refreshTokenService = refreshTokenService;
    this.config = config;
  }
  async validate(payload) {
    // Only session-bound access tokens authenticate requests. Purpose-scoped
    // tokens (password reset, etc.) and session-less tokens are never accepted.
    if (
      payload.purpose !== undefined ||
      (payload.typ !== undefined && payload.typ !== ACCESS_TOKEN_TYPE) ||
      !payload.sid
    ) {
      throw new UnauthorizedException({
        message: 'رمز الدخول غير صالح',
        code: AuthErrorCode.INVALID_TOKEN_TYPE,
      });
    }
    const user = await this.usersService.findById(payload.sub);
    if (!user) throw new UnauthorizedException('المستخدم غير موجود');
    const accountStatus = resolveAccountStatus(user);
    if (accountStatus === AccountStatus.BLOCKED) {
      throw new ForbiddenException({
        message: 'هذا الحساب محظور مؤقتاً',
        code: AuthErrorCode.ACCOUNT_BLOCKED,
      });
    }
    if (accountStatus === AccountStatus.PERMANENTLY_BANNED) {
      throw new ForbiddenException({
        message: 'هذا الحساب محظور نهائياً',
        code: AuthErrorCode.ACCOUNT_PERMANENTLY_BANNED,
      });
    }
    if (accountStatus === AccountStatus.DELETION_PENDING) {
      throw new ForbiddenException({
        message: 'الحساب قيد الحذف',
        code: AuthErrorCode.ACCOUNT_DELETION_PENDING,
      });
    }
    if (accountStatus === AccountStatus.ANONYMIZED) {
      throw new ForbiddenException({
        message: 'لا يمكن استخدام هذا الحساب',
        code: AuthErrorCode.ACCOUNT_ALREADY_ANONYMIZED,
      });
    }
    if (!(await this.refreshTokenService.isSessionActive(payload.sub, payload.sid))) {
      throw new UnauthorizedException({
        message: 'انتهت صلاحية الجلسة',
        code: AuthErrorCode.SESSION_REVOKED,
      });
    }
    // Authentication establishes the current database role; RolesGuard makes
    // the separate authorization decision for protected operations.
    return {
      userId: payload.sub,
      sessionId: payload.sid,
      systemRole: resolveSystemRole(user),
      accountType: resolveAccountType(user),
      accountStatus,
      brokerStatus: resolveBrokerStatus(user),
      verificationTrustState: resolveVerificationTrustState(user),
    };
  }
}

Object.assign(exports, { JwtStrategy });
