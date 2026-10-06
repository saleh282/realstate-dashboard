'use strict';

const { BadRequestException } = require('../common/http/errors');
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
  typeOf(value) {
    const type = parseLegalDocumentType(value);
    if (!type) throw new BadRequestException('نوع المستند غير مدعوم');
    return type;
  }
}

Object.assign(exports, { LegalDocumentsController });
