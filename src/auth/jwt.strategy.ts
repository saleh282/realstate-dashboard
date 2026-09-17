import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { SystemRole } from './roles.enum';
import { UsersService } from '../users/users.service';
import {
  AccountStatus,
  resolveAccountStatus,
  resolveAccountType,
  resolveBrokerStatus,
  resolveSystemRole,
  resolveVerificationTrustState,
} from '../users/identity.types';
import { AuthErrorCode } from '../common/errors/auth-error-codes';
import { RefreshTokenService } from '../refresh-token/refresh-token.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly usersService: UsersService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: { sub: string; sid?: string }) {
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
    if (
      payload.sid &&
      !(await this.refreshTokenService.isSessionActive(payload.sub, payload.sid))
    ) {
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
