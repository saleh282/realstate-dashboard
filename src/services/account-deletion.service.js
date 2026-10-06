'use strict';

const {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} = require('../common/http/errors');
const { Types } = require('mongoose');
const bcrypt = require('bcrypt');
const { AuditAction } = require('../models/audit-log.model');
const { AuthErrorCode } = require('../common/errors/auth-error-codes');
const { normalizeIdentifier } = require('../common/validators/identifier.validator');
const { AccountStatus, resolveAccountStatus } = require('../domain/users/identity.types');
const {
  ACCOUNT_DELETION_RECOVERY_DAYS,
  AccountDeletionState,
} = require('../domain/account-deletion/account-deletion.types');
class AccountDeletionService {
  constructor(users, requests, connection, refreshTokens, audit, blockerProviders = [], assets) {
    this.users = users;
    this.requests = requests;
    this.connection = connection;
    this.refreshTokens = refreshTokens;
    this.audit = audit;
    this.blockerProviders = blockerProviders;
    this.assets = assets;
  }
  async requestSelfDeletion(userId, password, ip) {
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
  async requestDeletion(options) {
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
    const latest = await this.requests
      .findOne({ userId: options.user._id })
      .sort({ workflowVersion: -1 })
      .lean()
      .exec();
    const workflowVersion = (latest?.workflowVersion ?? 0) + 1;
    let created;
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const transition = await this.users
          .updateOne(
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
          )
          .exec();
        if (transition.modifiedCount !== 1) {
          throw new ConflictException({
            message: 'تغيرت حالة الحساب، يرجى إعادة المحاولة',
            code: AuthErrorCode.DELETION_REQUEST_CONFLICT,
          });
        }
        [created] = await this.requests.create(
          [
            {
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
            },
          ],
          { session },
        );
        await this.audit.logRequired(
          {
            action: AuditAction.ACCOUNT_DELETION_REQUESTED,
            actorUserId: options.actorUserId,
            targetUserId: userId,
            reason: options.reason ?? 'SELF_ACCOUNT_DELETION_REQUEST',
            ip: options.ip,
            metadata: { source: options.source, workflowVersion, recoverableUntil },
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    await this.refreshTokens.revokeAllForUser(userId, 'ACCOUNT_DELETION_PENDING');
    return this.customerProjection(created);
  }
  async pendingLoginState(userId) {
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
  async validateRecoveryCredentials(identifier, password) {
    const normalized = normalizeIdentifier(identifier);
    if (!normalized || normalized.kind !== 'email') {
      throw new UnauthorizedException({
        message: 'بيانات الدخول غير صحيحة',
        code: AuthErrorCode.INVALID_CREDENTIALS,
      });
    }
    const user = await this.users.findOne({ email: normalized.value }).select('+password').exec();
    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new UnauthorizedException({
        message: 'بيانات الدخول غير صحيحة',
        code: AuthErrorCode.INVALID_CREDENTIALS,
      });
    }
    const request = await this.assertRecoverable(user._id.toString());
    return {
      identifier: normalized.value,
      userId: user._id.toString(),
      ...this.customerProjection(request),
    };
  }
  async restoreAfterVerification(identifier, workflowVersion, ip) {
    const normalized = normalizeIdentifier(identifier);
    if (!normalized || normalized.kind !== 'email') {
      throw new BadRequestException({
        message: 'البريد الإلكتروني غير صالح',
        code: AuthErrorCode.INVALID_IDENTIFIER,
      });
    }
    const user = await this.users.findOne({ email: normalized.value }).exec();
    if (!user)
      throw new BadRequestException({
        message: 'تعذر استعادة الحساب',
        code: AuthErrorCode.ACCOUNT_RESTORE_NOT_ALLOWED,
      });
    const now = new Date();
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const request = await this.requests
          .findOneAndUpdate(
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
          )
          .exec();
        if (!request) {
          throw new ConflictException({
            message: 'تعذر استعادة الحساب بهذه النسخة أو انتهت المهلة',
            code: AuthErrorCode.ACCOUNT_RESTORE_NOT_ALLOWED,
          });
        }
        const restored = await this.users
          .updateOne(
            { _id: user._id, accountStatus: AccountStatus.DELETION_PENDING },
            {
              $set: { accountStatus: AccountStatus.ACTIVE, isActive: true },
              $unset: {
                deletionRequestedAt: 1,
                deletionRecoverableUntil: 1,
                anonymizationStartedAt: 1,
              },
            },
            { session },
          )
          .exec();
        if (restored.modifiedCount !== 1) {
          throw new ConflictException({
            message: 'تغيرت حالة الحساب',
            code: AuthErrorCode.DELETION_REQUEST_CONFLICT,
          });
        }
        await this.audit.logRequired(
          {
            action: AuditAction.ACCOUNT_DELETION_RESTORED,
            actorUserId: user._id.toString(),
            targetUserId: user._id.toString(),
            reason: 'EMAIL_VERIFIED_ACCOUNT_RESTORE',
            ip,
            metadata: { workflowVersion },
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    await this.refreshTokens.revokeAllForUser(
      user._id.toString(),
      'ACCOUNT_RESTORED_FRESH_LOGIN_REQUIRED',
    );
    return { message: 'تمت استعادة الحساب. يرجى تسجيل الدخول من جديد', restored: true };
  }
  async assertRecoverable(userId) {
    const request = await this.activeRequest(userId);
    if (!request || request.anonymizationStartedAt)
      throw new ConflictException({
        message: 'استعادة الحساب غير متاحة',
        code: AuthErrorCode.ACCOUNT_RESTORE_NOT_ALLOWED,
      });
    if (request.recoverableUntil.getTime() <= Date.now())
      throw new ConflictException({
        message: 'انتهت نافذة استعادة الحساب',
        code: AuthErrorCode.ACCOUNT_RECOVERY_WINDOW_EXPIRED,
      });
    return request;
  }
  activeRequest(userId) {
    return this.requests
      .findOne({
        userId: new Types.ObjectId(userId),
        state: { $in: [AccountDeletionState.PENDING, AccountDeletionState.ANONYMIZING] },
      })
      .exec();
  }
  customerProjection(request) {
    const now = Date.now();
    return {
      state: request.state,
      requestedAt: request.requestedAt,
      recoverableUntil: request.recoverableUntil,
      recoverable:
        request.state === AccountDeletionState.PENDING &&
        !request.anonymizationStartedAt &&
        request.recoverableUntil.getTime() > now,
      remainingSeconds: Math.max(0, Math.ceil((request.recoverableUntil.getTime() - now) / 1000)),
      workflowVersion: request.workflowVersion,
    };
  }
}

Object.assign(exports, { AccountDeletionService });
