import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizationErrorCode } from './authorization-error-codes';
import { AuthorizationPolicyService } from './authorization-policy.service';
import { CAPABILITIES_KEY } from './capabilities.decorator';
import { Capability } from './capability';

@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Capability[]>(CAPABILITIES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) {
      throw new ForbiddenException({
        message: 'لم يتم تعريف سياسة وصول لهذا المسار المحمي',
        code: AuthorizationErrorCode.FORBIDDEN,
      });
    }
    const request = context.switchToHttp().getRequest();
    for (const capability of required) {
      AuthorizationPolicyService.assert(request.user ?? {}, capability);
    }
    return true;
  }
}
