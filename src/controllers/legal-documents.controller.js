'use strict';

const { BadRequestException } = require('../common/http/errors');
const { renderLegalDocumentPage } = require('../views/legal-document-page');
const { parseLegalDocumentType } = require('../domain/legal-documents/legal-document.types');
// Public: guests read these before they have an account.
class LegalDocumentsController {
  constructor(service) {
    this.service = service;
  }
  list() {
    return this.service.listCurrent();
  }
  get(type) {
    return this.service.getCurrent(this.typeOf(type));
  }
  // Written straight to the response so the JSON envelope is not applied.
  async page(type, lang, res) {
    const document = await this.service.getCurrent(this.typeOf(type));
    res.type('html').send(renderLegalDocumentPage(document, lang === 'en' ? 'en' : 'ar'));
  }
  typeOf(value) {
    const type = parseLegalDocumentType(value);
    if (!type) throw new BadRequestException('نوع المستند غير مدعوم');
    return type;
  }
}

Object.assign(exports, { LegalDocumentsController });
