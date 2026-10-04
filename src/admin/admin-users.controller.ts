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
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { UsersService } from '../users/users.service';
import { DeleteAdminUserDto } from './dto/delete-admin-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { RevokeSessionsDto } from './dto/revoke-sessions.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';
import { AccountDeletionService } from '../account-deletion/account-deletion.service';
import { AnonymizeAccountDto, LegalHoldDto } from '../account-deletion/dto/legal-hold.dto';

@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_ACCOUNT_READ)
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly accountDeletionService: AccountDeletionService,
  ) {}

  @Get()
  list(@Query() query: ListUsersQueryDto) {
    return this.usersService.listForAdmin({
      page: query.page,
      limit: query.limit,
      search: query.search?.trim(),
      systemRole: query.systemRole,
      accountType: query.accountType,
      contactVerified:
        query.contactVerified === undefined
          ? undefined
          : query.contactVerified === 'true',
    });
  }

  @Get(':userId')
  getDetails(@Param('userId') targetUserId: string) {
    return this.usersService.getUserDetailsForAdmin(targetUserId);
  }

  @Patch(':userId/status')
  @RequireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE)
  updateStatus(
    @Param('userId') targetUserId: string,
    @Body() dto: UpdateUserStatusDto,
    @Req() req: any,
  ) {
    return this.usersService.updateStatusForAdmin({
      actorUserId: req.user.userId,
      actorSystemRole: req.user.systemRole,
      targetUserId,
      accountStatus: dto.accountStatus,
      reason: dto.reason.trim(),
      ip: req.ip,
    });
  }

  @Post(':userId/revoke-sessions')
  @RequireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE)
  revokeSessions(
    @Param('userId') targetUserId: string,
    @Body() dto: RevokeSessionsDto,
    @Req() req: any,
  ) {
    return this.usersService.revokeSessionsForAdmin({
      actorUserId: req.user.userId,
      actorSystemRole: req.user.systemRole,
      targetUserId,
      reason: dto?.reason?.trim(),
      ip: req.ip,
    });
  }

  @Delete(':userId/photo')
  @RequireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE)
  removePhoto(
    @Param('userId') targetUserId: string,
    @Body() dto: RevokeSessionsDto,
    @Req() req: any,
  ) {
    return this.usersService.removeProfilePhotoForAdmin({
      actorUserId: req.user.userId,
      targetUserId,
      reason: dto?.reason?.trim() || 'profile photo removed by admin',
      ip: req.ip,
    });
  }

  @Patch(':userId/role')
  @RequireCapabilities(Capability.SUPER_ADMIN_ROLE_MANAGE)
  updateRole(
    @Param('userId') targetUserId: string,
    @Body() dto: UpdateUserRoleDto,
    @Req() req: any,
  ) {
    return this.usersService.updateRoleForAdmin({
      actorUserId: req.user.userId,
      actorSystemRole: req.user.systemRole,
      targetUserId,
      systemRole: dto.systemRole,
      reason: dto.reason.trim(),
      ip: req.ip,
    });
  }

  @Delete(':userId')
  @RequireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE)
  delete(
    @Param('userId') targetUserId: string,
    @Body() dto: DeleteAdminUserDto,
    @Req() req: any,
  ) {
    return this.accountDeletionService.requestDeletionForAdmin({
      actorUserId: req.user.userId,
      targetUserId,
      confirmIdentifier: dto.confirmIdentifier,
      reason: dto.reason.trim(),
      ip: req.ip,
    });
  }

  @Get(':userId/deletion')
  getDeletionImpact(@Param('userId') targetUserId: string) {
    return this.accountDeletionService.getAdminImpact(targetUserId);
  }

  @Post(':userId/deletion/legal-hold')
  @RequireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE)
  placeLegalHold(
    @Param('userId') targetUserId: string,
    @Body() dto: LegalHoldDto,
    @Req() req: any,
  ) {
    return this.accountDeletionService.setLegalHold({
      actorUserId: req.user.userId,
      targetUserId,
      reason: dto.reason.trim(),
      version: dto.version,
      place: true,
      ip: req.ip,
    });
  }

  @Delete(':userId/deletion/legal-hold')
  @RequireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE)
  removeLegalHold(
    @Param('userId') targetUserId: string,
    @Body() dto: LegalHoldDto,
    @Req() req: any,
  ) {
    return this.accountDeletionService.setLegalHold({
      actorUserId: req.user.userId,
      targetUserId,
      reason: dto.reason.trim(),
      version: dto.version,
      place: false,
      ip: req.ip,
    });
  }

  @Post(':userId/deletion/anonymize')
  @RequireCapabilities(Capability.ADMIN_ACCOUNT_MANAGE)
  anonymize(
    @Param('userId') targetUserId: string,
    @Body() dto: AnonymizeAccountDto,
    @Req() req: any,
  ) {
    return this.accountDeletionService.anonymize({
      actorUserId: req.user.userId,
      targetUserId,
      reason: dto.reason.trim(),
      version: dto.version,
      ip: req.ip,
    });
  }
}
