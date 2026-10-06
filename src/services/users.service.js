'use strict';

const {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} = require('../common/http/errors');
const bcrypt = require('bcrypt');
const { AuditAction } = require('../models/audit-log.model');
const { SystemRole } = require('../domain/auth/roles.enum');
const {
  CONTACT_PHONE_POLICY_MESSAGE,
  identifierLookupValues,
  normalizeContactPhone,
  normalizeIdentifier,
} = require('../common/validators/identifier.validator');
const { hashPassword } = require('../common/security/password-hashing');
const { AuthErrorCode } = require('../common/errors/auth-error-codes');
const { validateEvidenceFile } = require('../common/uploads/evidence-file.validator');
const { EvidenceErrorCode } = require('../common/errors/evidence-error-codes');
const {
  AccountStatus,
  PrimaryIdentifierType,
  identityProjection,
  resolveAccountStatus,
  resolveSystemRole,
} = require('../domain/users/identity.types');
const PROFILE_PHOTO_POLICY = {
  kind: 'image',
  maxBytes: 5 * 1024 * 1024,
  maxImagePixels: 25_000_000,
};
class UsersService {
  constructor(userModel, refreshTokenService, auditLogService, connection, outbox, assets) {
    this.userModel = userModel;
    this.refreshTokenService = refreshTokenService;
    this.auditLogService = auditLogService;
    this.connection = connection;
    this.outbox = outbox;
    this.assets = assets;
  }
  async findByIdentifier(identifier, withSecrets = false) {
    const normalized = normalizeIdentifier(identifier);
    const query =
      normalized?.kind === 'email'
        ? { email: normalized.value }
        : { phone: { $in: identifierLookupValues(identifier) } };
    const q = this.userModel.findOne(query);
    if (withSecrets) {
      q.select('+password +failedLoginAttempts +accountLockedUntil');
    }
    return q.exec();
  }
  async findById(id, withSecrets = false) {
    const q = this.userModel.findById(id);
    if (withSecrets) {
      q.select('+password +failedLoginAttempts +accountLockedUntil');
    }
    return q.exec();
  }
  async getProfile(userId) {
    const user = await this.userModel.findById(userId).exec();
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }
    return {
      userId: user._id.toString(),
      id: user._id.toString(),
      _id: user._id.toString(),
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      profilePhotoUrl: user.profilePhoto?.secureUrl ?? null,
      ...identityProjection(user),
      kycStatus: user.kycStatus,
      suspendReason: user.suspendReason,
      suspendedAt: user.suspendedAt,
      hasKycEvidence: Boolean(
        user.idFrontAsset?.publicId && user.idBackAsset?.publicId && user.selfieAsset?.publicId,
      ),
      kycSubmittedAt: user.kycSubmittedAt,
      kycReviewedAt: user.kycReviewedAt,
      kycRejectionReason: user.kycRejectionReason,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
  async updateProfile(userId, changes, ip) {
    if (changes.fullName === undefined && changes.phone === undefined) {
      throw new BadRequestException('لا توجد بيانات للتحديث');
    }
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    if (changes.fullName !== undefined) user.fullName = changes.fullName.trim();
    if (changes.phone !== undefined) {
      user.phone = await this.claimContactPhone(user, changes.phone);
    }
    try {
      await this.save(user);
    } catch (error) {
      // Another account took the number between the check and the write.
      if (error?.code === 11000) throw this.phoneInUse();
      throw error;
    }
    await this.auditLogService.log(AuditAction.PROFILE_UPDATED, userId, ip);
    return {
      message: 'تم تحديث البيانات الشخصية بنجاح',
      ...(await this.getProfile(userId)),
    };
  }
  /**
   * Replaces the user's profile photo. The new image is stored before the
   * account is updated and the old one is removed last, so a failed upload
   * never leaves the account without the photo it had.
   */
  async updateProfilePhoto(userId, file, ip) {
    if (!file) {
      throw new BadRequestException({
        message: 'الصورة الشخصية مطلوبة',
        code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED,
      });
    }
    const assets = this.requireAssets();
    const detected = validateEvidenceFile(file, PROFILE_PHOTO_POLICY);
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    const previous = user.profilePhoto;
    const uploaded = await assets.uploadPublicProfilePhoto(file, detected);
    user.profilePhoto = uploaded;
    try {
      await this.save(user);
    } catch (error) {
      await assets.deleteOrEnqueue([uploaded], 'profile-photo-save-failed');
      throw error;
    }
    await assets.deleteOrEnqueue([previous], 'profile-photo-replaced');
    await this.auditLogService.log(AuditAction.PROFILE_UPDATED, userId, ip);
    return {
      message: 'تم تحديث الصورة الشخصية بنجاح',
      ...(await this.getProfile(userId)),
    };
  }
  async removeProfilePhoto(userId, ip) {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    await this.clearProfilePhoto(user, 'profile-photo-removed');
    await this.auditLogService.log(AuditAction.PROFILE_UPDATED, userId, ip);
    return {
      message: 'تم حذف الصورة الشخصية',
      ...(await this.getProfile(userId)),
    };
  }
  async clearProfilePhoto(user, reason) {
    const previous = user.profilePhoto;
    if (!previous) return false;
    user.profilePhoto = undefined;
    await this.save(user);
    // The account no longer points at the image; removal from storage may be retried.
    await this.assets?.deleteOrEnqueue([previous], reason);
    return true;
  }
  requireAssets() {
    if (!this.assets) {
      throw new ServiceUnavailableException({
        message: 'تعذر رفع الصورة الشخصية، حاول مرة أخرى لاحقاً',
        code: EvidenceErrorCode.UPLOAD_FAILED,
      });
    }
    return this.assets;
  }
  /**
   * Validates a new contact phone for an existing account, with the same
   * ownership rule as registration: a number held by an established account
   * is a conflict, one held only by a never-verified sign-up is released.
   */
  async claimContactPhone(user, rawPhone) {
    const phone = normalizeContactPhone(rawPhone);
    if (!phone) {
      throw new BadRequestException({
        message: CONTACT_PHONE_POLICY_MESSAGE,
        code: AuthErrorCode.INVALID_IDENTIFIER,
      });
    }
    if (phone === user.phone) return phone;
    // A verified phone is a sign-in identifier; replacing it here would
    // bypass ownership verification.
    if (user.phoneVerifiedAt || user.primaryIdentifierType === PrimaryIdentifierType.PHONE) {
      throw new ConflictException({
        message: 'لا يمكن تغيير رقم الهاتف المستخدم لتسجيل الدخول',
        code: AuthErrorCode.PHONE_CHANGE_NOT_ALLOWED,
      });
    }
    const holder = await this.findByIdentifier(phone);
    if (holder && holder._id.toString() !== user._id.toString()) {
      const pendingSignUp =
        resolveSystemRole(holder) === SystemRole.USER &&
        resolveAccountStatus(holder) === AccountStatus.ACTIVE &&
        !holder.emailVerifiedAt &&
        !holder.phoneVerifiedAt &&
        holder.emailVerified !== true;
      if (!pendingSignUp || !(await this.releaseUnverifiedPhone(holder._id.toString()))) {
        throw this.phoneInUse();
      }
    }
    return phone;
  }
  phoneInUse() {
    return new ConflictException({
      message: 'رقم الهاتف مستخدم في حساب آخر',
      code: AuthErrorCode.PHONE_ALREADY_IN_USE,
    });
  }
  async changePassword(userId, currentPassword, newPassword, ip) {
    const user = await this.findById(userId, true);
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      throw new UnauthorizedException({
        message: 'كلمة المرور الحالية غير صحيحة',
        code: AuthErrorCode.INVALID_CURRENT_PASSWORD,
      });
    }
    user.password = await hashPassword(newPassword);
    user.failedLoginAttempts = 0;
    user.accountLockedUntil = undefined;
    await this.save(user);
    await this.refreshTokenService.revokeAllForUser(userId);
    await this.auditLogService.log(AuditAction.PASSWORD_CHANGED, userId, ip);
    return {
      message: 'تم تغيير كلمة المرور بنجاح، يرجى تسجيل الدخول مرة أخرى',
      sessionsRevoked: true,
    };
  }
  async create(data) {
    return this.userModel.create(data);
  }
  async save(user) {
    return user.save();
  }
  /**
   * Compare-and-set password change used by single-use reset tokens: only
   * succeeds while the stored hash is still the one the token was issued for.
   */
  async updatePasswordIfCurrent(userId, currentPasswordHash, newPasswordHash) {
    const result = await this.userModel
      .updateOne(
        { _id: userId, password: currentPasswordHash },
        {
          $set: { password: newPasswordHash, failedLoginAttempts: 0 },
          $unset: { accountLockedUntil: 1 },
        },
      )
      .exec();
    return result.modifiedCount === 1;
  }
  /**
   * Atomically replaces the credentials of a self-registered account that has
   * never proven ownership of any identifier. Returns false if the account was
   * verified concurrently, in which case nothing is modified.
   */
  async replaceUnverifiedRegistration(userId, data) {
    const result = await this.userModel
      .updateOne(
        {
          _id: userId,
          emailVerifiedAt: { $exists: false },
          phoneVerifiedAt: { $exists: false },
          emailVerified: { $ne: true },
        },
        {
          $set: {
            password: data.passwordHash,
            fullName: data.fullName,
            failedLoginAttempts: 0,
            ...(data.phone ? { phone: data.phone } : {}),
            ...(data.legalAcceptance ? { legalAcceptance: data.legalAcceptance } : {}),
          },
          $unset: { accountLockedUntil: 1 },
        },
      )
      .exec();
    return result.modifiedCount === 1;
  }
  /**
   * Frees a contact phone held by a registration that was never verified, so
   * an unconfirmed sign-up cannot reserve somebody else's number.
   */
  async releaseUnverifiedPhone(userId) {
    const result = await this.userModel
      .updateOne(
        {
          _id: userId,
          emailVerifiedAt: { $exists: false },
          phoneVerifiedAt: { $exists: false },
          emailVerified: { $ne: true },
        },
        { $unset: { phone: 1 } },
      )
      .exec();
    return result.modifiedCount === 1;
  }
}

Object.assign(exports, { UsersService });
