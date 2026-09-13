import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument, KycStatus } from './schemas/user.schema';
import { RefreshTokenService } from '../refresh-token/refresh-token.service';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { CloudinaryAssetService } from '../config/cloudinary-asset.service';
import { UserRole } from '../auth/roles.enum';
import {
  identifierLookupValues,
  normalizeIdentifier,
} from '../common/validators/identifier.validator';
import { hashPassword } from '../common/security/password-hashing';
import { AuthErrorCode } from '../common/errors/auth-error-codes';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private refreshTokenService: RefreshTokenService,
    private auditLogService: AuditLogService,
    private cloudinaryAssetService: CloudinaryAssetService,
  ) {}

  static isEmail(identifier: string): boolean {
    return normalizeIdentifier(identifier)?.kind === 'email';
  }

  async findByIdentifier(identifier: string, withSecrets = false) {
    const normalized = normalizeIdentifier(identifier);
    const query = normalized?.kind === 'email'
      ? { email: normalized.value }
      : { phone: { $in: identifierLookupValues(identifier) } };

    const q = this.userModel.findOne(query);
    if (withSecrets) {
      q.select('+password +failedLoginAttempts +accountLockedUntil');
    }
    return q.exec();
  }

  async findById(id: string, withSecrets = false) {
    const q = this.userModel.findById(id);
    if (withSecrets) {
      q.select('+password +failedLoginAttempts +accountLockedUntil');
    }
    return q.exec();
  }

  async getProfile(userId: string) {
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
      emailVerified: user.emailVerified,
      role: user.role,
      kycStatus: user.kycStatus,
        isActive: user.isActive !== false,
        suspendReason: user.suspendReason,
        suspendedAt: user.suspendedAt,
      idFrontUrl: user.idFrontUrl,
      idBackUrl: user.idBackUrl,
      selfieUrl: user.selfieUrl,
      kycSubmittedAt: user.kycSubmittedAt,
      kycReviewedAt: user.kycReviewedAt,
      kycRejectionReason: user.kycRejectionReason,
      createdAt: (user as any).createdAt,
      updatedAt: (user as any).updatedAt,
    };
  }

  async updateProfile(userId: string, fullName: string, ip?: string) {
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    user.fullName = fullName.trim();
    await this.save(user);
    await this.auditLogService.log(AuditAction.PROFILE_UPDATED, userId, ip);

    return {
      message: 'تم تحديث البيانات الشخصية بنجاح',
      ...(await this.getProfile(userId)),
    };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ip?: string,
  ) {
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

  async listForAdmin(options: {
    page: number;
    limit: number;
    search?: string;
    role?: UserRole;
    emailVerified?: boolean;
  }) {
    const { page, limit, search, role, emailVerified } = options;
    const filter: Record<string, any> = {};

    if (search) {
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const expression = new RegExp(escapedSearch, 'i');
      filter.$or = [
        { fullName: expression },
        { email: expression },
        { phone: expression },
      ];
    }
    if (role) filter.role = role;
    if (emailVerified !== undefined) filter.emailVerified = emailVerified;

    const [users, total] = await Promise.all([
      this.userModel
        .find(filter)
        .select('fullName email phone role emailVerified kycStatus createdAt updatedAt')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);

    return {
      message: 'تم تحميل المستخدمين بنجاح',
      items: users.map((user: any) => ({
        userId: user._id.toString(),
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        emailVerified: user.emailVerified,
        kycStatus: user.kycStatus,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }


  async getUserDetailsForAdmin(targetUserId: string) {
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException('معرف المستخدم غير صالح');
    }
    const user = await this.findById(targetUserId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    return {
      userId: user._id.toString(),
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      emailVerified: user.emailVerified,
      isActive: user.isActive !== false,
      suspendReason: user.suspendReason,
      suspendedAt: user.suspendedAt,
      kycStatus: user.kycStatus,
      kycSubmittedAt: user.kycSubmittedAt,
      kycReviewedAt: user.kycReviewedAt,
      kycRejectionReason: user.kycRejectionReason,
      createdAt: (user as any).createdAt,
      updatedAt: (user as any).updatedAt,
    };
  }

  async updateStatusForAdmin(options: {
    actorUserId: string;
    targetUserId: string;
    isActive: boolean;
    reason: string;
    ip?: string;
  }) {
    const { actorUserId, targetUserId, isActive, reason, ip } = options;
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException('معرف المستخدم غير صالح');
    }
    if (actorUserId === targetUserId) {
      throw new ForbiddenException('لا يمكنك تعديل حالة حسابك الإداري الحالي');
    }

    const user = await this.findById(targetUserId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    if (user.role === UserRole.ADMIN && !isActive) {
      throw new ForbiddenException('لا يمكن تجميد حساب إداري');
    }

    user.isActive = isActive;
    user.suspendReason = isActive ? undefined : reason;
    user.suspendedAt = isActive ? undefined : new Date();
    await this.save(user);

    if (!isActive) {
      await this.refreshTokenService.revokeAllForUser(targetUserId);
    }

    await this.auditLogService.logAdminAction(
      AuditAction.ADMIN_USER_STATUS_UPDATED,
      actorUserId,
      targetUserId,
      reason,
      ip,
    );

    return {
      message: isActive ? 'تم تفعيل الحساب بنجاح' : 'تم تجميد الحساب بنجاح',
      userId: targetUserId,
      isActive: user.isActive,
    };
  }

  async revokeSessionsForAdmin(options: {
    actorUserId: string;
    targetUserId: string;
    reason?: string;
    ip?: string;
  }) {
    const { actorUserId, targetUserId, reason, ip } = options;
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException('معرف المستخدم غير صالح');
    }

    const user = await this.findById(targetUserId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    await this.refreshTokenService.revokeAllForUser(targetUserId);

    await this.auditLogService.logAdminAction(
      AuditAction.ADMIN_USER_SESSIONS_REVOKED,
      actorUserId,
      targetUserId,
      reason ?? 'إلغاء الجلسات بواسطة الإدارة',
      ip,
    );

    return {
      message: 'تم إلغاء كافة الجلسات النشطة للمستخدم بنجاح',
      userId: targetUserId,
    };
  }

  async updateRoleForAdmin(options: {
    actorUserId: string;
    targetUserId: string;
    role: UserRole;
    reason: string;
    ip?: string;
  }) {
    const { actorUserId, targetUserId, role, reason, ip } = options;
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException('معرف المستخدم غير صالح');
    }
    if (actorUserId === targetUserId) {
      throw new ForbiddenException('لا يمكنك تغيير دورك الخاص');
    }

    const user = await this.findById(targetUserId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    user.role = role;
    await this.save(user);

    // Revoke sessions so new role takes effect on next login/token issuance
    await this.refreshTokenService.revokeAllForUser(targetUserId);

    await this.auditLogService.logAdminAction(
      AuditAction.ADMIN_USER_ROLE_UPDATED,
      actorUserId,
      targetUserId,
      reason,
      ip,
    );

    return {
      message: 'تم تحديث دور المستخدم بنجاح',
      userId: targetUserId,
      role: user.role,
    };
  }


  async listKycForAdmin(options: {
    page?: number;
    limit?: number;
    status?: string;
    search?: string;
  }) {
    const page = Math.max(Number(options.page) || 1, 1);
    const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
    const filter: any = {};

    if (options.status && options.status !== 'all') {
      filter.kycStatus = options.status;
    } else {
      filter.kycStatus = { $ne: KycStatus.NOT_SUBMITTED };
    }

    if (options.search?.trim()) {
      const regex = new RegExp(options.search.trim(), 'i');
      filter.$or = [{ fullName: regex }, { email: regex }, { phone: regex }];
    }

    const [items, total] = await Promise.all([
      this.userModel
        .find(filter)
        .sort({ kycSubmittedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);

    return {
      message: 'تم تحميل طلبات التحقق بنجاح',
      items: items.map((user: any) => ({
        userId: user._id.toString(),
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        kycStatus: user.kycStatus,
        kycSubmittedAt: user.kycSubmittedAt,
        kycReviewedAt: user.kycReviewedAt,
        kycRejectionReason: user.kycRejectionReason,
        createdAt: user.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getKycDetailsForAdmin(targetUserId: string) {
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException('معرف المستخدم غير صالح');
    }
    const user = await this.findById(targetUserId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    return {
      userId: user._id.toString(),
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      kycStatus: user.kycStatus,
      hasIdFront: Boolean(user.idFrontAsset?.publicId),
      hasIdBack: Boolean(user.idBackAsset?.publicId),
      hasSelfie: Boolean(user.selfieAsset?.publicId),
      kycSubmittedAt: user.kycSubmittedAt,
      kycReviewedAt: user.kycReviewedAt,
      kycRejectionReason: user.kycRejectionReason,
      createdAt: (user as any).createdAt,
    };
  }

  async getKycAssetForAdmin(
    targetUserId: string,
    document: 'id-front' | 'id-back' | 'selfie',
  ) {
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException('معرف المستخدم غير صالح');
    }

    const user = await this.findById(targetUserId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    const assets = {
      'id-front': user.idFrontAsset,
      'id-back': user.idBackAsset,
      selfie: user.selfieAsset,
    };
    const asset = assets[document];
    if (!asset?.publicId) {
      throw new NotFoundException(
        'مستند التحقق غير متاح أو يفتقد بيانات التخزين الآمنة',
      );
    }
    return asset;
  }

  async reviewKycForAdmin(options: {
    actorUserId: string;
    targetUserId: string;
    decision: 'verified' | 'rejected';
    rejectionReason?: string;
    ip?: string;
  }) {
    const { actorUserId, targetUserId, decision, rejectionReason, ip } = options;
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException('معرف المستخدم غير صالح');
    }
    const user = await this.findById(targetUserId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    if (decision === 'rejected' && (!rejectionReason || rejectionReason.trim().length < 5)) {
      throw new BadRequestException('سبب رفض التوثيق يجب ألا يقل عن 5 أحرف');
    }

    user.kycStatus = decision === 'verified' ? KycStatus.VERIFIED : KycStatus.REJECTED;
    user.kycReviewedAt = new Date();
    user.kycRejectionReason = decision === 'rejected' ? rejectionReason?.trim() : undefined;

    await this.save(user);

    await this.auditLogService.logAdminAction(
      AuditAction.ADMIN_KYC_REVIEWED,
      actorUserId,
      targetUserId,
      decision === 'verified'
        ? 'قبول وتوثيق الهوية بنجاح'
        : 'رفض طلب التوثيق مع السبب: ' + rejectionReason?.trim(),
      ip,
    );

    return {
      message: decision === 'verified' ? 'تم توثيق هوية المستخدم بنجاح' : 'تم رفض طلب التوثيق',
      userId: targetUserId,
      kycStatus: user.kycStatus,
    };
  }

  async getDashboardMetricsForAdmin() {
    const [
      totalUsers,
      verifiedUsers,
      unverifiedUsers,
      activeUsers,
      suspendedUsers,
      pendingKyc,
      verifiedKyc,
      rejectedKyc,
      recentUsers,
      recentAuditLogs,
    ] = await Promise.all([
      this.userModel.countDocuments().exec(),
      this.userModel.countDocuments({ emailVerified: true }).exec(),
      this.userModel.countDocuments({ emailVerified: false }).exec(),
      this.userModel.countDocuments({ isActive: { $ne: false } }).exec(),
      this.userModel.countDocuments({ isActive: false }).exec(),
      this.userModel.countDocuments({ kycStatus: KycStatus.PENDING }).exec(),
      this.userModel.countDocuments({ kycStatus: KycStatus.VERIFIED }).exec(),
      this.userModel.countDocuments({ kycStatus: KycStatus.REJECTED }).exec(),
      this.userModel
        .find()
        .sort({ createdAt: -1 })
        .limit(5)
        .select('fullName email phone emailVerified kycStatus createdAt')
        .lean()
        .exec(),
      this.auditLogService.getRecentForAdmin(5),
    ]);

    return {
      users: {
        total: totalUsers,
        verified: verifiedUsers,
        unverified: unverifiedUsers,
        active: activeUsers,
        suspended: suspendedUsers,
      },
      kyc: {
        pending: pendingKyc,
        verified: verifiedKyc,
        rejected: rejectedKyc,
      },
      recentUsers: recentUsers.map((u: any) => ({
        userId: u._id.toString(),
        fullName: u.fullName,
        email: u.email,
        phone: u.phone,
        emailVerified: u.emailVerified,
        kycStatus: u.kycStatus,
        createdAt: u.createdAt,
      })),
      recentAuditLogs,
    };
  }

  async deleteForAdmin(options: {
    actorUserId: string;
    targetUserId: string;
    confirmIdentifier: string;
    reason: string;
    ip?: string;
  }) {
    const { actorUserId, targetUserId, confirmIdentifier, reason, ip } = options;
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException('معرف المستخدم غير صالح');
    }
    if (actorUserId === targetUserId) {
      throw new ForbiddenException('لا يمكنك حذف حسابك الإداري الحالي');
    }

    const user = await this.findById(targetUserId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    if (user.role === UserRole.ADMIN) {
      throw new ForbiddenException('لا يمكن حذف حساب إداري من هذه الشاشة');
    }

    const identifier = user.email ?? user.phone ?? '';
    if (
      !identifier ||
      identifier.trim().toLowerCase() !== confirmIdentifier.trim().toLowerCase()
    ) {
      throw new BadRequestException('بيانات تأكيد المستخدم غير مطابقة');
    }

    await this.cloudinaryAssetService.deleteAssets([
      user.idFrontAsset,
      user.idBackAsset,
      user.selfieAsset,
    ]);
    await this.refreshTokenService.revokeAllForUser(targetUserId);
    await this.userModel.findByIdAndDelete(targetUserId).exec();
    await this.auditLogService.logAdminAction(
      AuditAction.ADMIN_USER_DELETED,
      actorUserId,
      targetUserId,
      reason,
      ip,
    );

    return {
      message: 'تم حذف المستخدم نهائياً',
      userId: targetUserId,
    };
  }

  async deleteAccount(userId: string, password: string, ip?: string) {
    const user = await this.findById(userId, true);
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('كلمة المرور غير صحيحة لتأكيد حذف الحساب');
    }

    // Delete KYC assets whose Cloudinary identifiers are available before removing
    // their only database references. Legacy URL-only assets are documented separately.
    await this.cloudinaryAssetService.deleteAssets([
      user.idFrontAsset,
      user.idBackAsset,
      user.selfieAsset,
    ]);

    // 1. Revoke all refresh tokens
    await this.refreshTokenService.revokeAllForUser(userId);

    // 2. Audit log the account deletion
    await this.auditLogService.log(AuditAction.ACCOUNT_DELETED, userId, ip);

    // 3. Permanently remove the user document
    await this.userModel.findByIdAndDelete(userId).exec();

    return {
      message: 'تم حذف الحساب نهائياً بنجاح',
      userId,
    };
  }

  async create(data: Partial<User>) {
    return this.userModel.create(data);
  }

  async save(user: UserDocument) {
    return user.save();
  }
}
