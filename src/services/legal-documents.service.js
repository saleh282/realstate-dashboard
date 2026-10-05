'use strict';

const {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} = require('../common/http/errors');
const { Types } = require('mongoose');
const { AuditAction } = require('../models/audit-log.model');
const {
  LegalDocumentErrorCode,
  LegalDocumentStatus,
  LegalDocumentType,
} = require('../domain/legal-documents/legal-document.types');
class LegalDocumentsService {
  constructor(model, audit) {
    this.model = model;
    this.audit = audit;
  }
  // The live document is the highest published version. Publishing marks the
  // new version first and archives the old one afterwards, so there is never
  // a moment without a live document.
  findCurrent(type) {
    return this.model
      .findOne({ type, status: LegalDocumentStatus.PUBLISHED })
      .sort({ version: -1 })
      .lean()
      .exec();
  }
  async listCurrent() {
    const items = await Promise.all(
      Object.values(LegalDocumentType).map((type) => this.findCurrent(type)),
    );
    return { items: items.filter(Boolean).map((item) => this.toSummary(item)) };
  }
  async getCurrent(type) {
    const item = await this.findCurrent(type);
    if (!item) throw this.notFound();
    return this.toPublic(item);
  }
  /**
   * Confirms that a registration accepted the versions that are live right
   * now, and returns the record to store on the account.
   */
  async resolveAcceptance(acceptedTermsVersion, acceptedPrivacyVersion, ip) {
    const [terms, privacy] = await Promise.all([
      this.findCurrent(LegalDocumentType.TERMS),
      this.findCurrent(LegalDocumentType.PRIVACY),
    ]);
    if (!terms || !privacy) {
      throw new ServiceUnavailableException({
        message: 'الشروط والأحكام وسياسة الخصوصية غير متاحة حالياً، حاول مرة أخرى لاحقاً',
        code: LegalDocumentErrorCode.LEGAL_DOCUMENTS_UNAVAILABLE,
      });
    }
    if (acceptedTermsVersion !== terms.version || acceptedPrivacyVersion !== privacy.version) {
      throw new ConflictException({
        message: 'تم تحديث الشروط والأحكام أو سياسة الخصوصية، يرجى مراجعتها والموافقة عليها',
        code: LegalDocumentErrorCode.LEGAL_ACCEPTANCE_OUTDATED,
        currentTermsVersion: terms.version,
        currentPrivacyVersion: privacy.version,
      });
    }
    return {
      termsVersion: terms.version,
      privacyVersion: privacy.version,
      acceptedAt: new Date(),
      ...(ip ? { ip } : {}),
    };
  }
  async listAdmin(type) {
    const items = await this.model
      .find(type ? { type } : {})
      .sort({ type: 1, version: -1 })
      .lean()
      .exec();
    return { items: items.map((item) => this.toAdmin(item)) };
  }
  async getAdmin(id) {
    this.assertId(id);
    const item = await this.model.findById(id).lean().exec();
    if (!item) throw this.notFound();
    return this.toAdmin(item);
  }
  async createDraft(dto, actorUserId, ip) {
    const source = dto.copyFromPublished ? await this.findCurrent(dto.type) : null;
    if (dto.copyFromPublished && !source) throw this.notFound();
    const titleAr = dto.titleAr?.trim() ?? source?.titleAr;
    const titleEn = dto.titleEn?.trim() ?? source?.titleEn;
    const sections = dto.sections ? this.cleanSections(dto.sections) : source?.sections;
    if (!titleAr || !titleEn || !sections?.length) {
      throw new BadRequestException('عنوان المستند ومحتواه مطلوبان بالعربية والإنجليزية');
    }
    const latest = await this.model.findOne({ type: dto.type }).sort({ version: -1 }).lean().exec();
    try {
      const item = await this.model.create({
        type: dto.type,
        version: (latest?.version ?? 0) + 1,
        status: LegalDocumentStatus.DRAFT,
        titleAr,
        titleEn,
        sections,
        changeSummary: dto.changeSummary?.trim() || undefined,
        createdBy: new Types.ObjectId(actorUserId),
      });
      await this.audit.logAdminResourceAction(
        AuditAction.ADMIN_LEGAL_DOCUMENT_DRAFT_CREATED,
        actorUserId,
        item._id.toString(),
        `created ${item.type} draft v${item.version}`,
        ip,
      );
      return { message: 'تم إنشاء مسودة المستند بنجاح', ...this.toAdmin(item.toObject()) };
    } catch (error) {
      // Two drafts created at once computed the same next version.
      if (error?.code === 11000) throw this.versionConflict();
      throw error;
    }
  }
  async updateDraft(id, dto, actorUserId, ip) {
    this.assertId(id);
    const update = {
      ...(dto.titleAr !== undefined ? { titleAr: dto.titleAr.trim() } : {}),
      ...(dto.titleEn !== undefined ? { titleEn: dto.titleEn.trim() } : {}),
      ...(dto.sections !== undefined ? { sections: this.cleanSections(dto.sections) } : {}),
      ...(dto.changeSummary !== undefined ? { changeSummary: dto.changeSummary.trim() } : {}),
      updatedBy: new Types.ObjectId(actorUserId),
    };
    // The status is part of the filter so a version published concurrently is never edited.
    const item = await this.model
      .findOneAndUpdate(
        { _id: id, status: LegalDocumentStatus.DRAFT },
        { $set: update },
        { new: true, runValidators: true },
      )
      .lean()
      .exec();
    if (!item) throw await this.notDraftOrMissing(id);
    await this.audit.logAdminResourceAction(
      AuditAction.ADMIN_LEGAL_DOCUMENT_DRAFT_UPDATED,
      actorUserId,
      id,
      `updated ${item.type} draft v${item.version}`,
      ip,
    );
    return { message: 'تم تحديث مسودة المستند بنجاح', ...this.toAdmin(item) };
  }
  async publish(id, actorUserId, ip) {
    this.assertId(id);
    const draft = await this.model.findById(id).lean().exec();
    if (!draft) throw this.notFound();
    if (draft.status !== LegalDocumentStatus.DRAFT) throw this.notDraft();
    const current = await this.findCurrent(draft.type);
    // An older draft must not replace a newer live version.
    if (current && current.version >= draft.version) throw this.versionConflict();
    const item = await this.model
      .findOneAndUpdate(
        { _id: id, status: LegalDocumentStatus.DRAFT },
        {
          $set: {
            status: LegalDocumentStatus.PUBLISHED,
            publishedAt: new Date(),
            publishedBy: new Types.ObjectId(actorUserId),
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    if (!item) throw this.notDraft();
    await this.model
      .updateMany(
        { type: item.type, status: LegalDocumentStatus.PUBLISHED, version: { $lt: item.version } },
        { $set: { status: LegalDocumentStatus.ARCHIVED } },
      )
      .exec();
    await this.audit.logAdminResourceAction(
      AuditAction.ADMIN_LEGAL_DOCUMENT_PUBLISHED,
      actorUserId,
      id,
      `published ${item.type} v${item.version}`,
      ip,
    );
    return { message: 'تم نشر المستند بنجاح', ...this.toAdmin(item) };
  }
  cleanSections(sections) {
    return sections.map((section) => ({
      headingAr: section.headingAr.trim(),
      headingEn: section.headingEn.trim(),
      bodyAr: section.bodyAr.trim(),
      bodyEn: section.bodyEn.trim(),
    }));
  }
  assertId(id) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف المستند غير صالح');
  }
  async notDraftOrMissing(id) {
    return (await this.model.exists({ _id: id })) ? this.notDraft() : this.notFound();
  }
  notFound() {
    return new NotFoundException({
      message: 'المستند غير موجود',
      code: LegalDocumentErrorCode.LEGAL_DOCUMENT_NOT_FOUND,
    });
  }
  notDraft() {
    return new ConflictException({
      message: 'لا يمكن تعديل نسخة منشورة؛ أنشئ مسودة جديدة',
      code: LegalDocumentErrorCode.LEGAL_DOCUMENT_NOT_DRAFT,
    });
  }
  versionConflict() {
    return new ConflictException({
      message: 'توجد نسخة أحدث من هذا المستند؛ أنشئ مسودة جديدة',
      code: LegalDocumentErrorCode.LEGAL_DOCUMENT_VERSION_CONFLICT,
    });
  }
  toSummary(item) {
    return {
      type: item.type,
      version: item.version,
      titleAr: item.titleAr,
      titleEn: item.titleEn,
      publishedAt: item.publishedAt,
    };
  }
  toPublic(item) {
    return {
      ...this.toSummary(item),
      sections: (item.sections ?? []).map((section) => ({
        headingAr: section.headingAr,
        headingEn: section.headingEn,
        bodyAr: section.bodyAr,
        bodyEn: section.bodyEn,
      })),
    };
  }
  toAdmin(item) {
    return {
      id: item._id.toString(),
      ...this.toPublic(item),
      status: item.status,
      changeSummary: item.changeSummary,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}

Object.assign(exports, { LegalDocumentsService });
