'use strict';

const { Types } = require('mongoose');
const {
  legacyVersionDocument,
  registryDocument,
} = require('../../src/migrations/025-property-form-foundation');
const {
  LEGACY_PROPERTY_ATTRIBUTE_SEED,
} = require('../../src/domain/property-attributes/property-attribute.constants');
const {
  AdminPropertyFormDefinitionsService,
} = require('../../src/services/admin-property-form-definitions.service');
const {
  PropertyFormDefinitionsService,
} = require('../../src/services/property-form-definitions.service');
const { FakeFormMongo } = require('./fake-form-mongo');
const { IDS } = require('./property-world');
/**
 * DPF-030..032 world: the migration-026 state (legacy head + published v1 for
 * existing types), a type created afterwards with no head, the production
 * registry seed plus test-only registry entries covering every data type,
 * and the real Admin and public definition services over FakeFormMongo.
 */
const ACTORS = { superAdmin: '64e0000000000000000000a1', admin: '64e0000000000000000000a2' };
const UNMAPPED_TYPE = '64c0000000000000000000b1';
const NOW = new Date('2026-09-01T00:00:00Z');
const entry = (key, dataType, extra = {}) => ({
  key,
  dataType,
  labelAr: `حقل ${key}`,
  hardBounds: {},
  status: 'active',
  origin: 'system',
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});
/** Test-only registry entries (DPF-044 will seed real non-residential attributes). */
const FIXTURE_ATTRIBUTES = [
  entry('plotShape', 'singleSelect', {
    optionSource: 'inline',
    options: [
      { code: 'regular', labelAr: 'منتظم', status: 'active' },
      { code: 'irregular', labelAr: 'غير منتظم', status: 'active' },
      { code: 'corner', labelAr: 'ناصية', status: 'deprecated' },
    ],
  }),
  entry('irrigationTypes', 'multiSelect', {
    optionSource: 'inline',
    hardBounds: { maxItems: 3 },
    options: [
      { code: 'drip', labelAr: 'تنقيط', status: 'active' },
      { code: 'flood', labelAr: 'غمر', status: 'active' },
      { code: 'pivot', labelAr: 'محوري', status: 'active' },
    ],
  }),
  entry('hasWaterAccess', 'boolean'),
  entry('hasGarden', 'boolean'),
  entry('roadWidth', 'decimal', { unit: 'm', hardBounds: { min: 0.5, max: 1000, scale: 2 } }),
  entry('notes', 'text'),
  entry('description2', 'textarea', { hardBounds: { maxLength: 500 } }),
  entry('leaseTermYears', 'integer', { hardBounds: { min: 1, max: 99 } }),
  entry('handoverDate', 'date', { hardBounds: { minDate: '2000-01-01' } }),
  entry('oldFlag', 'boolean', { status: 'deprecated' }),
];
/** Admin input for a dynamic-only land form (generic photos, no amenities, a required non-legacy field). */
const landInput = (overrides = {}) => ({
  fields: [
    {
      key: 'plotShape',
      labelAr: 'شكل الأرض',
      required: true,
      order: 10,
      widget: 'chips',
      options: [
        { code: 'regular', labelAr: 'منتظم', order: 1 },
        { code: 'irregular', labelAr: 'غير منتظم', order: 2 },
      ],
    },
    { key: 'hasWaterAccess', labelAr: 'مصدر مياه', required: false, order: 30 },
    {
      key: 'roadWidth',
      labelAr: 'عرض الطريق',
      required: false,
      order: 40,
      validation: { min: 1, max: 100, scale: 1 },
    },
    {
      key: 'leaseTermYears',
      labelAr: 'مدة الإيجار',
      required: false,
      order: 60,
      operations: ['rent'],
      validation: { min: 1, max: 99 },
    },
  ],
  mediaProfile: 'generic',
  amenitiesEnabled: false,
  ...overrides,
});
/** The editable projection of stored fields, i.e. what an Admin UI would send back unchanged. */
function inputOf(fields) {
  return fields.map(({ dataType: _d, unit: _u, optionSource: _o, catalogGroup: _c, ...editable }) =>
    JSON.parse(JSON.stringify(editable)),
  );
}
/** Phase 11: a small amenity catalog fixture — mirrors the shape (not the exact codes) of the production baseline catalog, plus one inactive entry for allowedAmenityCodes tests. */
const FIXTURE_AMENITIES = [
  {
    code: 'elevator',
    nameAr: 'مصعد',
    nameEn: 'Elevator',
    iconKey: 'elevator',
    category: 'service',
    isActive: true,
    sortOrder: 1,
    usageCount: 0,
    createdBy: new Types.ObjectId(),
  },
  {
    code: 'parking',
    nameAr: 'موقف سيارات',
    nameEn: 'Parking',
    iconKey: 'parking',
    category: 'facility',
    isActive: true,
    sortOrder: 2,
    usageCount: 0,
    createdBy: new Types.ObjectId(),
  },
  {
    code: 'security',
    nameAr: 'أمن',
    nameEn: 'Security',
    iconKey: 'security',
    category: 'service',
    isActive: true,
    sortOrder: 3,
    usageCount: 0,
    createdBy: new Types.ObjectId(),
  },
  {
    code: 'retired_amenity',
    nameAr: 'ميزة متوقفة',
    nameEn: 'Retired',
    iconKey: 'other',
    category: 'feature',
    isActive: false,
    sortOrder: 4,
    usageCount: 0,
    createdBy: new Types.ObjectId(),
  },
];
function formAdminWorld(options = {}) {
  const mongo = new FakeFormMongo();
  const typeIds = options.typeIds ?? [IDS.apartment, IDS.villa];
  const withoutHead = options.withoutHead ?? [IDS.unreleased];
  const type = (id, code, extra = {}) => ({
    _id: new Types.ObjectId(id),
    code,
    nameAr: `نوع ${code}`,
    purposeCategoryId: new Types.ObjectId(IDS.purpose),
    isActive: true,
    sortOrder: 0,
    usageCount: 0,
    ...extra,
  });
  mongo.seed('types', [
    ...typeIds.map((id, index) => type(id, `type_${index}`)),
    ...withoutHead.map((id, index) => type(id, `new_${index}`)),
    type(UNMAPPED_TYPE, 'unmapped', { purposeCategoryId: undefined }),
  ]);
  mongo.seed('attributes', [
    ...LEGACY_PROPERTY_ATTRIBUTE_SEED.map((seed) => registryDocument(seed, NOW)),
    ...FIXTURE_ATTRIBUTES,
  ]);
  mongo.seed(
    'amenities',
    FIXTURE_AMENITIES.map((amenity) => ({ ...amenity, createdAt: NOW, updatedAt: NOW })),
  );
  const legacy = {};
  for (const typeId of typeIds) {
    const definitionId = new Types.ObjectId();
    const versionId = new Types.ObjectId();
    mongo.seed('definitions', [
      {
        _id: definitionId,
        purposeSubcategoryId: new Types.ObjectId(typeId),
        status: 'active',
        currentVersionId: versionId,
        currentVersion: 1,
        nextVersionNumber: 2,
        version: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    mongo.seed('versions', [
      legacyVersionDocument(versionId, definitionId, new Types.ObjectId(typeId), NOW),
    ]);
    legacy[typeId] = { definitionId, versionId };
  }
  const models = mongo.models();
  const service = new AdminPropertyFormDefinitionsService(
    models.definitions,
    models.versions,
    models.attributes,
    models.types,
    models.amenities,
    mongo.audit,
    mongo.connection,
  );
  const publicService = new PropertyFormDefinitionsService(models.definitions, models.versions);
  const actor = { userId: ACTORS.superAdmin, ip: '127.0.0.1' };
  return { mongo, service, publicService, legacy, actor };
}
const errorOf = async (promise) =>
  promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (error) => error,
  );
const bodyOf = async (promise) => {
  const error = await errorOf(promise);
  return { status: error.getStatus?.(), ...(error.getResponse?.() ?? { message: error.message }) };
};
/** Creates the head for the post-026 type, saves `input` into its draft and returns the definition id and draft revision. */
async function preparedDefinition(world, input = landInput(), typeId = IDS.unreleased) {
  const created = await world.service.createDefinition(
    { purposeSubcategoryId: typeId },
    world.actor,
  );
  const definitionId = created.definition.definitionId;
  const saved = await world.service.updateDraft(
    definitionId,
    { expectedDraftRevision: 0, ...input },
    world.actor,
  );
  return {
    definitionId,
    draftRevision: saved.draft.draftRevision,
    version: saved.definition.version,
  };
}

Object.assign(exports, {
  ACTORS,
  UNMAPPED_TYPE,
  FIXTURE_ATTRIBUTES,
  landInput,
  inputOf,
  FIXTURE_AMENITIES,
  formAdminWorld,
  errorOf,
  bodyOf,
  preparedDefinition,
});
