import {
  Body,
  Controller,
  Delete,
  Get,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsersService } from './users.service';
import { DeleteAccountDto } from './dto/delete-account.dto';

@UseGuards(JwtAuthGuard)
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

  @Delete('me')
  deleteAccount(@Req() req: any, @Body() dto: DeleteAccountDto) {
    return this.usersService.deleteAccount(req.user.userId, dto.password, req.ip);
  }
}
