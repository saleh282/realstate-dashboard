'use strict';

require('reflect-metadata');
const {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} = require('../src/common/http/errors');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { Types } = require('mongoose');
const { AuthService } = require('../src/services/auth.service');
const { RegisterDto } = require('../src/validators/auth/register.dto');
const { LEGAL_DOCUMENT_SEED } = require('../src/domain/legal-documents/legal-document.seed');
const {
  LegalDocumentErrorCode,
  LegalDocumentStatus,
  LegalDocumentType,
  parseLegalDocumentType,
} = require('../src/domain/legal-documents/legal-document.types');
const { LegalDocumentsService } = require('../src/services/legal-documents.service');
const { legalDocumentsMigration } = require('../src/migrations/039-legal-documents');
const { MigrationRunner } = require('../src/migrations/framework/migration.runner');
const { MemoryDb, MemoryStore } = require('./support/memory-mongo');
const ADMIN_ID = '64e0000000000000000000a1';
const section = (label) => ({
  headingAr: `عنوان ${label}`,
  headingEn: `Heading ${label}`,
  bodyAr: `نص ${label}`,
  bodyEn: `Body ${label}`,
});
/**
 * In-memory stand-in for the Mongoose model. It enforces the unique
 * (type, version) index so version races surface as real duplicate-key errors.
 */
function fakeLegalDocumentModel(seed = []) {
  const rows = seed.map((row) => ({ _id: new Types.ObjectId(), ...row }));
  const matches = (row, filter) =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = key === '_id' ? row._id.toString() : row[key];
      if (expected && typeof expected === 'object' && '$lt' in expected)
        return actual < expected.$lt;
      return actual === (key === '_id' ? String(expected) : expected);
    });
  const sorted = (items, spec) =>
    [...items].sort((a, b) => {
      for (const [key, direction] of Object.entries(spec)) {
        if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * direction;
      }
      return 0;
    });
  const query = (resolve) => {
    let sort;
    const chain = {
      sort: (spec) => {
        sort = spec;
        return chain;
      },
      lean: () => chain,
      exec: async () => {
        const result = resolve();
        if (!Array.isArray(result)) return result ? { ...result } : null;
        return (sort ? sorted(result, sort) : result).map((row) => ({ ...row }));
      },
    };
    return chain;
  };
  return {
    rows,
    find: (filter = {}) => query(() => rows.filter((row) => matches(row, filter))),
    findOne: (filter = {}) => {
      let sort = {};
      const chain = {
        sort: (spec) => {
          sort = spec;
          return chain;
        },
        lean: () => chain,
        exec: async () => {
          const found = sorted(
            rows.filter((row) => matches(row, filter)),
            sort,
          )[0];
          return found ? { ...found } : null;
        },
      };
      return chain;
    },
    findById: (id) => query(() => rows.find((row) => row._id.toString() === String(id))),
    exists: async (filter) =>
      rows.some((row) => matches(row, filter)) ? { _id: filter._id } : null,
    create: async (data) => {
      if (rows.some((row) => row.type === data.type && row.version === data.version)) {
        throw Object.assign(new Error('duplicate key'), { code: 11000 });
      }
      const row = { _id: new Types.ObjectId(), ...data };
      rows.push(row);
      return { ...row, toObject: () => ({ ...row }) };
    },
    findOneAndUpdate: (filter, update) =>
      query(() => {
        const row = rows.find((candidate) => matches(candidate, filter));
        if (row) Object.assign(row, update.$set);
        return row;
      }),
    updateMany: (filter, update) => ({
      exec: async () => {
        const targets = rows.filter((row) => matches(row, filter));
        targets.forEach((row) => Object.assign(row, update.$set));
        return { modifiedCount: targets.length };
      },
    }),
  };
}
const published = (type, version) => ({
  type,
  version,
  status: LegalDocumentStatus.PUBLISHED,
  titleAr: `عنوان ${type}`,
  titleEn: `Title ${type}`,
  sections: [section(`${type}-${version}`)],
  publishedAt: new Date('2026-01-01T00:00:00Z'),
});
function createService(
  seed = [published(LegalDocumentType.TERMS, 1), published(LegalDocumentType.PRIVACY, 1)],
) {
  const model = fakeLegalDocumentModel(seed);
  const audit = { logAdminResourceAction: jest.fn().mockResolvedValue(undefined) };
  return { service: new LegalDocumentsService(model, audit), model, audit };
}
describe('legal documents service', () => {
  it('serves the highest published version of each type and hides drafts', async () => {
    const { service } = createService([
      published(LegalDocumentType.TERMS, 1),
      { ...published(LegalDocumentType.TERMS, 2), status: LegalDocumentStatus.DRAFT },
      published(LegalDocumentType.PRIVACY, 3),
    ]);
    const { items } = await service.listCurrent();
    expect(items.map((item) => [item.type, item.version])).toEqual([
      ['TERMS', 1],
      ['PRIVACY', 3],
    ]);
    const terms = await service.getCurrent(LegalDocumentType.TERMS);
    expect(terms).toMatchObject({ version: 1, sections: [section('TERMS-1')] });
    expect(terms).not.toHaveProperty('status');
    expect(terms).not.toHaveProperty('id');
  });
  it('reports a missing document as not found', async () => {
    const { service } = createService([published(LegalDocumentType.TERMS, 1)]);
    await expect(service.getCurrent(LegalDocumentType.PRIVACY)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('accepts only the live versions', async () => {
    const { service } = createService([
      published(LegalDocumentType.TERMS, 2),
      published(LegalDocumentType.PRIVACY, 1),
    ]);
    expect(await service.resolveAcceptance(2, 1, '9.9.9.9')).toMatchObject({
      termsVersion: 2,
      privacyVersion: 1,
      ip: '9.9.9.9',
      acceptedAt: expect.any(Date),
    });
    for (const [terms, privacy] of [
      [1, 1],
      [2, 2],
      [undefined, 1],
      [2, undefined],
    ]) {
      const error = await service.resolveAcceptance(terms, privacy).catch((caught) => caught);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({
        code: LegalDocumentErrorCode.LEGAL_ACCEPTANCE_OUTDATED,
        currentTermsVersion: 2,
        currentPrivacyVersion: 1,
      });
    }
  });
  it('closes registration while a document has no live version', async () => {
    const { service } = createService([published(LegalDocumentType.TERMS, 1)]);
    await expect(service.resolveAcceptance(1, 1)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
describe('registration consent', () => {
  const registration = (overrides = {}) => ({
    fullName: 'New User',
    identifier: 'new@example.com',
    phone: '+201012345678',
    password: 'Password123!',
    confirmPassword: 'Password123!',
    acceptedTermsVersion: 1,
    acceptedPrivacyVersion: 1,
    ...overrides,
  });
  function createAuth(existing = null) {
    const users = {
      findByIdentifier: jest.fn(async (identifier) => (identifier.includes('@') ? existing : null)),
      create: jest.fn(async (data) => ({ _id: { toString: () => 'user-1' }, ...data })),
      replaceUnverifiedRegistration: jest.fn().mockResolvedValue(true),
      releaseUnverifiedPhone: jest.fn().mockResolvedValue(true),
    };
    const otp = {
      assertCanResend: jest.fn().mockResolvedValue(undefined),
      generateAndStore: jest.fn().mockResolvedValue('123456'),
    };
    const mail = { sendOtp: jest.fn().mockResolvedValue(undefined) };
    const { service: legal } = createService();
    const auth = new AuthService(
      users,
      {},
      { get: jest.fn() },
      otp,
      mail,
      { revokeAllForUser: jest.fn().mockResolvedValue(undefined) },
      { log: jest.fn().mockResolvedValue(undefined) },
      undefined,
      legal,
    );
    return { auth, users, otp, mail };
  }
  it('requires both accepted versions as positive integers', async () => {
    const errorsFor = async (payload) =>
      (
        await validate(plainToInstance(RegisterDto, payload), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).map((error) => error.property);
    expect(await errorsFor(registration())).toEqual([]);
    const {
      acceptedTermsVersion: _terms,
      acceptedPrivacyVersion: _privacy,
      ...withoutConsent
    } = registration();
    expect(await errorsFor(withoutConsent)).toEqual([
      'acceptedTermsVersion',
      'acceptedPrivacyVersion',
    ]);
    expect(await errorsFor(registration({ acceptedTermsVersion: 0 }))).toEqual([
      'acceptedTermsVersion',
    ]);
    expect(await errorsFor(registration({ acceptedPrivacyVersion: 1.5 }))).toEqual([
      'acceptedPrivacyVersion',
    ]);
    expect(await errorsFor({ ...registration(), acceptedTermsVersion: '1' })).toEqual([
      'acceptedTermsVersion',
    ]);
  });
  it('stores the accepted versions, time and address on the new account', async () => {
    const { auth, users } = createAuth();
    await auth.register(registration(), '5.5.5.5');
    expect(users.create.mock.calls[0][0].legalAcceptance).toEqual({
      termsVersion: 1,
      privacyVersion: 1,
      acceptedAt: expect.any(Date),
      ip: '5.5.5.5',
    });
  });
  it('rejects a stale acceptance before anything is written or sent', async () => {
    const { auth, users, otp, mail } = createAuth();
    const error = await auth
      .register(registration({ acceptedPrivacyVersion: 2 }))
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({
      code: LegalDocumentErrorCode.LEGAL_ACCEPTANCE_OUTDATED,
    });
    expect(users.create).not.toHaveBeenCalled();
    expect(users.releaseUnverifiedPhone).not.toHaveBeenCalled();
    expect(otp.generateAndStore).not.toHaveBeenCalled();
    expect(mail.sendOtp).not.toHaveBeenCalled();
  });
  it('records the acceptance when an unverified registration is repeated', async () => {
    const { auth, users } = createAuth({
      _id: { toString: () => 'pending-1' },
      email: 'new@example.com',
    });
    await auth.register(registration(), '5.5.5.5').catch((caught) => caught);
    expect(users.replaceUnverifiedRegistration).toHaveBeenCalledWith(
      'pending-1',
      expect.objectContaining({
        legalAcceptance: expect.objectContaining({ termsVersion: 1, privacyVersion: 1 }),
      }),
    );
  });
});
describe('legal document type slugs', () => {
  it('maps URL slugs to stored types', () => {
    expect(parseLegalDocumentType('terms')).toBe(LegalDocumentType.TERMS);
    expect(parseLegalDocumentType(' Privacy ')).toBe(LegalDocumentType.PRIVACY);
    expect(parseLegalDocumentType('cookies')).toBeNull();
  });
});
describe('039-legal-documents migration', () => {
  const runner = (db, store = new MemoryStore()) =>
    new MigrationRunner(db, store, { batchSize: 250 });
  it('ships complete bilingual seed text', () => {
    expect(LEGAL_DOCUMENT_SEED.map((seed) => seed.type).sort()).toEqual(['PRIVACY', 'TERMS']);
    for (const seed of LEGAL_DOCUMENT_SEED) {
      expect(seed.sections.length).toBeGreaterThan(5);
      for (const part of seed.sections) {
        for (const text of [part.headingAr, part.headingEn, part.bodyAr, part.bodyEn])
          expect(text.trim()).not.toBe('');
      }
    }
  });
  it('dry-runs without writing, then publishes version 1 of both documents and is idempotent', async () => {
    const db = new MemoryDb();
    const dryRun = await runner(db).run(legalDocumentsMigration, 'dry-run');
    expect(dryRun.preflight).toMatchObject({ eligible: 4, blockers: [] });
    expect(db.writes).toEqual([]);
    expect(await runner(db).run(legalDocumentsMigration, 'apply')).toMatchObject({
      status: 'complete',
      modified: 2,
    });
    expect(
      db
        .docs('legal_documents')
        .map((doc) => [doc.type, doc.version, doc.status])
        .sort(),
    ).toEqual([
      ['PRIVACY', 1, 'PUBLISHED'],
      ['TERMS', 1, 'PUBLISHED'],
    ]);
    const before = JSON.stringify(db.docs('legal_documents'));
    expect(await runner(db).run(legalDocumentsMigration, 'apply')).toMatchObject({
      status: 'complete',
      modified: 0,
    });
    expect(JSON.stringify(db.docs('legal_documents'))).toBe(before);
  });
  it('never overwrites a type that already has a document', async () => {
    const existing = {
      _id: new Types.ObjectId(),
      type: 'TERMS',
      version: 5,
      status: 'PUBLISHED',
      titleAr: 'نص الشركة',
      titleEn: 'Company text',
      sections: [],
    };
    const db = new MemoryDb().seed('legal_documents', [existing]);
    expect(await runner(db).run(legalDocumentsMigration, 'apply')).toMatchObject({
      status: 'complete',
      modified: 1,
    });
    const terms = db.docs('legal_documents').filter((doc) => doc.type === 'TERMS');
    expect(terms).toEqual([existing]);
    expect(db.docs('legal_documents').filter((doc) => doc.type === 'PRIVACY')).toHaveLength(1);
  });
});
