import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomBytes, randomUUID } from 'crypto';
import { Connection, Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Property, PropertyDocument } from '../properties/schemas/property.schema';
import { RefreshTokenService } from '../refresh-token/refresh-token.service';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { AuthErrorCode } from '../common/errors/auth-error-codes';
import { hashPassword } from '../common/security/password-hashing';
import { normalizeIdentifier } from '../common/validators/identifier.validator';
import {
  AccountStatus,
  AccountType,
  BrokerStatus,
  VerificationTrustState,
  resolveAccountStatus,
  resolveSystemRole,
} from '../users/identity.types';
import { SystemRole } from '../auth/roles.enum';
import {
  ACCOUNT_DELETION_RECOVERY_DAYS,
  ACCOUNT_DELETION_BLOCKER_PROVIDERS,
  AccountDeletionBlocker,
  AccountDeletionBlockerProvider,
  AccountDeletionState,
} from './account-deletion.types';
import {
  AccountDeletionRequest,
  AccountDeletionRequestDocument,
} from './schemas/account-deletion-request.schema';

type RequestSource = 'SELF' | 'ADMIN';

@Injectable()
export class AccountDeletionService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Property.name) private readonly properties: Model<PropertyDocument>,
    @InjectModel(AccountDeletionRequest.name)
    private readonly requests: Model<AccountDeletionRequestDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly refreshTokens: RefreshTokenService,
    private readonly audit: AuditLogService,
    @Optional()
    @Inject(ACCOUNT_DELETION_BLOCKER_PROVIDERS)
    private readonly blockerProviders: AccountDeletionBlockerProvider[] = [],
  ) {}

  async requestSelfDeletion(userId: string, password: string, ip?: string) {
    const user = await this.users.findById(userId).select('+password').exec();
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    if (!(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException({
        message: 'كلمة المرور غير صحيحة لتأكيد طلب حذف الحساب',
        code: AuthErrorCode.INVALID_CREDENTIALS,
      });
    }
    return this.requestDeletion({ user, source: 'SELF', actorUserId: userId, ip });
  }

  async requestDeletionForAdmin(options: {
    actorUserId: string;
    targetUserId: string;
    confirmIdentifier: string;
    reason: string;
    ip?: string;
  }) {
    if (!Types.ObjectId.isValid(options.targetUserId)) {
      throw new BadRequestException('معرف المستخدم غير صالح');
    }
    if (options.actorUserId === options.targetUserId) {
      throw new ForbiddenException('لا يمكنك بدء حذف حسابك الإداري الحالي');
    }
    const user = await this.users.findById(options.targetUserId).exec();
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    if (resolveSystemRole(user) !== SystemRole.USER) {
      throw new ForbiddenException('حسابات الإدارة لا تدخل مسار حذف السوق');
    }
    const expected = (user.email ?? user.phone ?? '').trim().toLowerCase();
    if (!expected || expected !== options.confirmIdentifier.trim().toLowerCase()) {
      throw new BadRequestException('بيانات تأكيد المستخدم غير مطابقة');
    }
    return this.requestDeletion({
      user,
      source: 'ADMIN',
      actorUserId: options.actorUserId,
      reason: options.reason,
      ip: options.ip,
    });
  }

  private async requestDeletion(options: {
    user: UserDocument;
    source: RequestSource;
    actorUserId: string;
    reason?: string;
    ip?: string;
  }) {
    const userId = options.user._id.toString();
    const existing = await this.activeRequest(userId);
    if (existing) {
      await this.refreshTokens.revokeAllForUser(userId, 'ACCOUNT_DELETION_PENDING');
      return this.customerProjection(existing);
    }
    const currentStatus = resolveAccountStatus(options.user);
    if (currentStatus === AccountStatus.ANONYMIZED) {
      throw new ConflictException({
        message: 'تم إخفاء هوية هذا الحساب ولا يمكن استعادته',
        code: AuthErrorCode.ACCOUNT_ALREADY_ANONYMIZED,
      });
    }
    if (currentStatus !== AccountStatus.ACTIVE) {
      throw new ConflictException({
        message: 'حالة الحساب الحالية لا تسمح ببدء طلب الحذف',
        code: AuthErrorCode.DELETION_REQUEST_CONFLICT,
      });
    }

    const requestedAt = new Date();
    const recoverableUntil = new Date(requestedAt);
    recoverableUntil.setUTCDate(recoverableUntil.getUTCDate() + ACCOUNT_DELETION_RECOVERY_DAYS);
    const latest = await this.requests.findOne({ userId: options.user._id }).sort({ workflowVersion: -1 }).lean().exec();
    const workflowVersion = (latest?.workflowVersion ?? 0) + 1;
    let created: AccountDeletionRequestDocument | undefined;

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const transition = await this.users.updateOne(
          { _id: options.user._id, accountStatus: AccountStatus.ACTIVE },
          {
            $set: {
              accountStatus: AccountStatus.DELETION_PENDING,
              isActive: false,
              deletionRequestedAt: requestedAt,
              deletionRecoverableUntil: recoverableUntil,
            },
          },
          { session },
        ).exec();
        if (transition.modifiedCount !== 1) {
          throw new ConflictException({
            message: 'تغيرت حالة الحساب، يرجى إعادة المحاولة',
            code: AuthErrorCode.DELETION_REQUEST_CONFLICT,
          });
        }
        [created] = await this.requests.create([{
          userId: options.user._id,
          workflowVersion,
          state: AccountDeletionState.PENDING,
          requestedAt,
          recoverableUntil,
          source: options.source,
          requestedByActorId: new Types.ObjectId(options.actorUserId),
          reason: options.reason,
          blockers: [],
          legalHold: false,
          evidenceRetentionState: 'RETAIN_PENDING_POLICY',
          finalPurgeEligible: false,
        }], { session });
        await this.audit.logRequired({
          action: AuditAction.ACCOUNT_DELETION_REQUESTED,
          actorUserId: options.actorUserId,
          targetUserId: userId,
          reason: options.reason ?? 'SELF_ACCOUNT_DELETION_REQUEST',
          ip: options.ip,
          metadata: { source: options.source, workflowVersion, recoverableUntil },
        }, session);
      });
    } finally {
      await session.endSession();
    }
    await this.refreshTokens.revokeAllForUser(userId, 'ACCOUNT_DELETION_PENDING');
    return this.customerProjection(created!);
  }

  async pendingLoginState(userId: string) {
    const request = await this.activeRequest(userId);
    if (!request) {
      throw new ConflictException({
        message: 'طلب حذف الحساب غير متاح',
        code: AuthErrorCode.ACCOUNT_RESTORE_NOT_ALLOWED,
      });
    }
    throw new ForbiddenException({
      message: 'الحساب قيد الحذف. يلزم تنفيذ استعادة صريحة خلال المهلة المتاحة',
      code: AuthErrorCode.ACCOUNT_DELETION_PENDING,
      deletion: this.customerProjection(request),
    });
  }

  async validateRecoveryCredentials(identifier: string, password: string) {
    const normalized = normalizeIdentifier(identifier);
    if (!normalized || normalized.kind !== 'email') {
      throw new UnauthorizedException({ message: 'بيانات الدخول غير صحيحة', code: AuthErrorCode.INVALID_CREDENTIALS });
    }
    const user = await this.users.findOne({ email: normalized.value }).select('+password').exec();
    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException({ message: 'بيانات الدخول غير صحيحة', code: AuthErrorCode.INVALID_CREDENTIALS });
    }
    const request = await this.assertRecoverable(user._id.toString());
    return { identifier: normalized.value, userId: user._id.toString(), ...this.customerProjection(request) };
  }

  async restoreAfterVerification(identifier: string, workflowVersion: number, ip?: string) {
    const normalized = normalizeIdentifier(identifier);
    if (!normalized || normalized.kind !== 'email') {
      throw new BadRequestException({ message: 'البريد الإلكتروني غير صالح', code: AuthErrorCode.INVALID_IDENTIFIER });
    }
    const user = await this.users.findOne({ email: normalized.value }).exec();
    if (!user) throw new BadRequestException({ message: 'تعذر استعادة الحساب', code: AuthErrorCode.ACCOUNT_RESTORE_NOT_ALLOWED });
    const now = new Date();
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const request = await this.requests.findOneAndUpdate(
          {
            userId: user._id,
            workflowVersion,
            state: AccountDeletionState.PENDING,
            recoverableUntil: { $gt: now },
            anonymizationStartedAt: { $exists: false },
          },
          {
            $set: {
              state: AccountDeletionState.RESTORED,
              restoredAt: now,
              restoredByActorId: user._id,
            },
          },
          { new: true, session },
        ).exec();
        if (!request) {
          throw new ConflictException({ message: 'تعذر استعادة الحساب بهذه النسخة أو انتهت المهلة', code: AuthErrorCode.ACCOUNT_RESTORE_NOT_ALLOWED });
        }
        const restored = await this.users.updateOne(
          { _id: user._id, accountStatus: AccountStatus.DELETION_PENDING },
          {
            $set: { accountStatus: AccountStatus.ACTIVE, isActive: true },
            $unset: { deletionRequestedAt: 1, deletionRecoverableUntil: 1, anonymizationStartedAt: 1 },
          },
          { session },
        ).exec();
        if (restored.modifiedCount !== 1) {
          throw new ConflictException({ message: 'تغيرت حالة الحساب', code: AuthErrorCode.DELETION_REQUEST_CONFLICT });
        }
        await this.audit.logRequired({
          action: AuditAction.ACCOUNT_DELETION_RESTORED,
          actorUserId: user._id.toString(),
          targetUserId: user._id.toString(),
          reason: 'EMAIL_VERIFIED_ACCOUNT_RESTORE',
          ip,
          metadata: { workflowVersion },
        }, session);
      });
    } finally {
      await session.endSession();
    }
    await this.refreshTokens.revokeAllForUser(user._id.toString(), 'ACCOUNT_RESTORED_FRESH_LOGIN_REQUIRED');
    return { message: 'تمت استعادة الحساب. يرجى تسجيل الدخول من جديد', restored: true };
  }

  async getOwnStatus(userId: string) {
    const request = await this.requests.findOne({ userId: new Types.ObjectId(userId) }).sort({ workflowVersion: -1 }).exec();
    if (!request) throw new NotFoundException('لا يوجد طلب حذف للحساب');
    return this.customerProjection(request);
  }

  async getAdminImpact(userId: string) {
    if (!Types.ObjectId.isValid(userId)) throw new BadRequestException('معرف المستخدم غير صالح');
    const accountId = new Types.ObjectId(userId);
    const [request, history, account, brokerApplicationCount, propertyCount] = await Promise.all([
      this.requests.findOne({ userId: accountId }).sort({ workflowVersion: -1 }).exec(),
      this.requests.find({ userId: accountId }).sort({ workflowVersion: -1 }).limit(20).exec(),
      this.users.findById(accountId).select('accountType accountStatus brokerStatus').lean().exec(),
      this.connection.collection('broker_applications').countDocuments({ userId: accountId }),
      this.properties.countDocuments({
        $or: [{ advertiserAccountId: accountId }, { ownerId: accountId }],
      }).exec(),
    ]);
    const blockers = await this.blockersFor(userId);
    return {
      userId,
      workflow: request ? this.adminProjection(request) : null,
      history: history.map((item) => this.adminProjection(item)),
      impact: {
        propertyCount,
        brokerApplicationCount,
        accountType: account?.accountType,
        accountStatus: account ? resolveAccountStatus(account) : undefined,
        brokerStatus: account?.brokerStatus,
        blockers,
        finalPurgeEnabled: false,
      },
    };
  }

  async setLegalHold(options: { actorUserId: string; targetUserId: string; reason: string; version: number; place: boolean; ip?: string }) {
    const now = new Date();
    const update = options.place
      ? { $set: { legalHold: true, legalHoldReason: options.reason, legalHoldPlacedBy: new Types.ObjectId(options.actorUserId), legalHoldPlacedAt: now } }
      : { $set: { legalHold: false, legalHoldRemovedBy: new Types.ObjectId(options.actorUserId), legalHoldRemovedAt: now, legalHoldRemovalReason: options.reason }, $unset: { legalHoldReason: 1 } };
    let request: AccountDeletionRequestDocument | null = null;
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        request = await this.requests.findOneAndUpdate(
          { userId: new Types.ObjectId(options.targetUserId), state: AccountDeletionState.PENDING, version: options.version, legalHold: options.place ? false : true },
          update,
          { new: true, session },
        ).exec();
        if (!request) throw new ConflictException({ message: 'تغيرت حالة طلب الحذف', code: AuthErrorCode.DELETION_REQUEST_CONFLICT });
        await this.audit.logRequired({
          action: options.place ? AuditAction.ACCOUNT_LEGAL_HOLD_PLACED : AuditAction.ACCOUNT_LEGAL_HOLD_REMOVED,
          actorUserId: options.actorUserId,
          targetUserId: options.targetUserId,
          reason: options.reason,
          ip: options.ip,
          metadata: { workflowVersion: request.workflowVersion },
        }, session);
      });
    } finally {
      await session.endSession();
    }
    return this.adminProjection(request!);
  }

  async anonymize(options: { actorUserId: string; targetUserId: string; reason: string; version: number; ip?: string }) {
    const targetUserId = new Types.ObjectId(options.targetUserId);
    const request = await this.requests.findOne({ userId: targetUserId, state: AccountDeletionState.PENDING }).select('+legalHoldReason').exec();
    if (!request) {
      const latest = await this.requests.findOne({ userId: targetUserId }).sort({ workflowVersion: -1 }).exec();
      if (latest?.state === AccountDeletionState.ANONYMIZED) {
        return {
          message: 'تم إخفاء هوية الحساب مع الحفاظ على السجل المرجعي',
          state: AccountDeletionState.ANONYMIZED,
          finalPurgeEnabled: false,
        };
      }
      throw new ConflictException({ message: 'تغيرت حالة طلب الحذف', code: AuthErrorCode.DELETION_REQUEST_CONFLICT });
    }
    if (request.version !== options.version) throw new ConflictException({ message: 'تغيرت حالة طلب الحذف', code: AuthErrorCode.DELETION_REQUEST_CONFLICT });
    if (request.recoverableUntil.getTime() > Date.now()) throw new ConflictException({ message: 'نافذة الاستعادة ما زالت متاحة', code: AuthErrorCode.ACCOUNT_RESTORE_NOT_ALLOWED });
    if (request.legalHold) throw new ConflictException({ message: 'لا يمكن إخفاء الهوية حالياً', code: AuthErrorCode.ACCOUNT_LEGAL_HOLD_ACTIVE });
    const blockers = await this.blockersFor(options.targetUserId);
    if (blockers.length) {
      await this.requests.updateOne({ _id: request._id, version: options.version }, { $set: { blockers, lastAttemptAt: new Date(), failureCode: AuthErrorCode.ACCOUNT_DELETION_BLOCKED } }).exec();
      throw new ConflictException({ message: 'توجد التزامات يجب حلها قبل إخفاء الهوية', code: AuthErrorCode.ACCOUNT_DELETION_BLOCKED, blockers });
    }
    const now = new Date();
    const pseudonymousActorId = randomUUID();
    const anonymousPassword = await hashPassword(randomBytes(48).toString('base64url'));
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const started = await this.requests.findOneAndUpdate(
          { _id: request._id, state: AccountDeletionState.PENDING, version: options.version, legalHold: false },
          { $set: { state: AccountDeletionState.ANONYMIZING, anonymizationStartedAt: now, blockers: [], lastAttemptAt: now }, $unset: { failureCode: 1 } },
          { new: true, session },
        ).exec();
        if (!started) throw new ConflictException({ message: 'تغيرت حالة طلب الحذف', code: AuthErrorCode.DELETION_REQUEST_CONFLICT });
        const anonymizedUser = await this.users.updateOne(
          { _id: targetUserId, accountStatus: AccountStatus.DELETION_PENDING },
          {
            $set: {
              fullName: 'Deleted Account',
              password: anonymousPassword,
              accountStatus: AccountStatus.ANONYMIZED,
              accountType: AccountType.USER,
              brokerStatus: BrokerStatus.REVOKED,
              verificationTrustState: VerificationTrustState.UNVERIFIED,
              isActive: false,
              pseudonymousActorId,
              anonymizationStartedAt: now,
              anonymizedAt: now,
            },
            $unset: {
              email: 1, phone: 1, emailVerifiedAt: 1, phoneVerifiedAt: 1,
              profileImage: 1, address: 1, suspendReason: 1,
              'legalAcceptance.ip': 1,
            },
          },
          { session },
        ).exec();
        if (anonymizedUser.modifiedCount !== 1) {
          throw new ConflictException({ message: 'تغيرت حالة الحساب', code: AuthErrorCode.DELETION_REQUEST_CONFLICT });
        }
        const completed = await this.requests.updateOne(
          { _id: request._id, state: AccountDeletionState.ANONYMIZING },
          { $set: { state: AccountDeletionState.ANONYMIZED, anonymizedAt: now } },
          { session },
        ).exec();
        if (completed.modifiedCount !== 1) {
          throw new ConflictException({ message: 'تغيرت حالة طلب الحذف', code: AuthErrorCode.DELETION_REQUEST_CONFLICT });
        }
        await this.audit.logRequired({
          action: AuditAction.ACCOUNT_ANONYMIZATION_STARTED,
          actorUserId: options.actorUserId,
          targetUserId: options.targetUserId,
          reason: options.reason,
          ip: options.ip,
          metadata: { workflowVersion: request.workflowVersion },
        }, session);
        await this.audit.logRequired({
          action: AuditAction.ACCOUNT_ANONYMIZATION_COMPLETED,
          actorUserId: options.actorUserId,
          targetUserId: options.targetUserId,
          reason: options.reason,
          ip: options.ip,
          metadata: { workflowVersion: request.workflowVersion, evidenceDisposition: 'RETAIN_PENDING_LEGAL_POLICY', finalPurgeEnabled: false },
        }, session);
      });
    } finally {
      await session.endSession();
    }
    await this.refreshTokens.revokeAllForUser(options.targetUserId, 'ACCOUNT_ANONYMIZED');
    return { message: 'تم إخفاء هوية الحساب مع الحفاظ على السجل المرجعي', state: AccountDeletionState.ANONYMIZED, finalPurgeEnabled: false };
  }

  private async assertRecoverable(userId: string) {
    const request = await this.activeRequest(userId);
    if (!request || request.anonymizationStartedAt) throw new ConflictException({ message: 'استعادة الحساب غير متاحة', code: AuthErrorCode.ACCOUNT_RESTORE_NOT_ALLOWED });
    if (request.recoverableUntil.getTime() <= Date.now()) throw new ConflictException({ message: 'انتهت نافذة استعادة الحساب', code: AuthErrorCode.ACCOUNT_RECOVERY_WINDOW_EXPIRED });
    return request;
  }

  private activeRequest(userId: string) {
    return this.requests.findOne({ userId: new Types.ObjectId(userId), state: { $in: [AccountDeletionState.PENDING, AccountDeletionState.ANONYMIZING] } }).exec();
  }

  private async blockersFor(userId: string): Promise<AccountDeletionBlocker[]> {
    const id = new Types.ObjectId(userId);
    const unresolvedProperties = await this.properties.countDocuments({
      $or: [{ advertiserAccountId: id }, { ownerId: id }],
      status: { $in: ['approved', 'pending_review'] },
    }).exec();
    const propertyBlockers: AccountDeletionBlocker[] = unresolvedProperties
      ? [{ code: 'PROPERTY_LIFECYCLE_RESOLUTION_REQUIRED', category: 'RESOURCE', count: unresolvedProperties }]
      : [];
    const futureBlockers = await Promise.all(
      this.blockerProviders.map((provider) => provider.blockersForAccount(userId)),
    );
    return [...propertyBlockers, ...futureBlockers.flat()];
  }

  private customerProjection(request: AccountDeletionRequestDocument) {
    const now = Date.now();
    return {
      state: request.state,
      requestedAt: request.requestedAt,
      recoverableUntil: request.recoverableUntil,
      recoverable: request.state === AccountDeletionState.PENDING && !request.anonymizationStartedAt && request.recoverableUntil.getTime() > now,
      remainingSeconds: Math.max(0, Math.ceil((request.recoverableUntil.getTime() - now) / 1000)),
      workflowVersion: request.workflowVersion,
    };
  }

  private adminProjection(request: AccountDeletionRequestDocument) {
    return {
      ...this.customerProjection(request),
      version: request.version,
      legalHold: request.legalHold,
      blockers: request.blockers ?? [],
      restoredAt: request.restoredAt,
      anonymizationStartedAt: request.anonymizationStartedAt,
      anonymizedAt: request.anonymizedAt,
      finalPurgeEnabled: false,
      evidenceRetentionState: request.evidenceRetentionState,
    };
  }
}
