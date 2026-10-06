'use strict';
const jwt = require('jsonwebtoken');
const { UnauthorizedException, ForbiddenException } = require('../common/http/errors');
const { AuthorizationPolicyService } = require('../services/authorization-policy.service');
const { AuthorizationErrorCode } = require('../domain/authorization/authorization-error-codes');

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
module.exports = { authenticate, requireCapabilities };
