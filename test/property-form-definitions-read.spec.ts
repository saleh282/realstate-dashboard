import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { LruCache } from '../src/common/cache/lru-cache';
import { GovernoratesService } from '../src/governorates/governorates.service';
import { mediaRequirements } from '../src/properties/media-profiles';
import { PropertyFormDefinitionsController } from '../src/property-form-definitions/property-form-definitions.controller';
import { PropertyFormDefinitionsService } from '../src/property-form-definitions/property-form-definitions.service';
import {
  LEGACY_RESIDENTIAL_CONTENT,
  LEGACY_RESIDENTIAL_CONTENT_HASH,
  computeFormContentHash,
  computeLegacyWritable,
} from '../src/property-form-definitions/property-form-definition.constants';
import { PropertyFormDefinition } from '../src/property-form-definitions/schemas/property-form-definition.schema';
import { PropertyFormDefinitionVersion } from '../src/property-form-definitions/schemas/property-form-definition-version.schema';
import { PropertyFormOptionsController } from '../src/property-form-options/property-form-options.controller';
import { PropertyOptionsService } from '../src/property-options/property-options.service';
import { PropertyPurposeCategoriesService } from '../src/property-purpose-categories/property-purpose-categories.service';
import { PropertyTypesController } from '../src/property-types/property-types.controller';
import { PropertyTypesService } from '../src/property-types/property-types.service';

/** DPF-015 through the real HTTP pipeline (global pipes, envelope, filter) with the real definitions service. */
const id = (n: number) => `64d0000000000000000000${String(n).padStart(2, '0')}`;
const APARTMENT = id(1);
const LAND = id(2);
const ARCHIVED = id(3);
const NO_HEAD = id(4);
const DRAFT_ONLY = id(5);
const STALE_POINTER = id(6);

const dynamicContent = {
  rendererVersion: 1,
  mediaProfile: 'generic' as const,
  amenitiesEnabled: false,
  fields: [
    { key: 'landAreaSqm', dataType: 'decimal' as const, unit: 'sqm' as const, labelAr: 'مساحة الأرض', required: true, order: 20, validation: { min: 1, max: 1_000_000_000, scale: 2 } },
    { key: 'finishingStatus', dataType: 'singleSelect' as const, optionSource: 'catalog' as const, catalogGroup: 'finishing_status' as const, labelAr: 'حالة التشطيب', required: false, order: 10 },
  ],
};
const version = (n: number, definition: number, subcategory: string, state: string, content: any, extra: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(id(n)), definitionId: new Types.ObjectId(id(definition)), purposeSubcategoryId: new Types.ObjectId(subcategory), state,
  ...content, version: state === 'draft' ? undefined : 1, contentHash: state === 'draft' ? undefined : computeFormContentHash(content),
  legacyWritable: state === 'draft' ? undefined : computeLegacyWritable(content), draftRevision: 3, changeNote: 'internal note', publishedBy: new Types.ObjectId(), ...extra,
});
const versions = [
  version(11, 21, APARTMENT, 'published', LEGACY_RESIDENTIAL_CONTENT, { version: 2 }),
  version(12, 21, APARTMENT, 'superseded', LEGACY_RESIDENTIAL_CONTENT, { supersededAt: new Date() }),
  version(13, 22, LAND, 'published', dynamicContent),
  version(14, 23, ARCHIVED, 'published', LEGACY_RESIDENTIAL_CONTENT),
  version(15, 25, DRAFT_ONLY, 'draft', dynamicContent),
  version(16, 99, STALE_POINTER, 'published', LEGACY_RESIDENTIAL_CONTENT),
];
const head = (n: number, subcategory: string, status: string, currentVersionId?: string) => ({
  _id: new Types.ObjectId(id(n)), purposeSubcategoryId: new Types.ObjectId(subcategory), status, ...(currentVersionId ? { currentVersionId: new Types.ObjectId(currentVersionId), currentVersion: 1 } : {}),
});
const heads = [
  head(21, APARTMENT, 'active', id(11)),
  head(22, LAND, 'active', id(13)),
  head(23, ARCHIVED, 'archived', id(14)),
  head(25, DRAFT_ONLY, 'active'),
  // Points at a version owned by another definition: never advertised.
  head(26, STALE_POINTER, 'active', id(16)),
];
const types = [APARTMENT, LAND, ARCHIVED, NO_HEAD, DRAFT_ONLY, STALE_POINTER].map((typeId, index) => ({ id: typeId, code: `type_${index}`, purposeCategoryId: id(90) }));

const lean = <T>(value: T) => ({ lean: () => ({ exec: async () => value }) });
const versionModel = {
  findOne: jest.fn((filter: any) => lean(versions.find((entry) => String(entry._id) === String(filter._id) && filter.state.$in.includes(entry.state)) ?? null)),
  find: jest.fn((filter: any) => lean(versions.filter((entry) => filter._id.$in.map(String).includes(String(entry._id)) && entry.state === filter.state))),
};
const definitionModel = { find: jest.fn((filter: any) => lean(heads.filter((entry) => entry.status === filter.status && entry.currentVersionId))) };

describe('DPF-015 public form definition reads and old-client filtering', () => {
  let app: INestApplication;
  const server = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PropertyFormDefinitionsController, PropertyFormOptionsController, PropertyTypesController],
      providers: [
        PropertyFormDefinitionsService,
        { provide: getModelToken(PropertyFormDefinition.name), useValue: definitionModel },
        { provide: getModelToken(PropertyFormDefinitionVersion.name), useValue: versionModel },
        { provide: PropertyOptionsService, useValue: { listPublic: async () => ({ items: [{ group: 'finishing_status', code: 'unfinished' }, { group: 'delivery_status', code: 'immediate' }] }) } },
        { provide: GovernoratesService, useValue: { listPublic: async () => ({ items: [] }), listPublicCities: async () => ({ items: [] }) } },
        { provide: PropertyPurposeCategoriesService, useValue: { listPublic: async () => ({ items: [{ id: id(90) }] }) } },
        { provide: PropertyTypesService, useValue: { listPublicMapped: async () => ({ items: types }), listPublic: async () => ({ items: types }) } },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' });
    await app.init();
  });
  afterAll(() => app.close());

  describe('GET /property-form-definitions/versions/:versionId', () => {
    it('returns the immutable published version with ETag, immutable caching, rendererVersion and mediaRequirements', async () => {
      const res = await server().get(`/api/v1/property-form-definitions/versions/${id(11)}`).expect(200);
      expect(res.headers.etag).toBe(`"${LEGACY_RESIDENTIAL_CONTENT_HASH}"`);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.body).toEqual({
        success: true, message: 'تمت العملية بنجاح',
        data: {
          versionId: id(11), definitionId: id(21), purposeSubcategoryId: APARTMENT, version: 2, rendererVersion: 1,
          contentHash: LEGACY_RESIDENTIAL_CONTENT_HASH, amenitiesEnabled: true, fields: LEGACY_RESIDENTIAL_CONTENT.fields,
          mediaRequirements: mediaRequirements('residential_rooms'),
        },
      });
    });

    it('orders fields by `order`, exposes the catalog group and never leaks lifecycle metadata', async () => {
      const { body } = await server().get(`/api/v1/property-form-definitions/versions/${id(13)}`).expect(200);
      expect(body.data.fields.map((field: any) => field.key)).toEqual(['finishingStatus', 'landAreaSqm']);
      expect(body.data.fields[0]).toEqual({ key: 'finishingStatus', dataType: 'singleSelect', optionSource: 'catalog', catalogGroup: 'finishing_status', labelAr: 'حالة التشطيب', required: false, order: 10 });
      expect(body.data.mediaRequirements).toEqual({ profile: 'generic', minPhotos: 1, maxPhotos: 20, fixedSlots: [], repeatedSlots: [], additionalSlotPrefix: 'additional' });
      for (const hidden of ['state', 'draftRevision', 'changeNote', 'publishedBy', 'legacyWritable', 'supersededAt', 'mediaProfile']) expect(body.data).not.toHaveProperty(hidden);
    });

    it('answers a matching If-None-Match with 304 and no body', async () => {
      const res = await server().get(`/api/v1/property-form-definitions/versions/${id(11)}`).set('If-None-Match', `"${LEGACY_RESIDENTIAL_CONTENT_HASH}"`).expect(304);
      expect(res.text).toBe('');
      await server().get(`/api/v1/property-form-definitions/versions/${id(11)}`).set('If-None-Match', '"stale"').expect(200);
    });

    it('keeps superseded versions readable forever', async () => {
      const { body } = await server().get(`/api/v1/property-form-definitions/versions/${id(12)}`).expect(200);
      expect(body.data).toMatchObject({ versionId: id(12), contentHash: LEGACY_RESIDENTIAL_CONTENT_HASH });
    });

    it('treats drafts, unknown and malformed ids as the same 404', async () => {
      versionModel.findOne.mockClear();
      for (const versionId of [id(15), id(77), 'not-an-id', `${id(11)}0`]) {
        const res = await server().get(`/api/v1/property-form-definitions/versions/${versionId}`).expect(404);
        expect(res.body.code).toBe('FORM_DEFINITION_NOT_FOUND');
        // Express's own weak ETag may be present; the immutable content-hash caching never is.
        expect(res.headers.etag ?? '').toMatch(/^(W\/.*)?$/);
        expect(res.headers['cache-control'] ?? '').not.toContain('immutable');
      }
      expect(versionModel.findOne).toHaveBeenCalledTimes(2);
    });

    it('serves repeated reads from the in-process cache (case-insensitive id)', async () => {
      await server().get(`/api/v1/property-form-definitions/versions/${id(13)}`).expect(200);
      versionModel.findOne.mockClear();
      await server().get(`/api/v1/property-form-definitions/versions/${id(13)}`).expect(200);
      await server().get(`/api/v1/property-form-definitions/versions/${id(13).toUpperCase()}`).expect(200);
      expect(versionModel.findOne).not.toHaveBeenCalled();
    });

    it('exposes no write routes in this phase', async () => {
      await server().post('/api/v1/property-form-definitions/versions').send({}).expect(404);
      await server().patch(`/api/v1/property-form-definitions/versions/${id(11)}`).send({}).expect(404);
      await server().delete(`/api/v1/property-form-definitions/versions/${id(15)}`).expect(404);
    });
  });

  describe('old-client filtering (formSchema)', () => {
    it('shows an old client only legacy-writable active types, with no pointers', async () => {
      const { body } = await server().get('/api/v1/property-form-options').expect(200);
      expect(body.data.purposeSubcategories.map((type: any) => type.id)).toEqual([APARTMENT]);
      expect(body.data).not.toHaveProperty('formDefinitions');
      expect(body.data.limits).toEqual({ maxPropertyTypes: 4 });
      const types = await server().get('/api/v1/property-types').expect(200);
      expect(types.body.data.items.map((type: any) => type.id)).toEqual([APARTMENT]);
    });

    it('shows a formSchema=1 client every type plus pointers for active published definitions', async () => {
      const { body } = await server().get('/api/v1/property-form-options?formSchema=1').expect(200);
      expect(body.data.purposeSubcategories.map((type: any) => type.id)).toEqual(types.map((type) => type.id));
      expect(body.data.formDefinitions).toEqual([
        { purposeSubcategoryId: APARTMENT, definitionId: id(21), currentVersionId: id(11), currentVersion: 2, contentHash: LEGACY_RESIDENTIAL_CONTENT_HASH, rendererVersion: 1 },
        { purposeSubcategoryId: LAND, definitionId: id(22), currentVersionId: id(13), currentVersion: 1, contentHash: computeFormContentHash(dynamicContent), rendererVersion: 1 },
      ]);
      expect(body.data.limits).toEqual({ maxPropertyTypes: 4 });
      const types2 = await server().get('/api/v1/property-types?formSchema=1').expect(200);
      expect(types2.body.data.items).toHaveLength(types.length);
    });

    it('never exposes a type that needs the new renderer to an unknown formSchema value, and ignores other parameters as before', async () => {
      for (const query of ['formSchema=2', 'formSchema=true', 'formSchema=', '_=1700000000', 'lang=ar&formSchema=01']) {
        const { body } = await server().get(`/api/v1/property-form-options?${query}`).expect(200);
        expect(body.data.purposeSubcategories.map((type: any) => type.id)).toEqual([APARTMENT]);
        const types2 = await server().get(`/api/v1/property-types?${query}`).expect(200);
        expect(types2.body.data.items.map((type: any) => type.id)).toEqual([APARTMENT]);
      }
    });
  });
});

describe('LRU cache', () => {
  it('evicts the least recently used entry beyond capacity', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.has('b')).toBe(false);
    expect([cache.get('a'), cache.get('c'), cache.size]).toEqual([1, 3, 2]);
    expect(() => new LruCache(0)).toThrow(RangeError);
  });

  it('caps the version cache at the frozen 500 entries', async () => {
    const found = jest.fn((filter: any) => lean({ ...versions[0], _id: filter._id }));
    const service = new PropertyFormDefinitionsService({} as any, { findOne: found } as any);
    for (let index = 0; index < 501; index += 1) await service.getPublicVersion(new Types.ObjectId().toHexString());
    expect((service as any).versionCache.size).toBe(500);
  });
});
