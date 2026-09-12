import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { UserRole } from './roles.enum';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles?.length) return true;

    const user = context.switchToHttp().getRequest().user as { role?: UserRole } | undefined;
    if (!user?.role || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException('ليس لديك صلاحية لتنفيذ هذا الإجراء');
    }

    return true;
  }
}
