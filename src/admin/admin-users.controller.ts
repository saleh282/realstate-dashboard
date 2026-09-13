import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { UsersService } from '../users/users.service';
import { DeleteAdminUserDto } from './dto/delete-admin-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { RevokeSessionsDto } from './dto/revoke-sessions.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';

@Roles(UserRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  list(@Query() query: ListUsersQueryDto) {
    return this.usersService.listForAdmin({
      page: query.page,
      limit: query.limit,
      search: query.search?.trim(),
      role: query.role,
      emailVerified:
        query.emailVerified === undefined
          ? undefined
          : query.emailVerified === 'true',
    });
  }

  @Get(':userId')
  getDetails(@Param('userId') targetUserId: string) {
    return this.usersService.getUserDetailsForAdmin(targetUserId);
  }

  @Patch(':userId/status')
  updateStatus(
    @Param('userId') targetUserId: string,
    @Body() dto: UpdateUserStatusDto,
    @Req() req: any,
  ) {
    return this.usersService.updateStatusForAdmin({
      actorUserId: req.user.userId,
      targetUserId,
      isActive: dto.isActive,
      reason: dto.reason.trim(),
      ip: req.ip,
    });
  }

  @Post(':userId/revoke-sessions')
  revokeSessions(
    @Param('userId') targetUserId: string,
    @Body() dto: RevokeSessionsDto,
    @Req() req: any,
  ) {
    return this.usersService.revokeSessionsForAdmin({
      actorUserId: req.user.userId,
      targetUserId,
      reason: dto?.reason?.trim(),
      ip: req.ip,
    });
  }

  @Patch(':userId/role')
  updateRole(
    @Param('userId') targetUserId: string,
    @Body() dto: UpdateUserRoleDto,
    @Req() req: any,
  ) {
    return this.usersService.updateRoleForAdmin({
      actorUserId: req.user.userId,
      targetUserId,
      role: dto.role,
      reason: dto.reason.trim(),
      ip: req.ip,
    });
  }

  @Delete(':userId')
  delete(
    @Param('userId') targetUserId: string,
    @Body() dto: DeleteAdminUserDto,
    @Req() req: any,
  ) {
    return this.usersService.deleteForAdmin({
      actorUserId: req.user.userId,
      targetUserId,
      confirmIdentifier: dto.confirmIdentifier,
      reason: dto.reason.trim(),
      ip: req.ip,
    });
  }
}
