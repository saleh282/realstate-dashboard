import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  ForgotPasswordDto,
  ResendOtpDto,
  ResetPasswordDto,
  VerifyOtpDto,
} from './dto/password-reset.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ConfirmAccountRecoveryDto, RequestAccountRecoveryDto } from '../account-deletion/dto/account-recovery.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('register')
  register(@Body() dto: RegisterDto, @Req() req: any) {
    return this.authService.register(dto, req.ip);
  }

  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: any) {
    const device = req.headers['x-device-name'] ?? req.headers['user-agent'] ?? 'unknown';
    return this.authService.login(dto, req.ip, device);
  }

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('resend-otp')
  resendOtp(@Body() dto: ResendOtpDto) {
    return this.authService.resendOtp(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto, @Req() req: any) {
    return this.authService.resetPassword(dto, req.ip);
  }

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('account-recovery/request')
  requestAccountRecovery(@Body() dto: RequestAccountRecoveryDto) {
    return this.authService.requestAccountRecovery(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('account-recovery/confirm')
  confirmAccountRecovery(@Body() dto: ConfirmAccountRecoveryDto, @Req() req: any) {
    return this.authService.confirmAccountRecovery(dto, req.ip);
  }

  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto, @Req() req: any) {
    const device = req.headers['x-device-name'] ?? req.headers['user-agent'] ?? undefined;
    return this.authService.refresh(dto.refreshToken, device);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  logout(@Req() req: any) {
    return this.authService.logout(req.user.userId, req.user.sessionId, req.ip);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout-all')
  logoutAll(@Req() req: any) {
    return this.authService.logoutAll(req.user.userId, req.ip);
  }
}
