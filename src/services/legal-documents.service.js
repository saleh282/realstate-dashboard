'use strict';

const {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} = require('../common/http/errors');
const { Types } = require('mongoose');
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
  assertId(id) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف المستند غير صالح');
  }
  notFound() {
    return new NotFoundException({
      message: 'المستند غير موجود',
      code: LegalDocumentErrorCode.LEGAL_DOCUMENT_NOT_FOUND,
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
}

Object.assign(exports, { LegalDocumentsService });
