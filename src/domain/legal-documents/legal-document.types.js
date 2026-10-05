'use strict';

var LegalDocumentType;
(function (LegalDocumentType) {
  LegalDocumentType['TERMS'] = 'TERMS';
  LegalDocumentType['PRIVACY'] = 'PRIVACY';
})(LegalDocumentType || (LegalDocumentType = {}));
var LegalDocumentStatus;
(function (LegalDocumentStatus) {
  LegalDocumentStatus['DRAFT'] = 'DRAFT';
  LegalDocumentStatus['PUBLISHED'] = 'PUBLISHED';
  LegalDocumentStatus['ARCHIVED'] = 'ARCHIVED';
})(LegalDocumentStatus || (LegalDocumentStatus = {}));
const LEGAL_DOCUMENTS_COLLECTION = 'legal_documents';
var LegalDocumentErrorCode;
(function (LegalDocumentErrorCode) {
  LegalDocumentErrorCode['LEGAL_ACCEPTANCE_OUTDATED'] = 'LEGAL_ACCEPTANCE_OUTDATED';
  LegalDocumentErrorCode['LEGAL_DOCUMENTS_UNAVAILABLE'] = 'LEGAL_DOCUMENTS_UNAVAILABLE';
  LegalDocumentErrorCode['LEGAL_DOCUMENT_NOT_FOUND'] = 'LEGAL_DOCUMENT_NOT_FOUND';
  LegalDocumentErrorCode['LEGAL_DOCUMENT_NOT_DRAFT'] = 'LEGAL_DOCUMENT_NOT_DRAFT';
  LegalDocumentErrorCode['LEGAL_DOCUMENT_VERSION_CONFLICT'] = 'LEGAL_DOCUMENT_VERSION_CONFLICT';
})(LegalDocumentErrorCode || (LegalDocumentErrorCode = {}));
/** URL slugs (`/legal-documents/terms`) are lower-case; stored values are upper-case. */
function parseLegalDocumentType(value) {
  const normalized = value?.trim().toUpperCase();
  return Object.values(LegalDocumentType).find((type) => type === normalized) ?? null;
}

Object.assign(exports, {
  LegalDocumentType,
  LegalDocumentStatus,
  LEGAL_DOCUMENTS_COLLECTION,
  LegalDocumentErrorCode,
  parseLegalDocumentType,
});
