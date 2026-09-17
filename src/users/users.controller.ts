import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsersService } from './users.service';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Throttle } from '@nestjs/throttler';
import { CapabilityGuard } from '../authorization/capability.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';

@UseGuards(JwtAuthGuard, CapabilityGuard)
@RequireCapabilities(Capability.ACCOUNT_SELF_READ)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  getProfile(@Req() req: any) {
    return this.usersService.getProfile(req.user.userId);
  }

  @Get('profile')
  getProfileAlias(@Req() req: any) {
    return this.usersService.getProfile(req.user.userId);
  }

  @Get('me/capabilities')
  capabilities(@Req() req: any) {
    return {
      capabilities: AuthorizationPolicyService.capabilitiesFor(req.user),
      advisoryOnly: true,
    };
  }

  @Patch('me')
  @RequireCapabilities(Capability.ACCOUNT_SELF_MANAGE)
  updateProfile(@Req() req: any, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(req.user.userId, dto.fullName, req.ip);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Patch('me/password')
  @RequireCapabilities(Capability.ACCOUNT_SELF_MANAGE)
  changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.usersService.changePassword(
      req.user.userId,
      dto.currentPassword,
      dto.newPassword,
      req.ip,
    );
  }

  @Delete('me')
  @RequireCapabilities(Capability.ACCOUNT_SELF_MANAGE)
  deleteAccount(@Req() req: any, @Body() dto: DeleteAccountDto) {
    return this.usersService.deleteAccount(req.user.userId, dto.password, req.ip);
  }
}
