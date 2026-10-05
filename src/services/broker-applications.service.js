'use strict';

const {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} = require('../common/http/errors');
const { createHash } = require('crypto');
const { Types } = require('mongoose');
const { AuditAction } = require('../models/audit-log.model');
const { SystemRole } = require('../domain/auth/roles.enum');
const { BrokerErrorCode } = require('../common/errors/broker-error-codes');
const { EvidenceErrorCode } = require('../common/errors/evidence-error-codes');
const { validateEvidenceFile } = require('../common/uploads/evidence-file.validator');
const { AssetClassification } = require('../config/evidence-asset.types');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
  resolveAccountStatus,
  resolveAccountType,
  resolveBrokerStatus,
  resolveSystemRole,
} = require('../domain/users/identity.types');
const { BrokerApplicationStatus } = require('../domain/broker-applications/broker.types');
const BROKER_EVIDENCE_POLICY = {
  kind: 'document',
  maxBytes: 10 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  allowPdf: true,
};
class BrokerApplicationsService {
  constructor(applicationModel, documentModel, userModel, connection, assets, audit) {
    this.applicationModel = applicationModel;
    this.documentModel = documentModel;
    this.userModel = userModel;
    this.connection = connection;
    this.assets = assets;
    this.audit = audit;
  }
  async submitApplication(applicantUserId, files, idempotencyKey, ip) {
    const applicantId = this.objectId(applicantUserId, 'معرف المستخدم غير صالح');
    const idempotencyKeyHash = this.hashIdempotencyKey(idempotencyKey);
    const replay = await this.applicationModel
      .findOne({ applicantAccountId: applicantId, idempotencyKeyHash })
      .lean()
      .exec();
    if (replay) {
      return {
        message: 'تم استرجاع طلب الوسيط السابق بأمان',
        application: this.applicationProjection(replay),
      };
    }
    const user = await this.userModel.findById(applicantId).lean().exec();
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    this.assertApplicationEligibility(user);
    const file = this.validateVerificationDocument(files);
    const assetRef = await this.assets.uploadPrivateEvidence(
      file,
      `brokers/${applicantUserId}/verification-document`,
      AssetClassification.PRIVATE_BROKER_EVIDENCE,
      validateEvidenceFile(file, BROKER_EVIDENCE_POLICY),
    );
    try {
      return await this.connection
        .transaction(async (session) => {
          const existing = await this.applicationModel
            .findOne({ applicantAccountId: applicantId, idempotencyKeyHash })
            .session(session)
            .lean()
            .exec();
          if (existing) {
            return {
              message: 'تم استرجاع طلب الوسيط السابق بأمان',
              application: this.applicationProjection(existing),
              duplicateUploadAssets: [assetRef],
            };
          }
          const currentUser = await this.userModel
            .findById(applicantId)
            .session(session)
            .lean()
            .exec();
          if (!currentUser) throw new NotFoundException('المستخدم غير موجود');
          this.assertApplicationEligibility(currentUser);
          const latest = await this.applicationModel
            .findOne({ applicantAccountId: applicantId })
            .sort({ applicationVersion: -1 })
            .session(session)
            .lean()
            .exec();
          const applicationId = new Types.ObjectId();
          const applicationVersion = (latest?.applicationVersion ?? 0) + 1;
          const now = new Date();
          const documentId = new Types.ObjectId();
          const documentRow = {
            _id: documentId,
            applicationId,
            applicantAccountId: applicantId,
            assetRef,
            submittedAt: now,
          };
          await this.documentModel.create([documentRow], { session });
          const [application] = await this.applicationModel.create(
            [
              {
                _id: applicationId,
                applicantAccountId: applicantId,
                applicationVersion,
                status: BrokerApplicationStatus.PENDING,
                documentIds: [documentId],
                submittedAt: now,
                submittedByActorId: applicantId,
                idempotencyKeyHash,
                version: 0,
              },
            ],
            { session },
          );
          const accountUpdate = await this.userModel
            .updateOne(
              {
                _id: applicantId,
                $and: [
                  {
                    $or: [
                      { systemRole: SystemRole.USER },
                      { systemRole: { $exists: false }, role: 'user' },
                    ],
                  },
                  { $or: [{ accountType: AccountType.USER }, { accountType: { $exists: false } }] },
                  {
                    $or: [
                      { accountStatus: AccountStatus.ACTIVE },
                      { accountStatus: { $exists: false }, isActive: { $ne: false } },
                    ],
                  },
                  {
                    $or: [
                      {
                        brokerStatus: {
                          $in: [
                            BrokerStatus.NOT_APPLIED,
                            BrokerStatus.REJECTED,
                            BrokerStatus.REVOKED,
                          ],
                        },
                      },
                      { brokerStatus: { $exists: false } },
                    ],
                  },
                ],
              },
              {
                $set: { accountType: AccountType.USER, brokerStatus: BrokerStatus.PENDING },
                $inc: { brokerVersion: 1 },
              },
              { session, runValidators: true },
            )
            .exec();
          if (accountUpdate.modifiedCount !== 1) {
            throw new ConflictException({
              message: 'تغيرت أهلية طلب الوسيط، يرجى إعادة تحميل الحساب',
              code: BrokerErrorCode.APPLICATION_PENDING,
            });
          }
          await this.audit.logRequired(
            {
              action: AuditAction.BROKER_APPLICATION_SUBMITTED,
              actorUserId: applicantUserId,
              targetUserId: applicantUserId,
              targetResourceId: applicationId.toString(),
              reason: 'تقديم طلب ترقية إلى حساب وسيط',
              ip,
              metadata: {
                applicationVersion,
                applicationRecordVersion: 0,
                evidenceCount: 1,
                after: { accountType: AccountType.USER, brokerStatus: BrokerStatus.PENDING },
              },
            },
            session,
          );
          await this.audit.logRequired(
            {
              action: AuditAction.PRIVATE_EVIDENCE_UPLOADED,
              actorUserId: applicantUserId,
              targetUserId: applicantUserId,
              targetResourceId: applicationId.toString(),
              reason: 'رفع مستند تحقق وسيط خاص',
              ip,
              metadata: {
                classification: AssetClassification.PRIVATE_BROKER_EVIDENCE,
                evidenceCount: 1,
              },
            },
            session,
          );
          return {
            message: 'تم تقديم طلب الوسيط للمراجعة بنجاح',
            application: this.applicationProjection(application),
          };
        })
        .then(async (result) => {
          if (result.duplicateUploadAssets) {
            await this.assets.deleteOrEnqueue(
              result.duplicateUploadAssets,
              'duplicate-broker-application-upload',
            );
            delete result.duplicateUploadAssets;
          }
          return result;
        });
    } catch (error) {
      await this.assets.deleteOrEnqueue([assetRef], 'broker-application-database-write-failed');
      if (this.isDuplicateKey(error)) {
        throw new ConflictException({
          message: 'يوجد طلب وسيط قيد المراجعة بالفعل',
          code: BrokerErrorCode.APPLICATION_PENDING,
        });
      }
      throw error;
    }
  }
  async listOwnApplications(applicantUserId) {
    const applicantId = this.objectId(applicantUserId, 'معرف المستخدم غير صالح');
    const applications = await this.applicationModel
      .find({ applicantAccountId: applicantId })
      .sort({ applicationVersion: -1 })
      .lean()
      .exec();
    return {
      message: 'تم تحميل سجل طلبات الوسيط بنجاح',
      items: applications.map((application) => this.applicationProjection(application)),
    };
  }
  async listApplicationsForAdmin(status, page = 1, limit = 20) {
    if (status && !Object.values(BrokerApplicationStatus).includes(status)) {
      throw new BadRequestException('حالة طلب الوسيط غير صالحة');
    }
    const safePage = Math.max(Number(page) || 1, 1);
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const filter = status ? { status } : {};
    const [applications, total] = await Promise.all([
      this.applicationModel
        .find(filter)
        .sort({ submittedAt: 1, _id: 1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .lean()
        .exec(),
      this.applicationModel.countDocuments(filter).exec(),
    ]);
    return {
      message: 'تم تحميل طلبات الوسطاء بنجاح',
      items: applications.map((application) => this.applicationProjection(application)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }
  async getApplicationForAdmin(applicationId) {
    const id = this.objectId(applicationId, 'معرف طلب الوسيط غير صالح');
    const [application, documents] = await Promise.all([
      this.applicationModel.findById(id).lean().exec(),
      this.documentModel.find({ applicationId: id }).sort({ requirementCode: 1 }).lean().exec(),
    ]);
    if (!application) throw new NotFoundException('طلب الوسيط غير موجود');
    return {
      message: 'تم تحميل طلب الوسيط بنجاح',
      application: this.applicationProjection(application),
      documents: documents.map((document) => this.documentProjection(document)),
    };
  }
  async reviewApplication(options) {
    if (options.decision === 'REJECTED' && (!options.reason || options.reason.trim().length < 5)) {
      throw new BadRequestException('سبب رفض طلب الوسيط إلزامي ويجب ألا يقل عن 5 أحرف');
    }
    const applicationId = this.objectId(options.applicationId, 'معرف طلب الوسيط غير صالح');
    const normalizedReason = options.reason?.trim() || undefined;
    return this.connection.transaction(async (session) => {
      const before = await this.applicationModel
        .findById(applicationId)
        .session(session)
        .lean()
        .exec();
      if (!before) throw new NotFoundException('طلب الوسيط غير موجود');
      if (before.status !== BrokerApplicationStatus.PENDING) {
        throw new ConflictException({
          message: 'تمت مراجعة طلب الوسيط بالفعل',
          code: BrokerErrorCode.APPLICATION_STATE_CONFLICT,
          details: { state: before.status, version: before.version ?? 0 },
        });
      }
      if ((before.version ?? 0) !== options.expectedVersion) {
        this.applicationVersionConflict(before);
      }
      const nextApplicationStatus =
        options.decision === 'APPROVED'
          ? BrokerApplicationStatus.APPROVED
          : BrokerApplicationStatus.REJECTED;
      const nextAccountType =
        options.decision === 'APPROVED' ? AccountType.BROKER : AccountType.USER;
      const nextBrokerStatus =
        options.decision === 'APPROVED' ? BrokerStatus.APPROVED : BrokerStatus.REJECTED;
      const reviewedAt = new Date();
      const application = await this.applicationModel
        .findOneAndUpdate(
          {
            _id: applicationId,
            status: BrokerApplicationStatus.PENDING,
            version: options.expectedVersion,
          },
          {
            $set: {
              status: nextApplicationStatus,
              reviewedAt,
              reviewedByActorId: new Types.ObjectId(options.actorUserId),
              reviewReason: normalizedReason,
            },
            $inc: { version: 1 },
          },
          { new: true, runValidators: true, session },
        )
        .exec();
      if (!application) this.applicationVersionConflict(before);
      const account = await this.userModel
        .findOneAndUpdate(
          {
            _id: before.applicantAccountId,
            brokerStatus: BrokerStatus.PENDING,
            $or: [{ accountType: AccountType.USER }, { accountType: { $exists: false } }],
          },
          {
            $set: { accountType: nextAccountType, brokerStatus: nextBrokerStatus },
            $inc: { brokerVersion: 1 },
          },
          { new: true, runValidators: true, session },
        )
        .exec();
      if (!account) {
        throw new ConflictException({
          message: 'تغيرت حالة حساب مقدم الطلب، يرجى إعادة تحميل البيانات',
          code: BrokerErrorCode.APPLICATION_STATE_CONFLICT,
        });
      }
      await this.audit.logRequired(
        {
          action: AuditAction.ADMIN_BROKER_APPLICATION_REVIEWED,
          actorUserId: options.actorUserId,
          targetUserId: before.applicantAccountId.toString(),
          targetResourceId: applicationId.toString(),
          reason:
            normalizedReason ??
            (options.decision === 'APPROVED' ? 'قبول طلب الوسيط' : 'رفض طلب الوسيط'),
          ip: options.ip,
          metadata: {
            before: {
              applicationStatus: before.status,
              applicationVersion: before.version ?? 0,
              accountType: AccountType.USER,
              brokerStatus: BrokerStatus.PENDING,
            },
            after: {
              applicationStatus: nextApplicationStatus,
              applicationVersion: options.expectedVersion + 1,
              accountType: nextAccountType,
              brokerStatus: nextBrokerStatus,
              reviewedAt: reviewedAt.toISOString(),
            },
          },
        },
        session,
      );
      return {
        message:
          options.decision === 'APPROVED' ? 'تم اعتماد حساب الوسيط بنجاح' : 'تم رفض طلب الوسيط',
        application: this.applicationProjection(application),
        account: this.brokerAccountProjection(account),
      };
    });
  }
  suspendBroker(userId, expectedVersion, reason, actor) {
    return this.changeBrokerStatus({
      userId,
      expectedVersion,
      reason,
      actor,
      allowedCurrent: [BrokerStatus.APPROVED],
      nextStatus: BrokerStatus.SUSPENDED,
      nextAccountType: AccountType.BROKER,
      action: AuditAction.ADMIN_BROKER_SUSPENDED,
      message: 'تم تعليق صلاحيات الوسيط بنجاح',
    });
  }
  restoreBroker(userId, expectedVersion, reason, actor) {
    return this.changeBrokerStatus({
      userId,
      expectedVersion,
      reason,
      actor,
      allowedCurrent: [BrokerStatus.SUSPENDED],
      nextStatus: BrokerStatus.APPROVED,
      nextAccountType: AccountType.BROKER,
      action: AuditAction.ADMIN_BROKER_RESTORED,
      message: 'تمت استعادة صلاحيات الوسيط بنجاح',
    });
  }
  revokeBroker(userId, expectedVersion, reason, actor) {
    return this.changeBrokerStatus({
      userId,
      expectedVersion,
      reason,
      actor,
      allowedCurrent: [BrokerStatus.APPROVED, BrokerStatus.SUSPENDED],
      nextStatus: BrokerStatus.REVOKED,
      nextAccountType: AccountType.USER,
      action: AuditAction.ADMIN_BROKER_REVOKED,
      message: 'تم إلغاء صفة الوسيط وإعادة الحساب إلى مستخدم عادي',
    });
  }
  async getEvidenceForApplicant(applicantUserId, applicationId, documentId, ip) {
    const document = await this.findEvidence(applicationId, documentId, applicantUserId);
    await this.audit.logResourceAction(
      AuditAction.PRIVATE_EVIDENCE_ACCESSED,
      applicantUserId,
      document._id.toString(),
      'broker-document:self-access',
      ip,
    );
    return this.normalizeAsset(document.assetRef);
  }
  async getEvidenceForAdmin(actorUserId, applicationId, documentId, ip) {
    const document = await this.findEvidence(applicationId, documentId);
    await this.audit.logAdminAction(
      AuditAction.PRIVATE_EVIDENCE_ACCESSED,
      actorUserId,
      document.applicantAccountId.toString(),
      'broker-document:admin-review',
      ip,
      { applicationId, documentId },
    );
    return this.normalizeAsset(document.assetRef);
  }
  async changeBrokerStatus(options) {
    const userId = this.objectId(options.userId, 'معرف المستخدم غير صالح');
    return this.connection.transaction(async (session) => {
      const before = await this.userModel.findById(userId).session(session).lean().exec();
      if (!before) throw new NotFoundException('المستخدم غير موجود');
      const currentStatus = resolveBrokerStatus(before);
      const currentVersion = before.brokerVersion ?? 0;
      if (currentVersion !== options.expectedVersion) {
        throw new ConflictException({
          message: 'تم تحديث حالة الوسيط، يرجى إعادة تحميل البيانات',
          code: BrokerErrorCode.STATUS_VERSION_CONFLICT,
          details: { state: currentStatus, version: currentVersion },
        });
      }
      if (
        resolveSystemRole(before) !== SystemRole.USER ||
        resolveAccountType(before) !== AccountType.BROKER ||
        !options.allowedCurrent.includes(currentStatus)
      ) {
        throw new ConflictException({
          message: 'لا يمكن تنفيذ انتقال حالة الوسيط المطلوب',
          code: BrokerErrorCode.APPLICATION_STATE_CONFLICT,
          details: { state: currentStatus, version: currentVersion },
        });
      }
      const account = await this.userModel
        .findOneAndUpdate(
          {
            _id: userId,
            accountType: AccountType.BROKER,
            brokerStatus: { $in: options.allowedCurrent },
            $or: [
              { brokerVersion: options.expectedVersion },
              ...(options.expectedVersion === 0 ? [{ brokerVersion: { $exists: false } }] : []),
            ],
          },
          {
            $set: { accountType: options.nextAccountType, brokerStatus: options.nextStatus },
            $inc: { brokerVersion: 1 },
          },
          { new: true, runValidators: true, session },
        )
        .exec();
      if (!account) {
        throw new ConflictException({
          message: 'تم تحديث حالة الوسيط، يرجى إعادة تحميل البيانات',
          code: BrokerErrorCode.STATUS_VERSION_CONFLICT,
        });
      }
      await this.audit.logRequired(
        {
          action: options.action,
          actorUserId: options.actor.actorUserId,
          targetUserId: options.userId,
          reason: options.reason,
          ip: options.actor.ip,
          metadata: {
            before: {
              accountType: AccountType.BROKER,
              brokerStatus: currentStatus,
              brokerVersion: currentVersion,
            },
            after: {
              accountType: options.nextAccountType,
              brokerStatus: options.nextStatus,
              brokerVersion: currentVersion + 1,
            },
          },
        },
        session,
      );
      return { message: options.message, account: this.brokerAccountProjection(account) };
    });
  }
  async findEvidence(applicationId, documentId, applicantUserId) {
    const applicationObjectId = this.objectId(applicationId, 'معرف طلب الوسيط غير صالح');
    const documentObjectId = this.objectId(documentId, 'معرف مستند الوسيط غير صالح');
    const document = await this.documentModel
      .findOne({
        _id: documentObjectId,
        applicationId: applicationObjectId,
        ...(applicantUserId
          ? { applicantAccountId: this.objectId(applicantUserId, 'معرف المستخدم غير صالح') }
          : {}),
      })
      .lean()
      .exec();
    if (!document) {
      throw new NotFoundException({
        message: 'مستند الوسيط غير موجود',
        code: EvidenceErrorCode.NOT_FOUND,
      });
    }
    return document;
  }
  validateVerificationDocument(files) {
    if (files.length !== 1) {
      throw new BadRequestException({
        message: files.length === 0 ? 'ملف التحقق بصيغة PDF مطلوب' : 'يجب إرفاق ملف تحقق واحد فقط',
        code:
          files.length === 0
            ? BrokerErrorCode.DOCUMENT_REQUIRED
            : BrokerErrorCode.DOCUMENT_DUPLICATE,
      });
    }
    const detected = validateEvidenceFile(files[0], BROKER_EVIDENCE_POLICY);
    if (detected.mime !== 'application/pdf') {
      throw new BadRequestException({
        message: 'ملف التحقق يجب أن يكون بصيغة PDF صالحة',
        code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED,
      });
    }
    return files[0];
  }
  assertApplicationEligibility(user) {
    const brokerStatus = resolveBrokerStatus(user);
    if (brokerStatus === BrokerStatus.PENDING) {
      throw new ConflictException({
        message: 'يوجد طلب وسيط قيد المراجعة بالفعل',
        code: BrokerErrorCode.APPLICATION_PENDING,
      });
    }
    if (
      resolveSystemRole(user) !== SystemRole.USER ||
      resolveAccountType(user) !== AccountType.USER ||
      resolveAccountStatus(user) !== AccountStatus.ACTIVE ||
      ![BrokerStatus.NOT_APPLIED, BrokerStatus.REJECTED, BrokerStatus.REVOKED].includes(
        brokerStatus,
      )
    ) {
      throw new ForbiddenException({
        message: 'الحساب غير مؤهل لتقديم طلب وسيط جديد',
        code: BrokerErrorCode.APPLICATION_NOT_ELIGIBLE,
      });
    }
  }
  hashIdempotencyKey(value) {
    const key = value?.trim();
    if (!key || key.length < 8 || key.length > 200) {
      throw new BadRequestException('مفتاح منع التكرار مطلوب ويجب أن يكون صالحاً');
    }
    return createHash('sha256').update(key, 'utf8').digest('hex');
  }
  objectId(value, message) {
    if (!Types.ObjectId.isValid(value)) throw new BadRequestException(message);
    return new Types.ObjectId(value);
  }
  applicationVersionConflict(application) {
    throw new ConflictException({
      message: 'تم تحديث طلب الوسيط، يرجى إعادة تحميل البيانات',
      code: BrokerErrorCode.APPLICATION_VERSION_CONFLICT,
      details: { state: application.status, version: application.version ?? 0 },
    });
  }
  applicationProjection(application) {
    return {
      id: application._id.toString(),
      applicantAccountId: application.applicantAccountId.toString(),
      applicationVersion: application.applicationVersion,
      status: application.status,
      documentIds: (application.documentIds ?? []).map((id) => id.toString()),
      submittedAt: application.submittedAt,
      reviewedAt: application.reviewedAt,
      reviewedByActorId: application.reviewedByActorId?.toString(),
      rejectionReason:
        application.status === BrokerApplicationStatus.REJECTED
          ? application.reviewReason
          : undefined,
      version: application.version ?? 0,
      createdAt: application.createdAt,
      updatedAt: application.updatedAt,
    };
  }
  documentProjection(document) {
    return {
      id: document._id.toString(),
      applicationId: document.applicationId.toString(),
      submittedAt: document.submittedAt,
      format: document.assetRef?.format,
      bytes: document.assetRef?.bytes,
    };
  }
  brokerAccountProjection(account) {
    return {
      userId: account._id.toString(),
      accountType: resolveAccountType(account),
      brokerStatus: resolveBrokerStatus(account),
      brokerVersion: account.brokerVersion ?? 0,
    };
  }
  normalizeAsset(asset) {
    return {
      publicId: asset.publicId,
      resourceType: asset.resourceType,
      deliveryType: asset.deliveryType ?? 'authenticated',
      classification: AssetClassification.PRIVATE_BROKER_EVIDENCE,
      format: asset.format,
      bytes: asset.bytes,
      ...(asset.secureUrl ? { secureUrl: asset.secureUrl } : {}),
    };
  }
  isDuplicateKey(error) {
    return error?.code === 11000;
  }
}

Object.assign(exports, { BrokerApplicationsService });
