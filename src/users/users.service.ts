import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument, KycStatus, UserLegalAcceptance } from './schemas/user.schema';
import { RefreshTokenService } from '../refresh-token/refresh-token.service';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { SystemRole } from '../auth/roles.enum';
import {
  identifierLookupValues,
  normalizeIdentifier,
} from '../common/validators/identifier.validator';
import { hashPassword } from '../common/security/password-hashing';
import { AuthErrorCode } from '../common/errors/auth-error-codes';
import { AssetClassification } from '../config/evidence-asset.types';
import {
  AccountType,
  AccountStatus,
  VerificationTrustState,
  identityProjection,
  resolveAccountStatus,
  resolveSystemRole,
} from './identity.types';
import { AuthorizationErrorCode } from '../authorization/authorization-error-codes';
import { kycDecisionEvent } from '../outbox/outbox-events';
import { OutboxService } from '../outbox/outbox.service';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private refreshTokenService: RefreshTokenService,
    private auditLogService: AuditLogService,
    @InjectConnection() private readonly connection: Connection,
    private readonly outbox: OutboxService,
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
      ...identityProjection(user),
      kycStatus: user.kycStatus,
      suspendReason: user.suspendReason,
      suspendedAt: user.suspendedAt,
      hasKycEvidence: Boolean(
        user.idFrontAsset?.publicId &&
        user.idBackAsset?.publicId &&
        user.selfieAsset?.publicId,
      ),
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
    systemRole?: SystemRole;
    accountType?: AccountType;
    contactVerified?: boolean;
  }) {
    const { page, limit, search, systemRole, accountType, contactVerified } = options;
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
    const compatibilityPredicates: Record<string, unknown>[] = [];
    if (systemRole) {
      compatibilityPredicates.push({
        $or: [
          { systemRole },
          ...(systemRole === SystemRole.USER ? [{ role: 'user' }] : []),
          ...(systemRole === SystemRole.ADMIN ? [{ role: 'admin' }] : []),
        ],
      });
    }
    if (accountType) {
      compatibilityPredicates.push(
        accountType === AccountType.USER
          ? { $or: [{ accountType }, { accountType: { $exists: false } }] }
          : { accountType },
      );
    }
    if (contactVerified !== undefined) {
      const verifiedPredicate = {
        $or: [
          { emailVerifiedAt: { $exists: true } },
          { phoneVerifiedAt: { $exists: true } },
          { emailVerified: true },
        ],
      };
      compatibilityPredicates.push(
        contactVerified ? verifiedPredicate : { $nor: verifiedPredicate.$or },
      );
    }
    if (compatibilityPredicates.length) filter.$and = compatibilityPredicates;

    const [users, total] = await Promise.all([
      this.userModel
        .find(filter)
        .select('fullName email phone systemRole accountType accountStatus brokerStatus brokerVersion verificationTrustState primaryIdentifierType emailVerifiedAt phoneVerifiedAt legacyVerifiedIdentifierType role emailVerified isActive kycStatus deletionRequestedAt deletionRecoverableUntil anonymizationStartedAt anonymizedAt createdAt updatedAt')
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
        ...identityProjection(user),
        kycStatus: user.kycStatus,
        kycVersion: user.kycVersion ?? 0,
        deletionRequestedAt: user.deletionRequestedAt,
        deletionRecoverableUntil: user.deletionRecoverableUntil,
        anonymizationStartedAt: user.anonymizationStartedAt,
        anonymizedAt: user.anonymizedAt,
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
      ...identityProjection(user),
      suspendReason: user.suspendReason,
      suspendedAt: user.suspendedAt,
      kycStatus: user.kycStatus,
      kycVersion: user.kycVersion ?? 0,
      kycSubmittedAt: user.kycSubmittedAt,
      kycReviewedAt: user.kycReviewedAt,
      kycRejectionReason: user.kycRejectionReason,
      deletionRequestedAt: user.deletionRequestedAt,
      deletionRecoverableUntil: user.deletionRecoverableUntil,
      anonymizationStartedAt: user.anonymizationStartedAt,
      anonymizedAt: user.anonymizedAt,
      createdAt: (user as any).createdAt,
      updatedAt: (user as any).updatedAt,
    };
  }

  async updateStatusForAdmin(options: {
    actorUserId: string;
    actorSystemRole: SystemRole;
    targetUserId: string;
    accountStatus: AccountStatus;
    reason: string;
    ip?: string;
  }) {
    const { actorUserId, actorSystemRole, targetUserId, accountStatus, reason, ip } = options;
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException('معرف المستخدم غير صالح');
    }
    if (actorUserId === targetUserId) {
      throw this.authorizationDenied('لا يمكنك تعديل حالة حسابك الإداري الحالي');
    }

    const user = await this.findById(targetUserId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    const targetRole = resolveSystemRole(user);
    if (targetRole === SystemRole.SUPER_ADMIN) {
      throw this.authorizationDenied('لا يمكن إدارة حساب SUPER_ADMIN من المنتج');
    }
    if (actorSystemRole !== SystemRole.SUPER_ADMIN && targetRole !== SystemRole.USER) {
      throw this.authorizationDenied('إدارة حسابات ADMIN متاحة لـ SUPER_ADMIN فقط');
    }
    const previousStatus = resolveAccountStatus(user);
    if (
      previousStatus === AccountStatus.DELETION_PENDING ||
      previousStatus === AccountStatus.ANONYMIZED ||
      accountStatus === AccountStatus.DELETION_PENDING ||
      accountStatus === AccountStatus.ANONYMIZED
    ) {
      throw new ConflictException({
        message: 'تدار حالة الحذف من مسار الخصوصية المخصص فقط',
        code: AuthErrorCode.DELETION_REQUEST_CONFLICT,
      });
    }
    if (
      previousStatus === AccountStatus.PERMANENTLY_BANNED &&
      accountStatus !== AccountStatus.PERMANENTLY_BANNED &&
      actorSystemRole !== SystemRole.SUPER_ADMIN
    ) {
      throw this.authorizationDenied('استعادة الحظر الدائم متاحة لـ SUPER_ADMIN فقط');
    }

    user.accountStatus = accountStatus;
    user.suspendReason = accountStatus === AccountStatus.ACTIVE ? undefined : reason;
    user.suspendedAt = accountStatus === AccountStatus.ACTIVE ? undefined : new Date();
    await this.save(user);

    if (
      accountStatus === AccountStatus.BLOCKED ||
      accountStatus === AccountStatus.PERMANENTLY_BANNED
    ) {
      await this.refreshTokenService.revokeAllForUser(targetUserId);
    }

    await this.auditLogService.logAdminAction(
      AuditAction.ADMIN_USER_STATUS_UPDATED,
      actorUserId,
      targetUserId,
      reason,
      ip,
      {
        before: { accountStatus: previousStatus },
        after: { accountStatus },
      },
    );

    return {
      message: 'تم تحديث حالة الحساب بنجاح',
      userId: targetUserId,
      accountStatus,
      isActive: accountStatus === AccountStatus.ACTIVE,
    };
  }

  async revokeSessionsForAdmin(options: {
    actorUserId: string;
    actorSystemRole: SystemRole;
    targetUserId: string;
    reason?: string;
    ip?: string;
  }) {
    const { actorUserId, actorSystemRole, targetUserId, reason, ip } = options;
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException('معرف المستخدم غير صالح');
    }

    const user = await this.findById(targetUserId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    const targetSystemRole = resolveSystemRole(user);
    if (targetSystemRole === SystemRole.SUPER_ADMIN) {
      throw this.authorizationDenied('لا يمكن للمنتج التحكم في حساب المدير الأعلى');
    }
    if (
      actorSystemRole !== SystemRole.SUPER_ADMIN &&
      targetSystemRole !== SystemRole.USER
    ) {
      throw this.authorizationDenied('يمكن للمدير الأعلى فقط التحكم في جلسات المديرين');
    }

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
    actorSystemRole: SystemRole;
    targetUserId: string;
    systemRole: SystemRole.USER | SystemRole.ADMIN;
    reason: string;
    ip?: string;
  }) {
    const { actorUserId, actorSystemRole, targetUserId, systemRole, reason, ip } = options;
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException('معرف المستخدم غير صالح');
    }
    if (actorUserId === targetUserId) {
      throw this.authorizationDenied('لا يمكنك تغيير دورك الخاص');
    }
    if (actorSystemRole !== SystemRole.SUPER_ADMIN) {
      throw this.authorizationDenied('إدارة أدوار النظام متاحة لـ SUPER_ADMIN فقط');
    }

    const user = await this.findById(targetUserId);
    if (!user) throw new NotFoundException('المستخدم غير موجود');

    const previousSystemRole = resolveSystemRole(user);
    if (previousSystemRole === SystemRole.SUPER_ADMIN) {
      throw this.authorizationDenied('لا يمكن التحكم في SUPER_ADMIN من المنتج');
    }
    user.systemRole = systemRole;
    await this.save(user);

    // Revoke sessions so new role takes effect on next login/token issuance
    await this.refreshTokenService.revokeAllForUser(targetUserId);

    await this.auditLogService.logAdminAction(
      AuditAction.ADMIN_USER_ROLE_UPDATED,
      actorUserId,
      targetUserId,
      reason,
      ip,
      {
        before: { systemRole: previousSystemRole },
        after: { systemRole },
      },
    );

    return {
      message: 'تم تحديث دور المستخدم بنجاح',
      userId: targetUserId,
      systemRole: user.systemRole,
      role: user.systemRole === SystemRole.USER ? 'user' : 'admin',
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
        kycVersion: user.kycVersion ?? 0,
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
      kycVersion: user.kycVersion ?? 0,
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
    return {
      ...asset,
      resourceType: asset.resourceType ?? 'image',
      deliveryType: asset.deliveryType ?? 'authenticated',
      classification: asset.classification ?? AssetClassification.PRIVATE_KYC_EVIDENCE,
    };
  }

  async logKycEvidenceAccess(actorUserId: string, targetUserId: string, document: string, ip?: string) {
    await this.auditLogService.logAdminAction(
      AuditAction.PRIVATE_EVIDENCE_ACCESSED,
      actorUserId,
      targetUserId,
      `kyc-document:${document}`,
      ip,
    );
  }

  async reviewKycForAdmin(options: {
    actorUserId: string;
    targetUserId: string;
    decision: 'verified' | 'rejected';
    rejectionReason?: string;
    expectedVersion: number;
    ip?: string;
  }) {
    const {
      actorUserId,
      targetUserId,
      decision,
      rejectionReason,
      expectedVersion,
      ip,
    } = options;
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException('معرف المستخدم غير صالح');
    }
    if (decision === 'rejected' && (!rejectionReason || rejectionReason.trim().length < 5)) {
      throw new BadRequestException('سبب رفض التوثيق يجب ألا يقل عن 5 أحرف');
    }

    const nextStatus =
      decision === 'verified' ? KycStatus.VERIFIED : KycStatus.REJECTED;
    const reviewedAt = new Date();
    const normalizedReason =
      decision === 'rejected' ? rejectionReason?.trim() : undefined;
    const versionPredicate =
      expectedVersion === 0
        ? { $or: [{ kycVersion: 0 }, { kycVersion: { $exists: false } }] }
        : { kycVersion: expectedVersion };
    const update: Record<string, unknown> = {
      $set: {
        kycStatus: nextStatus,
        verificationTrustState:
          decision === 'verified'
            ? VerificationTrustState.VERIFIED
            : VerificationTrustState.UNVERIFIED,
        kycReviewedAt: reviewedAt,
        ...(normalizedReason
          ? { kycRejectionReason: normalizedReason }
          : {}),
      },
      $inc: { kycVersion: 1 },
      ...(normalizedReason ? {} : { $unset: { kycRejectionReason: 1 } }),
    };
    const session = await this.connection.startSession();
    let user: UserDocument | null = null;
    try {
      await session.withTransaction(async () => {
        user = await this.userModel
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(targetUserId),
              kycStatus: KycStatus.PENDING,
              ...versionPredicate,
            },
            update,
            { new: true, runValidators: true, session },
          )
          .exec();

        if (!user) {
          const current = await this.userModel
            .findById(targetUserId)
            .select('kycStatus kycVersion')
            .session(session)
            .lean()
            .exec();
          if (!current) throw new NotFoundException('المستخدم غير موجود');
          if (current.kycStatus !== KycStatus.PENDING) {
            throw new ConflictException({ message: 'تمت مراجعة طلب التحقق بالفعل', code: 'KYC_ALREADY_REVIEWED' });
          }
          throw new ConflictException({ message: 'تم تحديث طلب التحقق، يرجى إعادة تحميل البيانات', code: 'KYC_REVIEW_VERSION_CONFLICT' });
        }

        await this.auditLogService.logRequired({
          action: AuditAction.ADMIN_KYC_REVIEWED,
          actorUserId,
          targetUserId,
          reason: decision === 'verified' ? 'قبول وتوثيق الهوية بنجاح' : 'رفض طلب التوثيق مع السبب: ' + normalizedReason,
          ip,
          metadata: {
            before: { kycStatus: KycStatus.PENDING, kycVersion: expectedVersion },
            after: {
              kycStatus: nextStatus,
              verificationTrustState: decision === 'verified' ? VerificationTrustState.VERIFIED : VerificationTrustState.UNVERIFIED,
              kycVersion: expectedVersion + 1,
              kycReviewedAt: reviewedAt.toISOString(),
              ...(normalizedReason ? { kycRejectionReason: normalizedReason } : {}),
            },
          },
        }, session);
        await this.outbox.recordRequired(kycDecisionEvent({
          accountId: targetUserId,
          occurredAt: reviewedAt,
          decision,
          kycVersion: expectedVersion + 1,
        }), session);
      });
    } finally {
      await session.endSession();
    }

    if (!user) throw new ConflictException({ message: 'تعذر مراجعة طلب التحقق', code: 'KYC_REVIEW_VERSION_CONFLICT' });

    return {
      message: decision === 'verified' ? 'تم توثيق هوية المستخدم بنجاح' : 'تم رفض طلب التوثيق',
      userId: targetUserId,
      kycStatus: (user as UserDocument).kycStatus,
      kycVersion: (user as UserDocument).kycVersion,
      kycReviewedAt: (user as UserDocument).kycReviewedAt,
    };
  }

  async getDashboardMetricsForAdmin() {
    const verifiedContact = {
      $or: [
        { emailVerifiedAt: { $exists: true } },
        { phoneVerifiedAt: { $exists: true } },
        { emailVerified: true },
      ],
    };
    const activeAccount = {
      $or: [
        { accountStatus: AccountStatus.ACTIVE },
        { accountStatus: { $exists: false }, isActive: { $ne: false } },
      ],
    };
    const suspendedAccount = {
      $or: [
        { accountStatus: AccountStatus.SUSPENDED },
        { accountStatus: { $exists: false }, isActive: false },
      ],
    };
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
      this.userModel.countDocuments(verifiedContact).exec(),
      this.userModel.countDocuments({ $nor: verifiedContact.$or }).exec(),
      this.userModel.countDocuments(activeAccount).exec(),
      this.userModel.countDocuments(suspendedAccount).exec(),
      this.userModel.countDocuments({ kycStatus: KycStatus.PENDING }).exec(),
      this.userModel.countDocuments({ kycStatus: KycStatus.VERIFIED }).exec(),
      this.userModel.countDocuments({ kycStatus: KycStatus.REJECTED }).exec(),
      this.userModel
        .find()
        .sort({ createdAt: -1 })
        .limit(5)
        .select('fullName email phone systemRole accountType accountStatus brokerStatus brokerVersion verificationTrustState primaryIdentifierType emailVerifiedAt phoneVerifiedAt legacyVerifiedIdentifierType role emailVerified isActive kycStatus createdAt')
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
        ...identityProjection(u),
        kycStatus: u.kycStatus,
        createdAt: u.createdAt,
      })),
      recentAuditLogs,
    };
  }

  async create(data: Partial<User>) {
    return this.userModel.create(data);
  }

  async save(user: UserDocument) {
    return user.save();
  }

  /**
   * Compare-and-set password change used by single-use reset tokens: only
   * succeeds while the stored hash is still the one the token was issued for.
   */
  async updatePasswordIfCurrent(
    userId: string,
    currentPasswordHash: string,
    newPasswordHash: string,
  ): Promise<boolean> {
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
  async replaceUnverifiedRegistration(
    userId: string,
    data: {
      passwordHash: string;
      fullName: string;
      phone?: string;
      legalAcceptance?: UserLegalAcceptance;
    },
  ): Promise<boolean> {
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
  async releaseUnverifiedPhone(userId: string): Promise<boolean> {
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

  private authorizationDenied(message: string) {
    return new ForbiddenException({ message, code: AuthorizationErrorCode.FORBIDDEN });
  }
}
