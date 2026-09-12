import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UserRole } from './roles.enum';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService, private readonly usersService: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_ACCESS_SECRET'),
    });
  }

  async validate(payload: { sub: string; identifier: string; role?: UserRole }) {
    const user = await this.usersService.findById(payload.sub);
    if (!user) throw new UnauthorizedException('المستخدم غير موجود');

    // Authentication establishes the current database role; RolesGuard makes
    // the separate authorization decision for protected operations.
    return {
      userId: payload.sub,
      identifier: payload.identifier,
      role: user.role ?? UserRole.USER,
    };
  }
}
