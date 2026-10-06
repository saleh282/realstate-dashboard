'use strict';

const { Types } = require('mongoose');
const {
  BadRequestException,
  ConflictException,
  NotFoundException,
} = require('../common/http/errors');
const { runTransactionWithRetry } = require('../common/mongo/transaction-runner');
const { StreamableFile } = require('../common/http/binary-response');
const { AuditAction } = require('../models/audit-log.model');
const { KycStatus } = require('../models/user.model');
const { BrokerApplicationStatus } = require('../domain/broker-applications/broker.types');
const {
  AccountType,
  BrokerStatus,
  VerificationTrustState,
} = require('../domain/users/identity.types');
const { kycDecisionEvent, brokerDecisionEvent } = require('../domain/outbox/outbox-events');

const ReviewErrorCode = Object.freeze({
  ID_INVALID: 'REVIEW_ID_INVALID',
  QUERY_INVALID: 'REVIEW_QUERY_INVALID',
  NOT_FOUND: 'REVIEW_NOT_FOUND',
  DOCUMENT_NOT_FOUND: 'REVIEW_DOCUMENT_NOT_FOUND',
  ALREADY_DECIDED: 'REVIEW_ALREADY_DECIDED',
  REASON_REQUIRED: 'REVIEW_REASON_REQUIRED',
});

/** The three photos of an identity check, by the name used in the URL. */
const KYC_DOCUMENTS = Object.freeze({
  'id-front': 'idFrontAsset',
  'id-back': 'idBackAsset',
  selfie: 'selfieAsset',
});
const MAX_LIMIT = 50;

const invalid = (message, code = ReviewErrorCode.QUERY_INVALID) =>
  new BadRequestException({ message, code });
const notFound = (message = 'الطلب غير موجود') =>
  new NotFoundException({ message, code: ReviewErrorCode.NOT_FOUND });
const alreadyDecided = () =>
  new ConflictException({
    message: 'تمت مراجعة هذا الطلب بالفعل',
    code: ReviewErrorCode.ALREADY_DECIDED,
  });

function objectId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) {
    throw invalid('المعرف غير صحيح', ReviewErrorCode.ID_INVALID);
  }
  return new Types.ObjectId(value);
}

function paging(query) {
  const page = /^\d{1,5}$/.test(query.page ?? '1') ? Number(query.page ?? 1) : 0;
  const limit = /^\d{1,2}$/.test(query.limit ?? '20') ? Number(query.limit ?? 20) : 0;
  if (page < 1 || limit < 1 || limit > MAX_LIMIT) throw invalid('طلب غير صحيح');
  return { page, limit };
}

function reasonOf(reason) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 3 || text.length > 500) {
    throw new BadRequestException({
      message: 'اكتب سبب الرفض (من 3 إلى 500 حرف)',
      code: ReviewErrorCode.REASON_REQUIRED,
    });
  }
  return text;
}

const account = (user) =>
  user
    ? {
        id: String(user._id),
        name: user.fullName,
        email: user.email ?? null,
        phone: user.phone ?? null,
        accountType: user.accountType ?? null,
        verified: user.verificationTrustState === VerificationTrustState.VERIFIED,
      }
    : null;

const kycView = (user) => ({
  ...account(user),
  kycStatus: user.kycStatus,
  kycVersion: user.kycVersion ?? 0,
  submittedAt: user.kycSubmittedAt ?? null,
  reviewedAt: user.kycReviewedAt ?? null,
  rejectionReason: user.kycRejectionReason ?? null,
  // Which of the three photos can be opened.
  documents: Object.entries(KYC_DOCUMENTS)
    .filter(([, field]) => user[field]?.publicId)
    .map(([name]) => name),
});

const brokerView = (application, applicant) => ({
  id: String(application._id),
  status: application.status,
  submittedAt: application.submittedAt,
  reviewedAt: application.reviewedAt ?? null,
  rejectionReason:
    application.status === BrokerApplicationStatus.REJECTED
      ? (application.reviewReason ?? null)
      : null,
  hasDocument: (application.documentIds ?? []).length > 0,
  applicant: account(applicant),
});

/**
 * The review of what accounts ask for: an identity check, and becoming a
 * broker. Staff read the request with its private documents and decide; the
 * decision, its audit row and the account's notification happen together.
 */
class AccountReviewsService {
  constructor(users, applications, documents, assets, auditLog, outbox, connection, clock) {
    this.users = users;
    this.applications = applications;
    this.documents = documents;
    this.assets = assets;
    this.auditLog = auditLog;
    this.outbox = outbox;
    this.connection = connection;
    this.clock = clock ?? (() => new Date());
  }

  // ---------------------------------------------------------------------
  // Identity checks
  // ---------------------------------------------------------------------

  async kycQueue(query = {}) {
    const status = query.status ?? KycStatus.PENDING;
    const reviewable = [KycStatus.PENDING, KycStatus.VERIFIED, KycStatus.REJECTED];
    if (!reviewable.includes(status)) throw invalid('طلب غير صحيح');
    const { page, limit } = paging(query);
    const filter = { kycStatus: status };
    // The queue is worked oldest first; what was decided reads newest first.
    const sort = status === KycStatus.PENDING ? { kycSubmittedAt: 1 } : { kycReviewedAt: -1 };
    const [items, total] = await Promise.all([
      this.users
        .find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.users.countDocuments(filter).exec(),
    ]);
    return { items: items.map(kycView), page, limit, total };
  }

  async kycOne(userId) {
    return kycView(await this.submitted(userId));
  }

  /** One of the photos of an identity check, as a private image. Every look is recorded. */
  async kycDocument(actor, userId, name) {
    const field = KYC_DOCUMENTS[name];
    const user = field ? await this.submitted(userId) : null;
    const asset = user?.[field];
    if (!asset?.publicId) {
      throw new NotFoundException({
        message: 'المستند غير موجود',
        code: ReviewErrorCode.DOCUMENT_NOT_FOUND,
      });
    }
    const downloaded = await this.assets.downloadAuthenticatedAsset({
      ...asset,
      resourceType: asset.resourceType ?? 'image',
      deliveryType: asset.deliveryType ?? 'authenticated',
    });
    await this.auditLog.logRequired({
      action: AuditAction.PRIVATE_EVIDENCE_ACCESSED,
      actorUserId: actor.userId,
      targetUserId: String(user._id),
      reason: `viewed identity document ${name}`,
      ip: actor.ip,
    });
    return new StreamableFile(downloaded.buffer, { type: downloaded.contentType });
  }

  approveKyc(actor, userId) {
    return this.decideKyc(actor, userId, true);
  }

  async rejectKyc(actor, userId, reason) {
    return this.decideKyc(actor, userId, false, reasonOf(reason));
  }

  async decideKyc(actor, userId, approved, reason) {
    const id = objectId(userId);
    const now = this.clock();
    const decided = await runTransactionWithRetry(
      this.connection,
      async (session) => {
        // Only a request still waiting can be decided, so of two reviewers one wins.
        const user = await this.users
          .findOneAndUpdate(
            { _id: id, kycStatus: KycStatus.PENDING },
            {
              $set: {
                kycStatus: approved ? KycStatus.VERIFIED : KycStatus.REJECTED,
                kycReviewedAt: now,
                verificationTrustState: approved
                  ? VerificationTrustState.VERIFIED
                  : VerificationTrustState.UNVERIFIED,
                ...(approved ? {} : { kycRejectionReason: reason }),
              },
              ...(approved ? { $unset: { kycRejectionReason: '' } } : {}),
            },
            { new: true, session },
          )
          .lean()
          .exec();
        if (!user) return null;
        await this.auditLog.logRequired(
          {
            action: AuditAction.ADMIN_KYC_REVIEWED,
            actorUserId: actor.userId,
            targetUserId: String(user._id),
            reason: approved ? 'identity verified' : reason,
            ip: actor.ip,
            metadata: { decision: user.kycStatus, kycVersion: user.kycVersion ?? 0 },
          },
          session,
        );
        await this.outbox.recordRequired(
          kycDecisionEvent({
            decision: approved ? 'verified' : 'rejected',
            accountId: String(user._id),
            kycVersion: user.kycVersion ?? 0,
            occurredAt: now,
          }),
          session,
        );
        return user;
      },
      { retryExhausted: alreadyDecided },
    );
    if (!decided) {
      await this.submitted(userId);
      throw alreadyDecided();
    }
    return {
      message: approved ? 'تم توثيق الحساب' : 'تم رفض طلب التوثيق',
      request: kycView(decided),
    };
  }

  /** An account that sent an identity check at some point. */
  async submitted(userId) {
    const user = await this.users
      .findOne({ _id: objectId(userId), kycStatus: { $ne: KycStatus.NOT_SUBMITTED } })
      .lean()
      .exec();
    if (!user) throw notFound();
    return user;
  }

  // ---------------------------------------------------------------------
  // Broker applications
  // ---------------------------------------------------------------------

  async brokerQueue(query = {}) {
    const status = query.status ?? BrokerApplicationStatus.PENDING;
    if (!Object.values(BrokerApplicationStatus).includes(status)) throw invalid('طلب غير صحيح');
    const { page, limit } = paging(query);
    const filter = { status };
    const sort =
      status === BrokerApplicationStatus.PENDING ? { submittedAt: 1 } : { reviewedAt: -1 };
    const [items, total] = await Promise.all([
      this.applications
        .find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.applications.countDocuments(filter).exec(),
    ]);
    const ids = [...new Set(items.map((item) => String(item.applicantAccountId)))];
    const applicants = ids.length
      ? await this.users
          .find({ _id: { $in: ids.map((value) => new Types.ObjectId(value)) } })
          .lean()
          .exec()
      : [];
    const byId = new Map(applicants.map((user) => [String(user._id), user]));
    return {
      items: items.map((item) => brokerView(item, byId.get(String(item.applicantAccountId)))),
      page,
      limit,
      total,
    };
  }

  async brokerOne(applicationId) {
    const application = await this.application(applicationId);
    return brokerView(application, await this.applicantOf(application));
  }

  /** The document sent with a broker application, as a private file. Every look is recorded. */
  async brokerDocument(actor, applicationId) {
    const application = await this.application(applicationId);
    const document = await this.documents.findOne({ applicationId: application._id }).lean().exec();
    if (!document?.assetRef?.publicId) {
      throw new NotFoundException({
        message: 'المستند غير موجود',
        code: ReviewErrorCode.DOCUMENT_NOT_FOUND,
      });
    }
    const downloaded = await this.assets.downloadAuthenticatedAsset(document.assetRef);
    await this.auditLog.logRequired({
      action: AuditAction.PRIVATE_EVIDENCE_ACCESSED,
      actorUserId: actor.userId,
      targetUserId: String(application.applicantAccountId),
      targetResourceId: String(application._id),
      reason: 'viewed broker verification document',
      ip: actor.ip,
    });
    return new StreamableFile(downloaded.buffer, { type: downloaded.contentType });
  }

  approveBroker(actor, applicationId) {
    return this.decideBroker(actor, applicationId, true);
  }

  async rejectBroker(actor, applicationId, reason) {
    return this.decideBroker(actor, applicationId, false, reasonOf(reason));
  }

  async decideBroker(actor, applicationId, approved, reason) {
    const id = objectId(applicationId);
    const now = this.clock();
    const decided = await runTransactionWithRetry(
      this.connection,
      async (session) => {
        const application = await this.applications
          .findOneAndUpdate(
            { _id: id, status: BrokerApplicationStatus.PENDING },
            {
              $set: {
                status: approved
                  ? BrokerApplicationStatus.APPROVED
                  : BrokerApplicationStatus.REJECTED,
                reviewedAt: now,
                reviewedByActorId: objectId(actor.userId),
                ...(approved ? {} : { reviewReason: reason }),
              },
              $inc: { version: 1 },
            },
            { new: true, session },
          )
          .lean()
          .exec();
        if (!application) return null;
        // The account becomes a broker, or goes back to an ordinary one that may apply again.
        const applicant = await this.users
          .findOneAndUpdate(
            { _id: application.applicantAccountId },
            {
              $set: approved
                ? { accountType: AccountType.BROKER, brokerStatus: BrokerStatus.APPROVED }
                : { accountType: AccountType.USER, brokerStatus: BrokerStatus.REJECTED },
              $inc: { brokerVersion: 1 },
            },
            { new: true, session },
          )
          .lean()
          .exec();
        if (!applicant) throw notFound('حساب مقدم الطلب غير موجود');
        await this.auditLog.logRequired(
          {
            action: AuditAction.ADMIN_BROKER_APPLICATION_REVIEWED,
            actorUserId: actor.userId,
            targetUserId: String(applicant._id),
            targetResourceId: String(application._id),
            reason: approved ? 'broker application approved' : reason,
            ip: actor.ip,
            metadata: { decision: application.status },
          },
          session,
        );
        await this.outbox.recordRequired(
          brokerDecisionEvent({
            approved,
            applicationId: String(application._id),
            accountId: String(applicant._id),
            occurredAt: now,
          }),
          session,
        );
        return { application, applicant };
      },
      { retryExhausted: alreadyDecided },
    );
    if (!decided) {
      await this.application(applicationId);
      throw alreadyDecided();
    }
    return {
      message: approved ? 'تم قبول طلب الوسيط' : 'تم رفض طلب الوسيط',
      application: brokerView(decided.application, decided.applicant),
    };
  }

  async application(applicationId) {
    const application = await this.applications
      .findOne({ _id: objectId(applicationId) })
      .lean()
      .exec();
    if (!application) throw notFound();
    return application;
  }

  applicantOf(application) {
    return this.users.findOne({ _id: application.applicantAccountId }).lean().exec();
  }
}

module.exports = { AccountReviewsService, ReviewErrorCode, KYC_DOCUMENTS };
