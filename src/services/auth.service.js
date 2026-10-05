'use strict';

const {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
  ForbiddenException,
} = require('../common/http/errors');
const bcrypt = require('bcrypt');
const { OtpPurpose } = require('../validators/auth/password-reset.dto');
const { OtpPurpose: OtpCollectionPurpose } = require('../models/otp-verification.model');
const { AuditAction } = require('../models/audit-log.model');
const { hashPassword } = require('../common/security/password-hashing');
const { SystemRole } = require('../domain/auth/roles.enum');
const { randomUUID } = require('crypto');
const {
  CONTACT_PHONE_POLICY_MESSAGE,
  normalizeContactPhone,
  normalizeIdentifier,
} = require('../common/validators/identifier.validator');
const {
  ACCESS_TOKEN_TYPE,
  PASSWORD_RESET_AUDIENCE,
  PASSWORD_RESET_TOKEN_TYPE,
  derivePasswordResetSecret,
  fingerprintsMatch,
  passwordFingerprint,
} = require('../domain/auth/token-types');
const { AuthErrorCode } = require('../common/errors/auth-error-codes');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
  identityProjection,
  isIdentifierVerified,
  resolveAccountStatus,
  resolveAccountType,
  resolveSystemRole,
} = require('../domain/users/identity.types');
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
class AuthService {
  constructor(
    usersService,
    jwtService,
    config,
    otpVerificationService,
    mailService,
    refreshTokenService,
    auditLogService,
    accountDeletionService,
    legalDocumentsService,
  ) {
    this.usersService = usersService;
    this.jwtService = jwtService;
    this.config = config;
    this.otpVerificationService = otpVerificationService;
    this.mailService = mailService;
    this.refreshTokenService = refreshTokenService;
    this.auditLogService = auditLogService;
    this.accountDeletionService = accountDeletionService;
    this.legalDocumentsService = legalDocumentsService;
  }
  assertCanAuthenticate(user) {
    const status = resolveAccountStatus(user);
    if (status === AccountStatus.DELETION_PENDING) {
      throw new ForbiddenException({
        message: 'الحساب قيد الحذف ويتطلب استعادة صريحة',
        code: AuthErrorCode.ACCOUNT_DELETION_PENDING,
      });
    }
    if (status === AccountStatus.ANONYMIZED) {
      throw new ForbiddenException({
        message: 'لا يمكن استخدام هذا الحساب',
        code: AuthErrorCode.ACCOUNT_ALREADY_ANONYMIZED,
      });
    }
    if (status === AccountStatus.BLOCKED) {
      throw new ForbiddenException({
        message: 'هذا الحساب محظور مؤقتاً',
        code: AuthErrorCode.ACCOUNT_BLOCKED,
      });
    }
    if (status === AccountStatus.PERMANENTLY_BANNED) {
      throw new ForbiddenException({
        message: 'هذا الحساب محظور نهائياً',
        code: AuthErrorCode.ACCOUNT_PERMANENTLY_BANNED,
      });
    }
    return status;
  }
  invalidResetToken() {
    return new BadRequestException({
      message: 'انتهت صلاحية الجلسة، يرجى إعادة طلب رمز التحقق',
      code: AuthErrorCode.SESSION_EXPIRED,
    });
  }
  passwordResetSecret() {
    return derivePasswordResetSecret(
      this.config.get('JWT_RESET_SECRET'),
      this.config.get('JWT_ACCESS_SECRET'),
    );
  }
  isSelfRegisteredPendingAccount(user) {
    return (
      resolveSystemRole(user) === SystemRole.USER &&
      resolveAccountType(user) === AccountType.USER &&
      resolveAccountStatus(user) === AccountStatus.ACTIVE &&
      !user.emailVerifiedAt &&
      !user.phoneVerifiedAt &&
      user.emailVerified !== true
    );
  }
  userResponse(user) {
    return {
      userId: user._id.toString(),
      id: user._id.toString(),
      _id: user._id.toString(),
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      ...identityProjection(user),
      kycStatus: user.kycStatus,
    };
  }
  /**
   * V1 authentication is email-only. Phone numbers remain valid profile/contact
   * data, but must never enter an authentication or OTP workflow until a real
   * SMS provider and the POST-V1 policy are enabled.
   */
  normalizeEmailAuthIdentifier(identifier) {
    const normalized = normalizeIdentifier(identifier);
    if (!normalized) {
      throw new BadRequestException({
        message: 'البريد الإلكتروني غير صالح',
        code: AuthErrorCode.INVALID_IDENTIFIER,
      });
    }
    if (normalized.kind === 'phone') {
      throw new ServiceUnavailableException({
        message: 'الدخول برقم الهاتف غير متاح حالياً، استخدم البريد الإلكتروني',
        code: AuthErrorCode.PHONE_AUTH_UNAVAILABLE,
      });
    }
    return normalized.value;
  }
  /**
   * Validates the contact phone for a registration. Phones are unique but
   * never verified in V1, so a number held by another established account is
   * a conflict, while one held by a never-verified sign-up can be taken.
   *
   * Nothing is written here: the returned `claim` frees the number from that
   * pending sign-up and is only called once the registration will be stored.
   */
  async resolveRegistrationPhone(rawPhone, registrant) {
    if (!rawPhone) return async () => undefined;
    const phone = normalizeContactPhone(rawPhone);
    if (!phone) {
      throw new BadRequestException({
        message: CONTACT_PHONE_POLICY_MESSAGE,
        code: AuthErrorCode.INVALID_IDENTIFIER,
      });
    }
    const phoneInUse = () =>
      new ConflictException({
        message: 'رقم الهاتف مستخدم في حساب آخر',
        code: AuthErrorCode.PHONE_ALREADY_IN_USE,
      });
    const holder = await this.usersService.findByIdentifier(phone);
    if (!holder || holder._id.toString() === registrant?._id.toString()) {
      return async () => phone;
    }
    if (!this.isSelfRegisteredPendingAccount(holder)) throw phoneInUse();
    return async () => {
      const released = await this.usersService.releaseUnverifiedPhone(holder._id.toString());
      if (!released) throw phoneInUse();
      return phone;
    };
  }
  async sendOtp(identifier, code) {
    const email = this.normalizeEmailAuthIdentifier(identifier);
    await this.mailService.sendOtp(email, code);
  }
  // ---------------------------------------------------------------------
  // REGISTER (screen 5)
  // ---------------------------------------------------------------------
  async register(dto, ip) {
    // The shared password policy + confirmPassword match are enforced by RegisterDto.
    const identifier = this.normalizeEmailAuthIdentifier(dto.identifier);
    const existing = await this.usersService.findByIdentifier(identifier);
    const claimPhone = await this.resolveRegistrationPhone(dto.phone, existing);
    // Checked before any write: a stale acceptance must not create an account.
    const legalAcceptance = await this.legalDocumentsService?.resolveAcceptance(
      dto.acceptedTermsVersion,
      dto.acceptedPrivacyVersion,
      ip,
    );
    if (existing) {
      if (!isIdentifierVerified(existing, identifier)) {
        // An unverified account has no established owner. Whoever registered
        // first must not keep control of the credentials once a later
        // registration (typically the real mailbox owner) arrives, so the
        // newest registration atomically replaces the password and name.
        await this.otpVerificationService.assertCanResend(
          identifier,
          OtpCollectionPurpose.REGISTER,
        );
        if (this.isSelfRegisteredPendingAccount(existing)) {
          const replaced = await this.usersService.replaceUnverifiedRegistration(
            existing._id.toString(),
            {
              passwordHash: await hashPassword(dto.password),
              fullName: dto.fullName,
              phone: await claimPhone(),
              legalAcceptance,
            },
          );
          if (!replaced) {
            throw new ConflictException({
              message: 'البريد الإلكتروني مسجل ومفعل بالفعل',
              code: AuthErrorCode.ACCOUNT_ALREADY_VERIFIED,
              isVerified: true,
              requiresVerification: false,
              otpSent: false,
              identifier,
            });
          }
          await this.refreshTokenService.revokeAllForUser(
            existing._id.toString(),
            'REGISTRATION_REPLACED',
          );
        }
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
    const phone = await claimPhone();
    const user = await this.usersService.create({
      fullName: dto.fullName,
      email: identifier,
      ...(phone ? { phone } : {}),
      ...(legalAcceptance ? { legalAcceptance } : {}),
      password: passwordHash,
      systemRole: SystemRole.USER,
      accountType: AccountType.USER,
      accountStatus: AccountStatus.ACTIVE,
      brokerStatus: BrokerStatus.NOT_APPLIED,
      verificationTrustState: VerificationTrustState.UNVERIFIED,
      primaryIdentifierType: PrimaryIdentifierType.EMAIL,
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
  async login(dto, ip, device) {
    const identifier = this.normalizeEmailAuthIdentifier(dto.identifier);
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
    if (resolveAccountStatus(user) === AccountStatus.DELETION_PENDING) {
      await this.auditLogService.log(AuditAction.LOGIN_FAILED, user._id.toString(), ip);
      if (this.accountDeletionService) {
        return this.accountDeletionService.pendingLoginState(user._id.toString());
      }
      this.assertCanAuthenticate(user);
    }
    try {
      this.assertCanAuthenticate(user);
    } catch (error) {
      await this.auditLogService.log(AuditAction.LOGIN_FAILED, user._id.toString(), ip);
      throw error;
    }
    if (!isIdentifierVerified(user, identifier)) {
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
    const tokens = await this.issueTokens(user._id.toString(), dto.rememberMe, device);
    await this.auditLogService.log(AuditAction.LOGIN_SUCCESS, user._id.toString(), ip);
    return {
      ...tokens,
      userId: user._id.toString(),
      id: user._id.toString(),
      user: this.userResponse(user),
    };
  }
  // ---------------------------------------------------------------------
  // FORGOT PASSWORD (screen 4) - sends a 6-digit OTP to email
  // ---------------------------------------------------------------------
  async forgotPassword(dto) {
    const identifier = this.normalizeEmailAuthIdentifier(dto.identifier);
    const user = await this.usersService.findByIdentifier(identifier);
    // Don't reveal whether the account exists
    if (!user) {
      return { message: 'إذا كان الحساب موجوداً، تم إرسال رمز التحقق' };
    }
    await this.otpVerificationService.assertCanResend(
      identifier,
      OtpCollectionPurpose.PASSWORD_RESET,
    );
    const code = await this.otpVerificationService.generateAndStore(
      identifier,
      OtpCollectionPurpose.PASSWORD_RESET,
    );
    await this.sendOtp(identifier, code);
    return { message: 'تم إرسال رمز التحقق', expiresInMinutes: 5 };
  }
  async resendOtp(dto) {
    const purpose =
      dto.purpose === OtpPurpose.REGISTER
        ? OtpCollectionPurpose.REGISTER
        : OtpCollectionPurpose.PASSWORD_RESET;
    const identifier = this.normalizeEmailAuthIdentifier(dto.identifier);
    const user = await this.usersService.findByIdentifier(identifier);
    if (!user) {
      return { message: 'إذا كان الحساب موجوداً، تم إرسال رمز التحقق' };
    }
    if (purpose === OtpCollectionPurpose.REGISTER && isIdentifierVerified(user, identifier)) {
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
  async verifyOtp(dto) {
    const purpose =
      dto.purpose === OtpPurpose.REGISTER
        ? OtpCollectionPurpose.REGISTER
        : OtpCollectionPurpose.PASSWORD_RESET;
    const identifier = this.normalizeEmailAuthIdentifier(dto.identifier);
    try {
      await this.otpVerificationService.verify(identifier, dto.otp, purpose);
    } catch (err) {
      const user = await this.usersService.findByIdentifier(identifier);
      await this.auditLogService.log(
        AuditAction.OTP_FAILED,
        user?._id?.toString() ?? null,
        undefined,
      );
      throw err;
    }
    const user = await this.usersService.findByIdentifier(
      identifier,
      dto.purpose !== OtpPurpose.REGISTER,
    );
    if (!user) {
      throw new BadRequestException('المستخدم غير موجود');
    }
    if (dto.purpose === OtpPurpose.REGISTER) this.assertCanAuthenticate(user);
    if (dto.purpose === OtpPurpose.REGISTER) {
      user.emailVerifiedAt = new Date();
      await this.usersService.save(user);
      return {
        message: 'تم تفعيل حسابك بنجاح، يمكنك تسجيل الدخول الآن',
        isVerified: true,
      };
    }
    // password_reset -> issue a short-lived, single-use resetToken. It is signed
    // with a key access tokens cannot validate against and is bound to the
    // current password hash, so it dies as soon as the password changes.
    const resetSecret = this.passwordResetSecret();
    const resetToken = this.jwtService.sign(
      {
        sub: user._id.toString(),
        typ: PASSWORD_RESET_TOKEN_TYPE,
        purpose: PASSWORD_RESET_TOKEN_TYPE,
        pwf: passwordFingerprint(resetSecret, String(user.password ?? '')),
      },
      {
        secret: resetSecret,
        expiresIn: '10m',
        audience: PASSWORD_RESET_AUDIENCE,
        jwtid: randomUUID(),
      },
    );
    return { resetToken };
  }
  // ---------------------------------------------------------------------
  // RESET PASSWORD (screen 2)
  // ---------------------------------------------------------------------
  async resetPassword(dto, ip) {
    // The shared password policy + confirmPassword match are enforced by ResetPasswordDto.
    const resetSecret = this.passwordResetSecret();
    let payload;
    try {
      payload = this.jwtService.verify(dto.resetToken, {
        secret: resetSecret,
        audience: PASSWORD_RESET_AUDIENCE,
      });
    } catch {
      throw this.invalidResetToken();
    }
    if (
      payload.purpose !== PASSWORD_RESET_TOKEN_TYPE ||
      payload.typ !== PASSWORD_RESET_TOKEN_TYPE
    ) {
      throw new BadRequestException('رمز غير صالح');
    }
    const user = await this.usersService.findById(payload.sub, true);
    if (!user) {
      throw new BadRequestException('المستخدم غير موجود');
    }
    // A used token no longer matches: the fingerprint is bound to the password
    // hash that existed when the token was issued.
    const currentHash = String(user.password ?? '');
    if (
      !currentHash ||
      !fingerprintsMatch(payload.pwf, passwordFingerprint(resetSecret, currentHash))
    ) {
      throw this.invalidResetToken();
    }
    const resetStatus = resolveAccountStatus(user);
    if (resetStatus !== AccountStatus.DELETION_PENDING) this.assertCanAuthenticate(user);
    const updated = await this.usersService.updatePasswordIfCurrent(
      user._id.toString(),
      currentHash,
      await hashPassword(dto.newPassword),
    );
    if (!updated) throw this.invalidResetToken();
    // force re-login everywhere - drop all existing sessions
    await this.refreshTokenService.revokeAllForUser(user._id.toString());
    await this.auditLogService.log(AuditAction.PASSWORD_RESET, user._id.toString(), ip);
    return { message: 'تم تحديث كلمة المرور بنجاح' };
  }
  // ---------------------------------------------------------------------
  // TOKEN HELPERS
  // ---------------------------------------------------------------------
  async issueTokens(userId, rememberMe = true, device = 'unknown') {
    const refreshExpiresIn = rememberMe
      ? (this.config.get('JWT_REFRESH_EXPIRES_IN') ?? '7d')
      : '1d';
    const expiresAt = new Date(Date.now() + this.parseDurationMs(refreshExpiresIn));
    const session = await this.refreshTokenService.createSession(userId, expiresAt, device);
    const accessToken = this.signAccessToken(userId, session.sessionId);
    return { accessToken, refreshToken: session.refreshToken };
  }
  signAccessToken(userId, sessionId) {
    return this.jwtService.sign(
      { sub: userId, sid: sessionId, typ: ACCESS_TOKEN_TYPE },
      {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        expiresIn: this.config.get('JWT_ACCESS_EXPIRES_IN') ?? '15m',
      },
    );
  }
  parseDurationMs(duration) {
    const match = /^(\d+)([smhd])$/.exec(duration);
    if (!match) return 7 * 24 * 60 * 60 * 1000; // default 7 days
    const value = Number(match[1]);
    const unit = match[2];
    const unitMs = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return value * unitMs[unit];
  }
  async refresh(refreshToken, device) {
    let legacyUserId;
    if (refreshToken.split('.').length === 3) {
      try {
        const payload = this.jwtService.verify(refreshToken, {
          secret: this.config.get('JWT_REFRESH_SECRET'),
        });
        legacyUserId = payload.sub;
      } catch {
        throw new UnauthorizedException({
          message: 'يرجى تسجيل الدخول مرة أخرى',
          code: AuthErrorCode.INVALID_REFRESH_TOKEN,
        });
      }
    }
    const refreshExpiresIn = this.config.get('JWT_REFRESH_EXPIRES_IN') ?? '7d';
    const rotated = await this.refreshTokenService.rotate(
      refreshToken,
      new Date(Date.now() + this.parseDurationMs(refreshExpiresIn)),
      device,
      legacyUserId,
    );
    const userId = rotated.userId;
    const user = await this.usersService.findById(userId);
    if (!user) {
      await this.refreshTokenService.revokeSession(userId, rotated.sessionId, 'ACCOUNT_MISSING');
      throw new UnauthorizedException({
        message: 'يرجى تسجيل الدخول مرة أخرى',
        code: AuthErrorCode.SESSION_REVOKED,
      });
    }
    try {
      this.assertCanAuthenticate(user);
    } catch (error) {
      await this.refreshTokenService.revokeAllForUser(userId);
      throw error;
    }
    const identifier = user.email ?? user.phone ?? '';
    if (!isIdentifierVerified(user, identifier)) {
      throw new UnauthorizedException({
        message: 'الحساب غير مفعل، يرجى تسجيل الدخول لإعادة التحقق',
        code: AuthErrorCode.ACCOUNT_NOT_VERIFIED,
      });
    }
    const accessToken = this.signAccessToken(userId, rotated.sessionId);
    return {
      accessToken,
      refreshToken: rotated.refreshToken,
      userId: userId,
      id: userId,
      user: this.userResponse(user),
    };
  }
  async logout(userId, sessionId, ip) {
    if (sessionId) {
      await this.refreshTokenService.revokeSession(userId, sessionId, 'LOGOUT');
    } else {
      await this.refreshTokenService.revokeAllForUser(userId, 'LEGACY_LOGOUT');
    }
    await this.auditLogService.log(AuditAction.LOGOUT, userId, ip);
    return { message: 'تم تسجيل الخروج' };
  }
  async logoutAll(userId, ip) {
    await this.refreshTokenService.revokeAllForUser(userId, 'LOGOUT_ALL');
    await this.auditLogService.log(AuditAction.LOGOUT, userId, ip);
    return { message: 'تم تسجيل الخروج من جميع الأجهزة' };
  }
  async requestAccountRecovery(dto) {
    if (!this.accountDeletionService) throw new ServiceUnavailableException();
    const recovery = await this.accountDeletionService.validateRecoveryCredentials(
      dto.identifier,
      dto.password,
    );
    await this.otpVerificationService.assertCanResend(
      recovery.identifier,
      OtpCollectionPurpose.ACCOUNT_RESTORE,
    );
    const code = await this.otpVerificationService.generateAndStore(
      recovery.identifier,
      OtpCollectionPurpose.ACCOUNT_RESTORE,
    );
    await this.sendOtp(recovery.identifier, code);
    return {
      message: 'تم إرسال رمز التحقق لاستعادة الحساب',
      workflowVersion: recovery.workflowVersion,
      recoverableUntil: recovery.recoverableUntil,
      expiresInMinutes: 5,
    };
  }
  async confirmAccountRecovery(dto, ip) {
    if (!this.accountDeletionService) throw new ServiceUnavailableException();
    const identifier = this.normalizeEmailAuthIdentifier(dto.identifier);
    await this.otpVerificationService.verify(
      identifier,
      dto.otp,
      OtpCollectionPurpose.ACCOUNT_RESTORE,
    );
    return this.accountDeletionService.restoreAfterVerification(
      identifier,
      dto.workflowVersion,
      ip,
    );
  }
}

Object.assign(exports, { AuthService });
