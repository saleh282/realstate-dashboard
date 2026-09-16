import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { SystemRole } from './roles.enum';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<SystemRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles?.length) return true;

    const user = context.switchToHttp().getRequest().user as
      | { systemRole?: SystemRole }
      | undefined;
    const accepted = user?.systemRole === SystemRole.SUPER_ADMIN
      ? requiredRoles.includes(SystemRole.ADMIN) || requiredRoles.includes(SystemRole.SUPER_ADMIN)
      : Boolean(user?.systemRole && requiredRoles.includes(user.systemRole));
    if (!accepted) {
      throw new ForbiddenException('ليس لديك صلاحية لتنفيذ هذا الإجراء');
    }

    return true;
  }
}
