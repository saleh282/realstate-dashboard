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
  isDuplicateKey(error) {
    return error?.code === 11000;
  }
}

Object.assign(exports, { BrokerApplicationsService });
