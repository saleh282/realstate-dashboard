import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { MailService } from './mail.service';
import { SmsService } from './sms.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  ForgotPasswordDto,
  OtpPurpose,
  ResendOtpDto,
  ResetPasswordDto,
  VerifyOtpDto,
} from './dto/password-reset.dto';
import { OtpVerificationService } from '../otp/otp-verification.service';
import { OtpPurpose as OtpCollectionPurpose } from '../otp/schemas/otp-verification.schema';
import { RefreshTokenService } from '../refresh-token/refresh-token.service';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { hashPassword } from '../common/security/password-hashing';
import { UserRole } from './roles.enum';
import { normalizeIdentifier } from '../common/validators/identifier.validator';
import { AuthErrorCode } from '../common/errors/auth-error-codes';
import { randomUUID } from 'crypto';

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private config: ConfigService,
    private otpVerificationService: OtpVerificationService,
    private mailService: MailService,
    private smsService: SmsService,
    private refreshTokenService: RefreshTokenService,
    private auditLogService: AuditLogService,
  ) {}

  private async sendOtp(identifier: string, code: string) {
    const normalized = normalizeIdentifier(identifier);
    if (!normalized) {
      throw new BadRequestException({
        message: 'البريد الإلكتروني أو رقم الهاتف غير صالح',
        code: AuthErrorCode.INVALID_IDENTIFIER,
      });
    }
    if (normalized.kind === 'email') {
      await this.mailService.sendOtp(identifier, code);
    } else {
      await this.smsService.sendOtp(identifier, code);
    }
  }

  // ---------------------------------------------------------------------
  // REGISTER (screen 5)
  // ---------------------------------------------------------------------
  async register(dto: RegisterDto, ip?: string) {
    // The shared password policy + confirmPassword match are enforced by RegisterDto.

    const normalized = normalizeIdentifier(dto.identifier)!;
    const identifier = normalized.value;
    const existing = await this.usersService.findByIdentifier(identifier);
    if (existing) {
      if (!existing.emailVerified) {
        const code = await this.otpVerificationService.generateAndStore(
          identifier,
          OtpCollectionPurpose.REGISTER,
        );
        await this.sendOtp(identifier, code);

        throw new ConflictException({
          message: 'الحساب موجود ولكنه غير مفعل، تم إرسال رمز تحقق جديد',
          code: AuthErrorCode.ACCOUNT_NOT_VERIFIED,
          isVerified: false,
          requiresVerification: true,
          otpSent: true,
          identifier,
          expiresInMinutes: 5,
        });
      }

      throw new ConflictException({
        message: 'البريد الإلكتروني مسجل ومفعل بالفعل',
        code: AuthErrorCode.ACCOUNT_ALREADY_VERIFIED,
        isVerified: true,
        requiresVerification: false,
        otpSent: false,
        identifier,
      });
    }

    const passwordHash = await hashPassword(dto.password);

    const user = await this.usersService.create({
      fullName: dto.fullName,
      email: normalized.kind === 'email' ? identifier : undefined,
      phone: normalized.kind === 'phone' ? identifier : undefined,
      password: passwordHash,
    });

    // مفيش تسجيل دخول تلقائي هنا. لازم يتبعت OTP الأول والمستخدم يتحقق منه
    // عن طريق /auth/verify-otp (purpose: 'register') قبل ما ياخد أي token.
    const code = await this.otpVerificationService.generateAndStore(
      identifier,
      OtpCollectionPurpose.REGISTER,
    );
    await this.sendOtp(identifier, code);

    await this.auditLogService.log(AuditAction.REGISTER, user._id.toString(), ip);

    return {
      message: 'تم إنشاء الحساب، تم إرسال رمز التحقق',
      userId: user._id.toString(),
      id: user._id.toString(),
      identifier,
      isVerified: false,
      requiresVerification: true,
      otpSent: true,
      expiresInMinutes: 5,
    };
  }

  // ---------------------------------------------------------------------
  // LOGIN (screen 1) - with brute-force lockout
  // ---------------------------------------------------------------------
  async login(dto: LoginDto, ip?: string, device?: string) {
    const identifier = normalizeIdentifier(dto.identifier)!.value;
    const user = await this.usersService.findByIdentifier(identifier, true);
    if (!user) {
      await this.auditLogService.log(AuditAction.LOGIN_FAILED, null, ip);
      throw new UnauthorizedException({
        message: 'بيانات الدخول غير صحيحة',
        code: AuthErrorCode.INVALID_CREDENTIALS,
      });
    }

    if (user.accountLockedUntil && user.accountLockedUntil.getTime() > Date.now()) {
      const minutesLeft = Math.ceil((user.accountLockedUntil.getTime() - Date.now()) / 60000);
      await this.auditLogService.log(AuditAction.LOGIN_FAILED, user._id.toString(), ip);
      throw new UnauthorizedException({
        message: `الحساب مقفول مؤقتاً بسبب محاولات دخول فاشلة متكررة، حاول بعد ${minutesLeft} دقيقة`,
        code: AuthErrorCode.ACCOUNT_LOCKED,
      });
    }

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) {
      user.failedLoginAttempts = (user.failedLoginAttempts ?? 0) + 1;
      if (user.failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        user.accountLockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
        user.failedLoginAttempts = 0;
      }
      await this.usersService.save(user);
      await this.auditLogService.log(AuditAction.LOGIN_FAILED, user._id.toString(), ip);
      throw new UnauthorizedException({
        message: 'بيانات الدخول غير صحيحة',
        code: AuthErrorCode.INVALID_CREDENTIALS,
      });
    }

    if (user.isActive === false) {
      await this.auditLogService.log(AuditAction.LOGIN_FAILED, user._id.toString(), ip);
      throw new ForbiddenException({
        message: user.suspendReason
          ? 'تم تجميد هذا الحساب: ' + user.suspendReason
          : 'تم تجميد هذا الحساب من قِبل الإدارة',
        code: AuthErrorCode.ACCOUNT_SUSPENDED,
      });
    }
    if (!user.emailVerified) {
      await this.auditLogService.log(AuditAction.LOGIN_FAILED, user._id.toString(), ip);
      const code = await this.otpVerificationService.generateAndStore(
        identifier,
        OtpCollectionPurpose.REGISTER,
      );
      await this.sendOtp(identifier, code);
      throw new UnauthorizedException({
        message: 'الحساب غير مفعل، يرجى التحقق من رمز OTP المرسل أولاً',
        code: AuthErrorCode.ACCOUNT_NOT_VERIFIED,
        isVerified: false,
        requiresVerification: true,
        otpSent: true,
        identifier,
      });
    }

    // successful login - clear any lockout state
    user.failedLoginAttempts = 0;
    user.accountLockedUntil = undefined;
    await this.usersService.save(user);

    const tokens = await this.issueTokens(
      user._id.toString(),
      identifier,
      user.role ?? UserRole.USER,
      dto.rememberMe,
      device,
    );
    await this.auditLogService.log(AuditAction.LOGIN_SUCCESS, user._id.toString(), ip);

    return {
      ...tokens,
      userId: user._id.toString(),
      id: user._id.toString(),
      user: {
        userId: user._id.toString(),
        id: user._id.toString(),
        _id: user._id.toString(),
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        emailVerified: user.emailVerified,
        isActive: true,
        role: user.role ?? UserRole.USER,
        kycStatus: user.kycStatus,
      },
    };
  }

  // ---------------------------------------------------------------------
  // FORGOT PASSWORD (screen 4) - sends a 6-digit OTP to email or phone
  // ---------------------------------------------------------------------
  async forgotPassword(dto: ForgotPasswordDto) {
    const identifier = normalizeIdentifier(dto.identifier)!.value;
    const user = await this.usersService.findByIdentifier(identifier);
    // Don't reveal whether the account exists
    if (!user) {
      return { message: 'إذا كان الحساب موجوداً، تم إرسال رمز التحقق' };
    }

    await this.otpVerificationService.assertCanResend(identifier, OtpCollectionPurpose.PASSWORD_RESET);
    const code = await this.otpVerificationService.generateAndStore(
      identifier,
      OtpCollectionPurpose.PASSWORD_RESET,
    );
    await this.sendOtp(identifier, code);

    return { message: 'تم إرسال رمز التحقق', expiresInMinutes: 5 };
  }

  async resendOtp(dto: ResendOtpDto) {
    const purpose =
      dto.purpose === OtpPurpose.REGISTER
        ? OtpCollectionPurpose.REGISTER
        : OtpCollectionPurpose.PASSWORD_RESET;

    const identifier = normalizeIdentifier(dto.identifier)!.value;
    const user = await this.usersService.findByIdentifier(identifier);
    if (!user) {
      return { message: 'إذا كان الحساب موجوداً، تم إرسال رمز التحقق' };
    }

    if (purpose === OtpCollectionPurpose.REGISTER && user.emailVerified) {
      throw new ConflictException({
        message: 'الحساب مفعل بالفعل، يمكنك تسجيل الدخول',
        code: AuthErrorCode.ACCOUNT_ALREADY_VERIFIED,
        isVerified: true,
        requiresVerification: false,
        otpSent: false,
        identifier,
      });
    }

    await this.otpVerificationService.assertCanResend(identifier, purpose);
    const code = await this.otpVerificationService.generateAndStore(identifier, purpose);
    await this.sendOtp(identifier, code);

    return { message: 'تم إرسال رمز التحقق', expiresInMinutes: 5 };
  }

  // ---------------------------------------------------------------------
  // VERIFY OTP (screen 3) -> activates account (register) or returns a resetToken
  // ---------------------------------------------------------------------
  async verifyOtp(dto: VerifyOtpDto) {
    const purpose =
      dto.purpose === OtpPurpose.REGISTER
        ? OtpCollectionPurpose.REGISTER
        : OtpCollectionPurpose.PASSWORD_RESET;

    const identifier = normalizeIdentifier(dto.identifier)!.value;
    try {
      await this.otpVerificationService.verify(identifier, dto.otp, purpose);
    } catch (err) {
      const user = await this.usersService.findByIdentifier(identifier);
      await this.auditLogService.log(AuditAction.OTP_FAILED, user?._id?.toString() ?? null, undefined);
      throw err;
    }

    const user = await this.usersService.findByIdentifier(identifier);
    if (!user) {
      throw new BadRequestException('المستخدم غير موجود');
    }
    if (user.isActive === false) {
      throw new ForbiddenException({
        message: 'تم تجميد هذا الحساب من قِبل الإدارة',
        code: AuthErrorCode.ACCOUNT_SUSPENDED,
      });
    }

    if (dto.purpose === OtpPurpose.REGISTER) {
      user.emailVerified = true;
      await this.usersService.save(user);

      return {
        message: 'تم تفعيل حسابك بنجاح، يمكنك تسجيل الدخول الآن',
        isVerified: true,
      };
    }

    // password_reset -> issue a short-lived resetToken for the next step
    const resetToken = this.jwtService.sign(
      { sub: user._id.toString(), purpose: 'password_reset' },
      {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        expiresIn: '10m',
      },
    );

    return { resetToken };
  }

  // ---------------------------------------------------------------------
  // RESET PASSWORD (screen 2)
  // ---------------------------------------------------------------------
  async resetPassword(dto: ResetPasswordDto, ip?: string) {
    // The shared password policy + confirmPassword match are enforced by ResetPasswordDto.

    let payload: { sub: string; purpose: string };
    try {
      payload = this.jwtService.verify(dto.resetToken, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new BadRequestException({
        message: 'انتهت صلاحية الجلسة، يرجى إعادة طلب رمز التحقق',
        code: AuthErrorCode.SESSION_EXPIRED,
      });
    }

    if (payload.purpose !== 'password_reset') {
      throw new BadRequestException('رمز غير صالح');
    }

    const user = await this.usersService.findById(payload.sub, true);
    if (!user) {
      throw new BadRequestException('المستخدم غير موجود');
    }
    if (user.isActive === false) {
      throw new ForbiddenException({
        message: 'تم تجميد هذا الحساب من قِبل الإدارة',
        code: AuthErrorCode.ACCOUNT_SUSPENDED,
      });
    }

    user.password = await hashPassword(dto.newPassword);
    user.failedLoginAttempts = 0;
    user.accountLockedUntil = undefined;
    await this.usersService.save(user);

    // force re-login everywhere - drop all existing sessions
    await this.refreshTokenService.revokeAllForUser(user._id.toString());

    await this.auditLogService.log(AuditAction.PASSWORD_RESET, user._id.toString(), ip);

    return { message: 'تم تحديث كلمة المرور بنجاح' };
  }

  // ---------------------------------------------------------------------
  // TOKEN HELPERS
  // ---------------------------------------------------------------------
  private async issueTokens(
    userId: string,
    identifier: string,
    role: UserRole,
    rememberMe = true,
    device = 'unknown',
  ) {
    const accessToken = this.jwtService.sign(
      { sub: userId, identifier, role },
      {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        expiresIn: this.config.get('JWT_ACCESS_EXPIRES_IN') ?? '15m',
      },
    );

    const refreshExpiresIn = rememberMe
      ? this.config.get('JWT_REFRESH_EXPIRES_IN') ?? '7d'
      : '1d';

    const refreshToken = this.jwtService.sign(
      { sub: userId, jti: randomUUID() },
      {
        secret: this.config.get('JWT_REFRESH_SECRET'),
        expiresIn: refreshExpiresIn,
      },
    );

    const expiresAt = new Date(
      Date.now() + this.parseDurationMs(refreshExpiresIn),
    );
    await this.refreshTokenService.store(userId, refreshToken, expiresAt, device);

    return { accessToken, refreshToken };
  }

  private parseDurationMs(duration: string): number {
    const match = /^(\d+)([smhd])$/.exec(duration);
    if (!match) return 7 * 24 * 60 * 60 * 1000; // default 7 days
    const value = Number(match[1]);
    const unit = match[2];
    const unitMs: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return value * unitMs[unit];
  }

  async refresh(userId: string, refreshToken: string, device?: string) {
    const { device: existingDevice } = await this.refreshTokenService.verifyAndRotate(
      userId,
      refreshToken,
    );
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('المستخدم غير موجود');
    }
    if (user.isActive === false) {
      throw new ForbiddenException({
        message: 'تم تجميد هذا الحساب من قِبل الإدارة',
        code: AuthErrorCode.ACCOUNT_SUSPENDED,
      });
    }
    if (!user.emailVerified) {
      throw new UnauthorizedException({
        message: 'الحساب غير مفعل، يرجى تسجيل الدخول لإعادة التحقق',
        code: AuthErrorCode.ACCOUNT_NOT_VERIFIED,
      });
    }
    const tokens = await this.issueTokens(
      userId,
      user.email ?? user.phone ?? '',
      user.role ?? UserRole.USER,
      true,
      device ?? existingDevice,
    );
    return {
      ...tokens,
      userId: userId,
      id: userId,
      user: {
        userId: user._id.toString(),
        id: user._id.toString(),
        _id: user._id.toString(),
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        emailVerified: user.emailVerified,
        isActive: true,
        role: user.role ?? UserRole.USER,
        kycStatus: user.kycStatus,
      },
    };
  }

  async logout(userId: string, ip?: string) {
    await this.refreshTokenService.revokeAllForUser(userId);
    await this.auditLogService.log(AuditAction.LOGOUT, userId, ip);
    return { message: 'تم تسجيل الخروج' };
  }
}
