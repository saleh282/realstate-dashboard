import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * For public routes that personalise the response when the viewer is signed in
 * (MAZAD-029 `isMine`). No `Authorization` header → guest (`req.user` stays
 * undefined). A header that is present but invalid/expired is a 401, never
 * silently downgraded to guest, so a client learns its token is stale. All
 * validation is the normal JWT strategy's (session, account status).
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    if (!request.headers?.authorization) return true;
    return super.canActivate(context);
  }

  handleRequest<T>(err: unknown, user: T): T {
    if (err) throw err;
    if (!user) throw new UnauthorizedException();
    return user;
  }
}
