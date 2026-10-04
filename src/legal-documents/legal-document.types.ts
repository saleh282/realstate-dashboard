export enum LegalDocumentType {
  TERMS = 'TERMS',
  PRIVACY = 'PRIVACY',
}

export enum LegalDocumentStatus {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  ARCHIVED = 'ARCHIVED',
}

export const LEGAL_DOCUMENTS_COLLECTION = 'legal_documents';

export enum LegalDocumentErrorCode {
  LEGAL_ACCEPTANCE_OUTDATED = 'LEGAL_ACCEPTANCE_OUTDATED',
  LEGAL_DOCUMENTS_UNAVAILABLE = 'LEGAL_DOCUMENTS_UNAVAILABLE',
  LEGAL_DOCUMENT_NOT_FOUND = 'LEGAL_DOCUMENT_NOT_FOUND',
  LEGAL_DOCUMENT_NOT_DRAFT = 'LEGAL_DOCUMENT_NOT_DRAFT',
  LEGAL_DOCUMENT_VERSION_CONFLICT = 'LEGAL_DOCUMENT_VERSION_CONFLICT',
}

export type LegalDocumentSectionContent = {
  headingAr: string;
  headingEn: string;
  bodyAr: string;
  bodyEn: string;
};

/** URL slugs (`/legal-documents/terms`) are lower-case; stored values are upper-case. */
export function parseLegalDocumentType(value: string | undefined): LegalDocumentType | null {
  const normalized = value?.trim().toUpperCase();
  return Object.values(LegalDocumentType).find((type) => type === normalized) ?? null;
}
