import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { BoundedFile } from '../common/uploads/bounded-upload.interceptor';
import { UPLOAD_REQUEST_LIMITS } from '../common/uploads/upload-policies';
import { EvidenceErrorCode } from '../common/errors/evidence-error-codes';
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
import { AccountDeletionService } from '../account-deletion/account-deletion.service';

const allowedPhotoMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

@UseGuards(JwtAuthGuard, CapabilityGuard)
@RequireCapabilities(Capability.ACCOUNT_SELF_READ)
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly accountDeletionService: AccountDeletionService,
  ) {}

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
    return this.usersService.updateProfile(
      req.user.userId,
      { fullName: dto.fullName, phone: dto.phone },
      req.ip,
    );
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Put('me/photo')
  @RequireCapabilities(Capability.ACCOUNT_SELF_MANAGE)
  @UseInterceptors(
    BoundedFile('photo', {
      maxRequestBytes: UPLOAD_REQUEST_LIMITS.profilePhoto,
      multer: {
        limits: { fileSize: 5 * 1024 * 1024, files: 1 },
        fileFilter: (_req, file, callback) => {
          if (!allowedPhotoMimeTypes.has(file.mimetype)) {
            return callback(new BadRequestException({ message: 'صيغة الصورة غير مدعومة', code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED }), false);
          }
          callback(null, true);
        },
      },
    }),
  )
  updatePhoto(@Req() req: any, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.usersService.updateProfilePhoto(req.user.userId, file, req.ip);
  }

  @Delete('me/photo')
  @RequireCapabilities(Capability.ACCOUNT_SELF_MANAGE)
  removePhoto(@Req() req: any) {
    return this.usersService.removeProfilePhoto(req.user.userId, req.ip);
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
    return this.accountDeletionService.requestSelfDeletion(
      req.user.userId,
      dto.password,
      req.ip,
    );
  }
}
