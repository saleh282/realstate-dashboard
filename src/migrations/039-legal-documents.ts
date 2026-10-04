import type { Db } from 'mongodb';
import type { MigrationDefinition } from './framework/migration.types';
import { indexKeyMatches } from './022-property-type-selection';
import { LEGAL_DOCUMENT_SEED, type LegalDocumentSeed } from '../legal-documents/legal-document.seed';
import { LEGAL_DOCUMENTS_COLLECTION, LegalDocumentStatus } from '../legal-documents/legal-document.types';

/**
 * Creates the legal_documents indexes and publishes version 1 of the terms
 * and the privacy policy. Registration requires both to exist.
 *
 * Insert-only: a type that already has any document (seeded earlier, or
 * written by an admin) is never touched, so re-running cannot overwrite text.
 */
export const LEGAL_DOCUMENT_INDEXES = [
  { key: { type: 1, version: 1 }, options: { name: 'legal_document_type_version_unique', unique: true } },
  { key: { type: 1, status: 1, version: -1 }, options: { name: 'legal_document_current_lookup' } },
] as const;

export function legalDocumentSeedDocument(seed: LegalDocumentSeed, now: Date) {
  return {
    type: seed.type,
    version: 1,
    status: LegalDocumentStatus.PUBLISHED,
    titleAr: seed.titleAr,
    titleEn: seed.titleEn,
    sections: seed.sections,
    changeSummary: 'Initial version',
    publishedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

export async function scanLegalDocumentSeed(db: Db) {
  const collection = db.collection(LEGAL_DOCUMENTS_COLLECTION);
  const missing: string[] = [];
  const unpublished: string[] = [];
  for (const seed of LEGAL_DOCUMENT_SEED) {
    if (!(await collection.countDocuments({ type: seed.type }))) missing.push(seed.type);
    else if (!(await collection.countDocuments({ type: seed.type, status: LegalDocumentStatus.PUBLISHED }))) unpublished.push(seed.type);
  }
  return { missing, unpublished };
}

export async function scanLegalDocumentIndexes(db: Db) {
  const existing = await db.collection(LEGAL_DOCUMENTS_COLLECTION).indexes().catch((error: { code?: number }) => {
    if (error.code === 26) return [];
    throw error;
  });
  const missing: string[] = [];
  const conflicting: string[] = [];
  for (const spec of LEGAL_DOCUMENT_INDEXES) {
    const found = existing.find((index) => index.name === spec.options.name);
    if (!found) missing.push(spec.options.name);
    else if (!indexKeyMatches(found as any, spec.key) || Boolean(found.unique) !== Boolean('unique' in spec.options && spec.options.unique)) conflicting.push(spec.options.name);
  }
  return { missing, conflicting };
}

export async function seedLegalDocuments(db: Db, now: Date): Promise<number> {
  const collection = db.collection(LEGAL_DOCUMENTS_COLLECTION);
  let inserted = 0;
  for (const seed of LEGAL_DOCUMENT_SEED) {
    if (await collection.countDocuments({ type: seed.type })) continue;
    const result = await collection.updateOne({ type: seed.type, version: 1 }, { $setOnInsert: legalDocumentSeedDocument(seed, now) }, { upsert: true });
    inserted += result.upsertedCount ? 1 : 0;
  }
  return inserted;
}

export const legalDocumentsMigration: MigrationDefinition = {
  id: '039-legal-documents',
  version: 1,
  description: 'Create the legal_documents indexes and publish version 1 of the terms and conditions and the privacy policy; insert-only, existing documents are never modified',
  dependencies: [],
  rollback: {
    kind: 'none',
    remediation: 'Never delete a published legal document: accounts record the version they accepted. Correct the text by publishing a new version through the Admin API.',
    restoreProcedure: 'Restore the verified pre-migration snapshot to a separate database and compare the legal_documents collection before any production remediation.',
  },
  async preflight({ db }) {
    const documents = await scanLegalDocumentSeed(db);
    const indexes = await scanLegalDocumentIndexes(db);
    return {
      eligible: documents.missing.length + indexes.missing.length,
      alreadyApplied: LEGAL_DOCUMENT_SEED.length - documents.missing.length + LEGAL_DOCUMENT_INDEXES.length - indexes.missing.length - indexes.conflicting.length,
      blockers: indexes.conflicting.length
        ? [{ code: 'LEGAL_DOCUMENT_INDEX_CONFLICT', message: `An index named ${indexes.conflicting.join(', ')} exists with a different key or uniqueness` }]
        : [],
      summary: { missingDocuments: documents.missing, typesWithoutPublishedVersion: documents.unpublished, missingIndexes: indexes.missing },
    };
  },
  async migrateBatch({ db }) {
    for (const index of LEGAL_DOCUMENT_INDEXES) await db.collection(LEGAL_DOCUMENTS_COLLECTION).createIndex(index.key as never, index.options);
    const inserted = await seedLegalDocuments(db, new Date());
    return { scanned: LEGAL_DOCUMENT_SEED.length, modified: inserted, done: true };
  },
  async validate({ db }) {
    const documents = await scanLegalDocumentSeed(db);
    const indexes = await scanLegalDocumentIndexes(db);
    return {
      valid: !documents.missing.length && !indexes.missing.length && !indexes.conflicting.length,
      errors: [
        ...documents.missing.map((type) => ({ code: 'LEGAL_DOCUMENT_MISSING', message: `No ${type} legal document exists` })),
        ...[...indexes.missing, ...indexes.conflicting].map((name) => ({ code: 'LEGAL_DOCUMENT_INDEX_MISSING', message: `Index ${name} is missing or conflicting` })),
      ],
      // Admin-authored drafts with nothing live yet: registration stays closed until one is published.
      summary: { typesWithoutPublishedVersion: documents.unpublished },
    };
  },
};
