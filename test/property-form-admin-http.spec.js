'use strict';
const { httpApp } = require('./support/http-app');
require('reflect-metadata');
const { UnauthorizedException } = require('../src/common/http/errors');
const request = require('supertest');

const { SystemRole } = require('../src/domain/auth/roles.enum');
const { AuthorizationErrorCode } = require('../src/domain/authorization/authorization-error-codes');
const {
  AdminPropertyAttributesController,
} = require('../src/controllers/admin-property-attributes.controller');
const {
  AdminPropertyFormDefinitionsController,
} = require('../src/controllers/admin-property-form-definitions.controller');
const {
  AdminPropertyFormDefinitionsService,
} = require('../src/services/admin-property-form-definitions.service');
const {
  FormDraftErrorCode,
} = require('../src/domain/property-form-definitions/form-definition-drafts');
const {
  FormDefinitionErrorCode,
  LEGACY_RESIDENTIAL_CONTENT_HASH,
} = require('../src/domain/property-form-definitions/property-form-definition.constants');
const {
  PropertyFormDefinitionsController,
} = require('../src/controllers/property-form-definitions.controller');
const {
  PropertyFormDefinitionsService,
} = require('../src/services/property-form-definitions.service');
const { AccountStatus, AccountType, BrokerStatus } = require('../src/domain/users/identity.types');
const { ACTORS, formAdminWorld, inputOf, landInput } = require('./support/form-admin-world');
const { IDS } = require('./support/property-world');
/**
 * DPF-030..032 over HTTP: the real guards (JWT stand-in, RolesGuard,
 * CapabilityGuard), the global whitelist pipe, the response envelope and the
 * exception filter, with the real Admin service over FakeFormMongo.
 */
const PRINCIPALS = {
  user: {
    userId: '64e0000000000000000000b1',
    systemRole: SystemRole.USER,
    accountType: AccountType.USER,
  },
  broker: {
    userId: '64e0000000000000000000b2',
    systemRole: SystemRole.USER,
    accountType: AccountType.BROKER,
    brokerStatus: BrokerStatus.APPROVED,
  },
  company: {
    userId: '64e0000000000000000000b3',
    systemRole: SystemRole.USER,
    accountType: AccountType.COMPANY,
  },
  admin: { userId: ACTORS.admin, systemRole: SystemRole.ADMIN },
  'super-admin': { userId: ACTORS.superAdmin, systemRole: SystemRole.SUPER_ADMIN },
  'suspended-admin': {
    userId: ACTORS.admin,
    systemRole: SystemRole.ADMIN,
    accountStatus: AccountStatus.SUSPENDED,
  },
  'suspended-super-admin': {
    userId: ACTORS.superAdmin,
    systemRole: SystemRole.SUPER_ADMIN,
    accountStatus: AccountStatus.SUSPENDED,
  },
};
class TestJwtAuthGuard {
  canActivate(context) {
    const req = context.switchToHttp().getRequest();
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!PRINCIPALS[token]) throw new UnauthorizedException();
    req.user = { ...PRINCIPALS[token] };
    return true;
  }
}
describe('DPF-030..032 Admin form-definition HTTP API', () => {
  let app;
  let world;
  const base = '/api/v1/admin/property-form-definitions';
  const as = (who) => ({ Authorization: `Bearer ${who}` });
  const server = () => request(app.getHttpServer());
  const apartment = () => String(world.legacy[IDS.apartment].definitionId);
  beforeEach(async () => {
    world = formAdminWorld();
    const moduleRef = await (() => {
      const services = {};
      services.AdminPropertyFormDefinitionsService = world.service;
      services.PropertyFormDefinitionsService = world.publicService;
      return {
        services,
        app: httpApp(
          services,
          (app, services) => {
            app.use(
              '/api/v1/admin/property-form-definitions',
              require('../src/routes/admin-property-form-definitions.routes').createRouter(
                services,
              ),
            );
            app.use(
              '/api/v1/admin/property-attributes',
              require('../src/routes/admin-property-attributes.routes').createRouter(services),
            );
            app.use(
              '/api/v1/property-form-definitions',
              require('../src/routes/property-form-definitions.routes').createRouter(services),
            );
          },
          (req) =>
            new TestJwtAuthGuard().canActivate({ switchToHttp: () => ({ getRequest: () => req }) }),
        ),
      };
    })();
    app = moduleRef.app;

    await app.init();
  });
  afterEach(() => app.close());
  const routes = {
    options: { method: 'get', path: () => `${base}/options` },
    list: { method: 'get', path: () => base },
    registry: { method: 'get', path: () => '/api/v1/admin/property-attributes' },
    create: {
      method: 'post',
      path: () => base,
      body: () => ({ purposeSubcategoryId: IDS.unreleased }),
    },
    detail: { method: 'get', path: () => `${base}/${apartment()}` },
    version: {
      method: 'get',
      path: () => `${base}/${apartment()}/versions/${world.legacy[IDS.apartment].versionId}`,
    },
    openDraft: {
      method: 'post',
      path: () => `${base}/${apartment()}/draft`,
      body: () => ({ expectedVersion: 1 }),
    },
    saveDraft: {
      method: 'put',
      path: () => `${base}/${apartment()}/draft`,
      body: () => ({
        expectedDraftRevision: 0,
        fields: [],
        mediaProfile: 'generic',
        amenitiesEnabled: false,
      }),
    },
    discard: {
      method: 'post',
      path: () => `${base}/${apartment()}/draft/discard`,
      body: () => ({ expectedVersion: 1, expectedDraftRevision: 0 }),
    },
    validate: { method: 'post', path: () => `${base}/${apartment()}/draft/validate` },
    diff: { method: 'get', path: () => `${base}/${apartment()}/draft/diff` },
    publish: {
      method: 'post',
      path: () => `${base}/${apartment()}/publish`,
      body: () => ({ expectedVersion: 1, expectedDraftRevision: 0 }),
      publish: true,
    },
    archive: {
      method: 'post',
      path: () => `${base}/${apartment()}/archive`,
      body: () => ({ expectedVersion: 1, reason: 'مراجعة' }),
      publish: true,
    },
    restore: {
      method: 'post',
      path: () => `${base}/${apartment()}/restore`,
      body: () => ({ expectedVersion: 1 }),
      publish: true,
    },
  };
  const call = (route, headers = {}) => {
    const req = server()[route.method](route.path()).set(headers);
    return route.body ? req.send(route.body()) : req;
  };
  describe('authorization on every route', () => {
    it.each(Object.keys(routes))('%s: guest 401; user, broker and company 403', async (name) => {
      const route = routes[name];
      expect((await call(route)).status).toBe(401);
      for (const who of ['user', 'broker', 'company']) {
        const res = await call(route, as(who));
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ success: false, code: AuthorizationErrorCode.FORBIDDEN });
      }
    });
    it.each(Object.keys(routes))(
      '%s: a suspended Admin or SUPER_ADMIN is refused',
      async (name) => {
        for (const who of ['suspended-admin', 'suspended-super-admin']) {
          const res = await call(routes[name], as(who));
          expect(res.status).toBe(403);
          expect(res.body.code).toBe(AuthorizationErrorCode.ACCOUNT_SUSPENDED);
        }
      },
    );
    it.each(
      Object.entries(routes)
        .filter(([, route]) => route.publish)
        .map(([name]) => name),
    )('%s needs the publish capability: ADMIN 403 with no state change', async (name) => {
      const before = JSON.stringify({
        d: world.mongo.rows('definitions'),
        v: world.mongo.rows('versions'),
        a: world.mongo.rows('audit'),
      });
      const res = await call(routes[name], as('admin'));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(AuthorizationErrorCode.FORBIDDEN);
      expect(
        JSON.stringify({
          d: world.mongo.rows('definitions'),
          v: world.mongo.rows('versions'),
          a: world.mongo.rows('audit'),
        }),
      ).toBe(before);
    });
    it('lets ADMIN read, create definitions and prepare drafts, and SUPER_ADMIN publish, archive and restore', async () => {
      for (const name of ['options', 'list', 'registry', 'detail', 'version'])
        expect((await call(routes[name], as('admin'))).status).toBe(200);
      expect((await call(routes.create, as('admin'))).status).toBe(201);
      expect((await call(routes.openDraft, as('admin'))).status).toBe(201);
      const draft = (await call(routes.detail, as('admin'))).body.data.draft;
      const saved = await server()
        .put(`${base}/${apartment()}/draft`)
        .set(as('admin'))
        .send({
          expectedDraftRevision: 0,
          fields: [
            ...inputOf(draft.fields),
            { key: 'hasGarden', labelAr: 'حديقة', required: false, order: 100 },
          ],
          mediaProfile: 'residential_rooms',
          amenitiesEnabled: true,
        });
      expect(saved.status).toBe(200);
      expect((await call(routes.validate, as('admin'))).body.data).toMatchObject({
        valid: true,
        errors: [],
      });
      expect(
        (await call(routes.diff, as('admin'))).body.data.fieldsAdded.map((field) => field.key),
      ).toEqual(['hasGarden']);
      const published = await server()
        .post(`${base}/${apartment()}/publish`)
        .set(as('super-admin'))
        .send({ expectedVersion: 2, expectedDraftRevision: 1 });
      expect(published.status).toBe(200);
      expect(published.body).toMatchObject({
        success: true,
        data: {
          published: { version: 2, state: 'published' },
          definition: { currentVersion: 2, draftVersionId: null },
        },
      });
      const archived = await server()
        .post(`${base}/${apartment()}/archive`)
        .set(as('super-admin'))
        .send({ expectedVersion: 3, reason: 'مراجعة' });
      expect(archived.body.data.definition.status).toBe('archived');
      const restored = await server()
        .post(`${base}/${apartment()}/restore`)
        .set(as('super-admin'))
        .send({ expectedVersion: 4 });
      expect(restored.body.data.definition.status).toBe('active');
      expect(world.mongo.rows('audit').map((row) => [row.action, String(row.actorUserId)])).toEqual(
        [
          ['admin_form_definition_created', ACTORS.admin],
          ['admin_form_draft_created', ACTORS.admin],
          ['admin_form_draft_created', ACTORS.admin],
          ['admin_form_draft_updated', ACTORS.admin],
          ['admin_form_version_published', ACTORS.superAdmin],
          ['admin_form_definition_archived', ACTORS.superAdmin],
          ['admin_form_definition_restored', ACTORS.superAdmin],
        ],
      );
    });
  });
  describe('request validation', () => {
    const put = (field, extra = {}) =>
      server()
        .put(`${base}/${apartment()}/draft`)
        .set(as('admin'))
        .send({
          expectedDraftRevision: 0,
          fields: [{ key: 'hasGarden', labelAr: 'حديقة', required: false, order: 1, ...field }],
          mediaProfile: 'generic',
          amenitiesEnabled: false,
          ...extra,
        });
    beforeEach(async () => {
      await call(routes.openDraft, as('admin')).expect(201);
    });
    it.each([
      ['dataType', { dataType: 'integer' }],
      ['unit', { unit: 'sqm' }],
      ['optionSource', { optionSource: 'inline' }],
      ['catalogGroup', { catalogGroup: 'finishing_status' }],
      ['facet', { facet: true }],
      ['facetKey', { facetKey: 'bedrooms' }],
      ['indexed', { indexed: true }],
      ['searchable', { searchable: true }],
      ['filterable', { filterable: true }],
      ['regex', { regex: '^a$' }],
      ['pattern', { pattern: '^a$' }],
      ['visibleWhen', { visibleWhen: { field: 'x', equals: 1 } }],
      ['default', { default: true }],
      ['dbField', { dbField: 'custom_column' }],
      ['validation.regex', { validation: { regex: '.*' } }],
      ['options[].status', { options: [{ code: 'a', order: 1, status: 'active' }] }],
    ])(
      'rejects an attempt to send %s (identity, search flags and rules are not Admin-editable)',
      async (_name, field) => {
        const res = await put(field);
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(
          world.mongo.rows('audit').filter((row) => row.action === 'admin_form_draft_updated'),
        ).toHaveLength(0);
      },
    );
    it.each([
      ['form-level mediaSlots', { mediaSlots: [{ slotId: 'x' }] }],
      ['form-level rendererVersion', { rendererVersion: 2 }],
      ['an unknown media profile', { mediaProfile: 'custom' }],
      ['a missing concurrency token', { expectedDraftRevision: undefined }],
      ['a negative concurrency token', { expectedDraftRevision: -1 }],
    ])('rejects %s', async (_name, extra) => {
      expect((await put({}, extra)).status).toBe(400);
    });
    it('rejects create, archive and publish bodies that miss their tokens or reason', async () => {
      expect(
        (await server().post(base).set(as('admin')).send({ purposeSubcategoryId: 'nope' })).status,
      ).toBe(400);
      expect(
        (
          await server()
            .post(`${base}/${apartment()}/archive`)
            .set(as('super-admin'))
            .send({ expectedVersion: 2 })
        ).status,
      ).toBe(400);
      expect(
        (
          await server()
            .post(`${base}/${apartment()}/archive`)
            .set(as('super-admin'))
            .send({ expectedVersion: 2, reason: 'x'.repeat(501) })
        ).status,
      ).toBe(400);
      expect(
        (
          await server()
            .post(`${base}/${apartment()}/publish`)
            .set(as('super-admin'))
            .send({ expectedVersion: 2 })
        ).status,
      ).toBe(400);
      expect(
        (
          await server()
            .post(`${base}/${apartment()}/publish`)
            .set(as('super-admin'))
            .send({ expectedVersion: '2', expectedDraftRevision: 0 })
        ).status,
      ).toBe(400);
    });
    it('answers domain-invalid content with structured errors in the standard envelope', async () => {
      const res = await put({ widget: 'stepper' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        code: FormDefinitionErrorCode.DRAFT_INVALID,
        details: {
          errors: [
            {
              code: FormDraftErrorCode.WIDGET_UNSUPPORTED,
              fieldKey: 'hasGarden',
              property: 'widget',
              params: { allowed: [] },
            },
          ],
        },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/stack|mongo|E11000|ValidatorError/i);
    });
    it('answers a stale token with 409 and the stable conflict code', async () => {
      const res = await put({}, { expectedDraftRevision: 7 });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        success: false,
        code: FormDefinitionErrorCode.VERSION_CONFLICT,
        details: { token: 'expectedDraftRevision', current: 0 },
      });
    });
  });
  describe('public contract', () => {
    it('keeps the public definition API read-only: no mutation route exists', async () => {
      const versionId = String(world.legacy[IDS.apartment].versionId);
      for (const [method, path] of [
        ['post', '/api/v1/property-form-definitions'],
        ['post', `/api/v1/property-form-definitions/versions/${versionId}`],
        ['put', `/api/v1/property-form-definitions/versions/${versionId}`],
        ['patch', `/api/v1/property-form-definitions/versions/${versionId}`],
        ['delete', `/api/v1/property-form-definitions/versions/${versionId}`],
        ['post', `/api/v1/property-form-definitions/${apartment()}/publish`],
        ['post', '/api/v1/property-attributes'],
        ['patch', '/api/v1/admin/property-attributes/bedrooms'],
        ['delete', `${base}/${apartment()}`],
        ['patch', `${base}/${apartment()}/versions/${versionId}`],
        ['delete', `${base}/${apartment()}/versions/${versionId}`],
      ]) {
        expect((await server()[method](path).set(as('super-admin')).send({})).status).toBe(404);
      }
      const res = await server()
        .get(`/api/v1/property-form-definitions/versions/${versionId}`)
        .expect(200);
      expect(res.body.data).toMatchObject({
        versionId,
        version: 1,
        contentHash: LEGACY_RESIDENTIAL_CONTENT_HASH,
      });
    });
    it('never serves a draft publicly, while Admin can read it', async () => {
      await call(routes.openDraft, as('admin')).expect(201);
      const draftId = (await call(routes.detail, as('admin'))).body.data.draft.versionId;
      const res = await server().get(`/api/v1/property-form-definitions/versions/${draftId}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(FormDefinitionErrorCode.NOT_FOUND);
      const admin = await server()
        .get(`${base}/${apartment()}/versions/${draftId}`)
        .set(as('admin'))
        .expect(200);
      expect(admin.body.data.version.state).toBe('draft');
    });
    it('serves the newly published version publicly right after a publish', async () => {
      const created = await server()
        .post(base)
        .set(as('admin'))
        .send({ purposeSubcategoryId: IDS.unreleased })
        .expect(201);
      const id = created.body.data.definition.definitionId;
      await server()
        .put(`${base}/${id}/draft`)
        .set(as('admin'))
        .send({ expectedDraftRevision: 0, ...landInput() })
        .expect(200);
      const published = await server()
        .post(`${base}/${id}/publish`)
        .set(as('super-admin'))
        .send({ expectedVersion: 0, expectedDraftRevision: 1 })
        .expect(200);
      const versionId = published.body.data.published.versionId;
      const res = await server()
        .get(`/api/v1/property-form-definitions/versions/${versionId}`)
        .expect(200);
      expect(res.body.data).toMatchObject({
        versionId,
        version: 1,
        purposeSubcategoryId: IDS.unreleased,
        amenitiesEnabled: false,
        mediaRequirements: { profile: 'generic' },
      });
      expect(res.headers.etag).toBe(`"${published.body.data.published.contentHash}"`);
    });
  });
});
/** A never-opened Mongoose connection: the real module graph resolves without touching any database. */
class FakeMongooseCoreModule {}
it('resolves the real module graph: PropertyTypesModule -> PropertyFormDefinitionsModule with the Admin service and controllers', async () => {
  const mongoose = require('mongoose');
  const connection = mongoose.createConnection();
  const models = require('../src/models').createModels(connection);
  const services = require('../src/config/services').createServices(connection, models, {
    NODE_ENV: 'test',
    GEOCODING_PROVIDER: 'disabled',
  });
  expect(services.AdminPropertyFormDefinitionsService).toBeInstanceOf(
    AdminPropertyFormDefinitionsService,
  );
  expect(services.PropertyFormDefinitionsService).toBeInstanceOf(PropertyFormDefinitionsService);
  await connection.destroy();
});
