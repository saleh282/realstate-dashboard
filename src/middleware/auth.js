'use strict';
const jwt = require('jsonwebtoken');
const {
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} = require('../common/http/errors');
const { AuthorizationPolicyService } = require('../services/authorization-policy.service');
const { AuthorizationErrorCode } = require('../domain/authorization/authorization-error-codes');
const { SystemRole } = require('../domain/auth/roles.enum');
const { fakePaymentsDevRoutesAllowed } = require('../domain/payments/dev/fake-payments-dev-policy');

function authenticate(tokens, { optional = false } = {}) {
  return async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header && optional) return next();
      const match = typeof header === 'string' && /^Bearer\s+(\S+)$/i.exec(header);
      if (!match) throw new UnauthorizedException();
      let payload;
      try {
        payload = jwt.verify(match[1], tokens.config.get('JWT_ACCESS_SECRET'), {
          algorithms: ['HS256'],
        });
      } catch {
        throw new UnauthorizedException();
      }
      req.user = await tokens.validate(payload);
      next();
    } catch (error) {
      next(error);
    }
  };
}
function requireRoles(...roles) {
  return (req, res, next) => {
    const role = req.user?.systemRole;
    if (
      !roles.length ||
      roles.includes(role) ||
      (role === SystemRole.SUPER_ADMIN && roles.includes(SystemRole.ADMIN))
    )
      return next();
    next(
      new ForbiddenException({
        message: 'ليس لديك صلاحية لتنفيذ هذا الإجراء',
        code: AuthorizationErrorCode.FORBIDDEN,
      }),
    );
  };
}
function requireCapabilities(...capabilities) {
  return (req, res, next) => {
    try {
      if (!capabilities.length)
        throw new ForbiddenException({
          message: 'لم يتم تعريف سياسة وصول لهذا المسار المحمي',
          code: AuthorizationErrorCode.FORBIDDEN,
        });
      for (const capability of capabilities)
        AuthorizationPolicyService.assert(req.user || {}, capability);
      next();
    } catch (error) {
      next(error);
    }
  };
}
function fakePaymentsOnly(services) {
  return (req, res, next) =>
    fakePaymentsDevRoutesAllowed(services.paymentProvider, {
      NODE_ENV: services.ConfigService.get('NODE_ENV'),
      DEPLOYMENT_ENV: services.ConfigService.get('DEPLOYMENT_ENV'),
    })
      ? next()
      : next(new NotFoundException());
}
module.exports = { authenticate, requireRoles, requireCapabilities, fakePaymentsOnly };
