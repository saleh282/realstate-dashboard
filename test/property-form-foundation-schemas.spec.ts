import 'reflect-metadata';
import { Mongoose, Types } from 'mongoose';
import { PropertyErrorCode } from '../src/common/errors/property-error-codes';
import { MAX_PROPERTY_TYPES } from '../src/properties/property-classification';
import { Property, PropertySchema } from '../src/properties/schemas/property.schema';
import { PropertyRevision, PropertyRevisionSchema, revisionFormPinError } from '../src/properties/schemas/property-revision.schema';
import { LEGACY_PROPERTY_ATTRIBUTE_SEED } from '../src/property-attributes/property-attribute.constants';
import { PropertyAttribute, PropertyAttributeSchema } from '../src/property-attributes/schemas/property-attribute.schema';
import {
  CURRENT_RENDERER_VERSION,
  LEGACY_RESIDENTIAL_CONTENT,
  LEGACY_RESIDENTIAL_CONTENT_HASH,
  MEDIA_PROFILES,
  PROPERTY_FORM_LIMITS,
  computeFormContentHash,
  computeLegacyWritable,
} from '../src/property-form-definitions/property-form-definition.constants';
import { PropertyFormDefinition, PropertyFormDefinitionSchema } from '../src/property-form-definitions/schemas/property-form-definition.schema';
import { PropertyFormDefinitionVersion, PropertyFormDefinitionVersionSchema } from '../src/property-form-definitions/schemas/property-form-definition-version.schema';
import { registryDocument } from '../src/migrations/025-property-form-foundation';

/**
 * DPF-010 schema invariants. The real Mongoose middleware (validation, the
 * immutability hooks, query narrowing) runs through kareem exactly as a save
 * or update would, without a database.
 */
const mongoose = new Mongoose();
const Attribute = mongoose.model(PropertyAttribute.name, PropertyAttributeSchema);
const Definition = mongoose.model(PropertyFormDefinition.name, PropertyFormDefinitionSchema);
const Version = mongoose.model(PropertyFormDefinitionVersion.name, PropertyFormDefinitionVersionSchema);
const Revision = mongoose.model(PropertyRevision.name, PropertyRevisionSchema);
const PropertyModel = mongoose.model(Property.name, PropertySchema);

const runPre = (schema: any, hook: string, context: unknown) =>
  new Promise<void>((resolve, reject) => schema.s.hooks.execPre(hook, context, [], (error?: Error) => (error ? reject(error) : resolve())));
const save = (doc: any) => runPre(doc.schema, 'save', doc);
/** A completed save as Mongoose finishes it: post('save') hooks run and the document is no longer new. */
const completeSave = (doc: any) => new Promise<void>((resolve, reject) => doc.schema.s.hooks.execPost('save', doc, [doc], (error?: Error) => {
  if (error) return reject(error);
  doc.$isNew = false;
  resolve();
}));
/** Document middleware only, as Mongoose selects it for `doc.deleteOne()`. */
const runDocumentPre = (schema: any, hook: string, doc: unknown) =>
  new Promise<void>((resolve, reject) => schema.s.hooks.filter((entry: any) => entry.document === true).execPre(hook, doc, [], (error?: Error) => (error ? reject(error) : resolve())));
const indexNames = (schema: any) => schema.indexes().map(([key, options]: any) => ({ key, ...options }));

const stored = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(), ...registryDocument(LEGACY_PROPERTY_ATTRIBUTE_SEED[0], new Date('2026-01-01')), ...overrides,
});
const publishedVersion = (overrides: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(), definitionId: new Types.ObjectId(), purposeSubcategoryId: new Types.ObjectId(), version: 1, state: 'published',
  fields: LEGACY_RESIDENTIAL_CONTENT.fields.map((field) => ({ ...field })), mediaProfile: 'residential_rooms', amenitiesEnabled: true, draftRevision: 0,
  rendererVersion: 1, legacyWritable: true, contentHash: LEGACY_RESIDENTIAL_CONTENT_HASH, publishedAt: new Date('2026-01-01'), ...overrides,
});

describe('DPF-010 Attribute Registry schema', () => {
  it('accepts every legacy seed entry', async () => {
    for (const seed of LEGACY_PROPERTY_ATTRIBUTE_SEED) await expect(new Attribute(registryDocument(seed, new Date())).validate()).resolves.toBeUndefined();
    await expect(runPre(PropertyAttributeSchema, 'validate', new Attribute(registryDocument(LEGACY_PROPERTY_ATTRIBUTE_SEED[7], new Date())))).resolves.toBeUndefined();
  });

  it.each([
    ['a denylisted key', { key: 'constructor' }],
    ['a reserved first-class key', { key: 'area' }],
    ['a key outside the pattern', { key: 'Bedrooms' }],
    ['a unit on a select', { key: 'finishX', dataType: 'singleSelect', optionSource: 'catalog', catalogGroup: 'finishing_status', unit: 'sqm' }],
    ['a select without optionSource', { key: 'viewType', dataType: 'singleSelect' }],
    ['catalog options without a group', { key: 'viewType', dataType: 'singleSelect', optionSource: 'catalog' }],
    ['inline options with duplicate codes', { key: 'viewType', dataType: 'singleSelect', optionSource: 'inline', options: [{ code: 'sea', labelAr: 'x' }, { code: 'sea', labelAr: 'y' }] }],
    ['numeric bounds on text', { key: 'noteText', dataType: 'text', hardBounds: { min: 1 } }],
    ['text maxLength above 200', { key: 'noteText', dataType: 'text', hardBounds: { maxLength: 201 } }],
    ['a facet key that is not the attribute key', { key: 'livingRooms', facetKey: 'bedrooms' }],
  ])('rejects %s', async (_name, overrides) => {
    const doc = new Attribute({ ...registryDocument(LEGACY_PROPERTY_ATTRIBUTE_SEED[0], new Date()), facetKey: undefined, ...overrides });
    await expect(runPre(PropertyAttributeSchema, 'validate', doc)).rejects.toThrow(/PROPERTY_ATTRIBUTE_INVARIANT/);
  });

  it('never lets key, dataType or unit change on a stored entry', async () => {
    for (const [path, value] of [['key', 'rooms'], ['dataType', 'decimal'], ['unit', 'sqm']] as const) {
      const doc: any = Attribute.hydrate(stored());
      const attempt = async () => { doc[path] = value; await save(doc); };
      await expect(attempt()).rejects.toThrow();
      expect(doc[path] === value).toBe(false);
    }
  });

  it('allows active -> deprecated but never back, keeps options append-only and bounds widen-only', async () => {
    const deprecate: any = Attribute.hydrate(stored());
    deprecate.status = 'deprecated';
    await expect(save(deprecate)).resolves.toBeUndefined();
    const reactivate: any = Attribute.hydrate(stored({ status: 'deprecated' }));
    reactivate.status = 'active';
    await expect(save(reactivate)).rejects.toThrow(/cannot be reactivated/);

    const inline = (options: any[]) => stored({ key: 'viewType', dataType: 'singleSelect', optionSource: 'inline', options, facetKey: undefined, hardBounds: {} });
    const appended: any = Attribute.hydrate(inline([{ code: 'sea', labelAr: 'بحر', status: 'active' }]));
    appended.options.push({ code: 'garden', labelAr: 'حديقة', status: 'active' });
    await expect(save(appended)).resolves.toBeUndefined();
    const removed: any = Attribute.hydrate(inline([{ code: 'sea', labelAr: 'بحر', status: 'active' }, { code: 'garden', labelAr: 'حديقة', status: 'active' }]));
    removed.options = [{ code: 'sea', labelAr: 'بحر', status: 'active' }];
    await expect(save(removed)).rejects.toThrow(/cannot be removed/);

    const widened: any = Attribute.hydrate(stored());
    widened.hardBounds = { min: 0, max: 200 };
    await expect(save(widened)).resolves.toBeUndefined();
    const narrowed: any = Attribute.hydrate(stored());
    narrowed.hardBounds = { min: 1, max: 100 };
    await expect(save(narrowed)).rejects.toThrow(/may only widen/);
  });

  it('rejects query updates of engineering-owned paths, deletes and replaces; labels may change', async () => {
    for (const update of [{ $set: { dataType: 'decimal' } }, { $set: { 'hardBounds.max': 5 } }, { $push: { options: { code: 'x' } } }, { $unset: { unit: '' } }, { status: 'deprecated' }]) {
      await expect(runPre(PropertyAttributeSchema, 'updateOne', Attribute.updateOne({ key: 'bedrooms' }, update))).rejects.toThrow(/PROPERTY_ATTRIBUTE_INVARIANT/);
    }
    await expect(runPre(PropertyAttributeSchema, 'findOneAndUpdate', Attribute.findOneAndUpdate({ key: 'bedrooms' }, { $set: { labelAr: 'غرف' } }))).resolves.toBeUndefined();
    await expect(runPre(PropertyAttributeSchema, 'deleteOne', Attribute.deleteOne({ key: 'bedrooms' }))).rejects.toThrow(/never replaced or deleted/);
    await expect(runPre(PropertyAttributeSchema, 'replaceOne', Attribute.replaceOne({ key: 'bedrooms' }, {}))).rejects.toThrow(/never replaced or deleted/);
  });

  it('declares a unique key index', () => {
    expect(indexNames(PropertyAttributeSchema)).toEqual(expect.arrayContaining([expect.objectContaining({ key: { key: 1 }, unique: true })]));
  });
});

describe('DPF-010 FormDefinition head schema', () => {
  it('has one head per property type and forward-only counters', async () => {
    expect(indexNames(PropertyFormDefinitionSchema)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { purposeSubcategoryId: 1 }, unique: true, name: 'property_form_definition_subcategory_unique' }),
    ]));
    const head: any = Definition.hydrate({ _id: new Types.ObjectId(), purposeSubcategoryId: new Types.ObjectId(), status: 'active', nextVersionNumber: 3, version: 4 });
    head.nextVersionNumber = 2;
    await expect(save(head)).rejects.toThrow(/nextVersionNumber only increases/);
    await expect(runPre(PropertyFormDefinitionSchema, 'updateOne', Definition.updateOne({}, { $set: { purposeSubcategoryId: new Types.ObjectId() } }))).rejects.toThrow(/immutable/);
    await expect(runPre(PropertyFormDefinitionSchema, 'updateOne', Definition.updateOne({}, { $inc: { version: -1 } }))).rejects.toThrow(/only increases/);
    await expect(runPre(PropertyFormDefinitionSchema, 'updateOne', Definition.updateOne({}, { $set: { nextVersionNumber: 1 } }))).rejects.toThrow(/only through \$inc/);
    await expect(runPre(PropertyFormDefinitionSchema, 'updateOne', Definition.updateOne({}, { $inc: { version: 1, nextVersionNumber: 1 }, $set: { status: 'archived' } }))).resolves.toBeUndefined();
    await expect(runPre(PropertyFormDefinitionSchema, 'deleteMany', Definition.deleteMany({}))).rejects.toThrow(/never replaced or deleted/);
  });
});

describe('DPF-010 FormDefinitionVersion schema', () => {
  it('declares the frozen indexes', () => {
    expect(indexNames(PropertyFormDefinitionVersionSchema)).toEqual([
      { key: { definitionId: 1, version: 1 }, unique: true, partialFilterExpression: { version: { $exists: true } }, name: 'property_form_version_number_unique', background: true },
      { key: { definitionId: 1 }, unique: true, partialFilterExpression: { state: 'draft' }, name: 'property_form_version_one_draft', background: true },
      { key: { definitionId: 1 }, unique: true, partialFilterExpression: { state: 'published' }, name: 'property_form_version_one_published', background: true },
      { key: { purposeSubcategoryId: 1, state: 1 }, name: 'property_form_version_subcategory_state', background: true },
    ]);
  });

  it('makes a published version immutable except for superseding', async () => {
    const edited: any = Version.hydrate(publishedVersion());
    edited.fields[0].labelAr = 'غرف';
    await expect(save(edited)).rejects.toThrow(/published version is immutable/);
    const toggled: any = Version.hydrate(publishedVersion());
    toggled.amenitiesEnabled = false;
    await expect(save(toggled)).rejects.toThrow(/immutable/);
    const rehashed: any = Version.hydrate(publishedVersion());
    rehashed.contentHash = 'f'.repeat(64);
    await expect(save(rehashed)).rejects.toThrow(/immutable/);
    const superseded: any = Version.hydrate(publishedVersion());
    superseded.state = 'superseded';
    superseded.supersededAt = new Date();
    await expect(save(superseded)).resolves.toBeUndefined();
    const revived: any = Version.hydrate(publishedVersion({ state: 'superseded', supersededAt: new Date() }));
    revived.state = 'published';
    await expect(save(revived)).rejects.toThrow(/cannot move from superseded to published/);
    const skipped: any = Version.hydrate({ ...publishedVersion(), state: 'draft', version: undefined, contentHash: undefined, publishedAt: undefined, rendererVersion: undefined, legacyWritable: undefined });
    skipped.state = 'superseded';
    await expect(save(skipped)).rejects.toThrow(/PROPERTY_FORM_VERSION_INVARIANT/);
    const skippedWithMetadata: any = Version.hydrate({ ...publishedVersion(), state: 'draft' });
    skippedWithMetadata.state = 'superseded';
    await expect(save(skippedWithMetadata)).rejects.toThrow(/cannot move from draft to superseded/);
  });

  it('stays immutable after being created as published in this process (no reload in between)', async () => {
    const created: any = new Version(publishedVersion());
    await save(created);
    await completeSave(created);
    created.amenitiesEnabled = false;
    await expect(save(created)).rejects.toThrow(/published version is immutable/);
    const attribute: any = new Attribute(registryDocument(LEGACY_PROPERTY_ATTRIBUTE_SEED[0], new Date()));
    await completeSave(attribute);
    attribute.status = 'deprecated';
    await save(attribute);
    await completeSave(attribute);
    attribute.status = 'active';
    await expect(save(attribute)).rejects.toThrow(/cannot be reactivated/);
    const head: any = new Definition({ purposeSubcategoryId: new Types.ObjectId(), nextVersionNumber: 3, version: 2 });
    await completeSave(head);
    head.nextVersionNumber = 1;
    await expect(save(head)).rejects.toThrow(/nextVersionNumber only increases/);
  });

  it('lets a draft change freely', async () => {
    const draft: any = Version.hydrate({ _id: new Types.ObjectId(), definitionId: new Types.ObjectId(), purposeSubcategoryId: new Types.ObjectId(), state: 'draft', fields: [], mediaProfile: 'generic', amenitiesEnabled: false, draftRevision: 0 });
    draft.fields = LEGACY_RESIDENTIAL_CONTENT.fields.map((field) => ({ ...field }));
    draft.mediaProfile = 'residential_rooms';
    draft.draftRevision = 1;
    await expect(save(draft)).resolves.toBeUndefined();
  });

  it('narrows query writes to the only state they may touch', async () => {
    const contentEdit = Version.updateOne({ _id: new Types.ObjectId() }, { $set: { fields: [] } });
    await runPre(PropertyFormDefinitionVersionSchema, 'updateOne', contentEdit);
    expect(JSON.stringify(contentEdit.getFilter())).toContain('"state":"draft"');
    const publish = Version.findOneAndUpdate({ _id: new Types.ObjectId() }, { $set: { state: 'published', version: 2 } });
    await runPre(PropertyFormDefinitionVersionSchema, 'findOneAndUpdate', publish);
    expect(JSON.stringify(publish.getFilter())).toContain('"state":"draft"');
    const supersede = Version.updateOne({ state: 'published' }, { $set: { state: 'superseded', supersededAt: new Date() } });
    await runPre(PropertyFormDefinitionVersionSchema, 'updateOne', supersede);
    expect(JSON.stringify(supersede.getFilter())).toContain('"$and":[{"state":"published"}]');
    await expect(runPre(PropertyFormDefinitionVersionSchema, 'updateOne', Version.updateOne({}, { $set: { state: 'superseded', fields: [] } }))).rejects.toThrow(/superseding cannot change/);
    await expect(runPre(PropertyFormDefinitionVersionSchema, 'updateOne', Version.updateOne({}, { $set: { state: 'draft' } }))).rejects.toThrow(/cannot return to draft/);
    await expect(runPre(PropertyFormDefinitionVersionSchema, 'updateOne', Version.updateOne({}, { $set: { supersededAt: new Date() } }))).rejects.toThrow(/only when superseding/);
    await expect(runPre(PropertyFormDefinitionVersionSchema, 'replaceOne', Version.replaceOne({}, {}))).rejects.toThrow(/never replaced/);
    const discard = Version.deleteMany({ definitionId: new Types.ObjectId() });
    await runPre(PropertyFormDefinitionVersionSchema, 'deleteMany', discard);
    expect(JSON.stringify(discard.getFilter())).toContain('"state":"draft"');
    const published: any = Version.hydrate(publishedVersion());
    await expect(runDocumentPre(PropertyFormDefinitionVersionSchema, 'deleteOne', published)).rejects.toThrow(/only drafts can be discarded/);
    const draft: any = Version.hydrate({ ...publishedVersion(), state: 'draft' });
    await expect(runDocumentPre(PropertyFormDefinitionVersionSchema, 'deleteOne', draft)).resolves.toBeUndefined();
  });

  it('rejects reserved V1 field properties and unknown properties instead of dropping them', async () => {
    for (const reserved of ['visibleWhen', 'regex', 'facet', 'searchable', 'default', 'sectionKey']) {
      const version = new Version({ ...publishedVersion(), state: 'draft', fields: [{ ...LEGACY_RESIDENTIAL_CONTENT.fields[0], [reserved]: true }] });
      await expect(version.validate()).rejects.toThrow(/StrictModeError|strict mode/);
    }
    const nested = new Version({ ...publishedVersion(), state: 'draft', fields: [{ ...LEGACY_RESIDENTIAL_CONTENT.fields[0], validation: { min: 1, pattern: '.*' } }] });
    await expect(nested.validate()).rejects.toThrow(/StrictModeError|strict mode/);
  });

  it('enforces field uniqueness, publish metadata and the 64 KB document limit', async () => {
    const duplicate = new Version({ ...publishedVersion(), fields: [LEGACY_RESIDENTIAL_CONTENT.fields[0], { ...LEGACY_RESIDENTIAL_CONTENT.fields[1], key: 'bedrooms' }] });
    await expect(runPre(PropertyFormDefinitionVersionSchema, 'validate', duplicate)).rejects.toThrow(/keys must be unique/);
    const unhashed = new Version({ ...publishedVersion(), contentHash: undefined });
    await expect(runPre(PropertyFormDefinitionVersionSchema, 'validate', unhashed)).rejects.toThrow(/needs version, rendererVersion, legacyWritable, contentHash/);
    const huge = new Version({
      ...publishedVersion(), state: 'draft',
      fields: Array.from({ length: 60 }, (_, index) => ({ key: `field${index}`, dataType: 'singleSelect', optionSource: 'inline', labelAr: 'x', required: false, order: index, options: Array.from({ length: 100 }, (_, option) => ({ code: `option_${option}`, labelAr: 'ل'.repeat(40), order: option })) })),
    });
    await expect(runPre(PropertyFormDefinitionVersionSchema, 'validate', huge)).rejects.toThrow(/max 65536/);
  });

  it('stores a deterministic content hash: equal content, equal hash, whatever the key order', () => {
    expect(LEGACY_RESIDENTIAL_CONTENT_HASH).toMatch(/^[a-f0-9]{64}$/);
    const reordered = { amenitiesEnabled: true, mediaProfile: 'residential_rooms' as const, fields: LEGACY_RESIDENTIAL_CONTENT.fields.map((field) => Object.fromEntries(Object.entries(field).reverse()) as any), rendererVersion: CURRENT_RENDERER_VERSION };
    expect(computeFormContentHash(reordered)).toBe(LEGACY_RESIDENTIAL_CONTENT_HASH);
    expect(computeFormContentHash({ ...LEGACY_RESIDENTIAL_CONTENT, amenitiesEnabled: false })).not.toBe(LEGACY_RESIDENTIAL_CONTENT_HASH);
    expect(computeFormContentHash({ ...LEGACY_RESIDENTIAL_CONTENT, fields: [...LEGACY_RESIDENTIAL_CONTENT.fields].reverse() })).not.toBe(LEGACY_RESIDENTIAL_CONTENT_HASH);
  });

  it('computes legacyWritable exactly as frozen', () => {
    expect(computeLegacyWritable(LEGACY_RESIDENTIAL_CONTENT)).toBe(true);
    expect(computeLegacyWritable({ ...LEGACY_RESIDENTIAL_CONTENT, mediaProfile: 'generic' })).toBe(false);
    expect(computeLegacyWritable({ ...LEGACY_RESIDENTIAL_CONTENT, amenitiesEnabled: false })).toBe(false);
    expect(computeLegacyWritable({ ...LEGACY_RESIDENTIAL_CONTENT, fields: [...LEGACY_RESIDENTIAL_CONTENT.fields, { key: 'landAreaSqm', dataType: 'decimal', labelAr: 'x', required: true, order: 100 }] })).toBe(false);
    expect(computeLegacyWritable({ ...LEGACY_RESIDENTIAL_CONTENT, fields: [...LEGACY_RESIDENTIAL_CONTENT.fields, { key: 'landAreaSqm', dataType: 'decimal', labelAr: 'x', required: false, order: 100 }] })).toBe(true);
  });

  it('keeps the frozen media profile enum and limits', () => {
    expect(MEDIA_PROFILES).toEqual(['residential_rooms', 'land', 'commercial_unit', 'industrial', 'generic']);
    expect(MAX_PROPERTY_TYPES).toBe(4);
    expect(PROPERTY_FORM_LIMITS).toMatchObject({ maxFields: 60, maxVersionBytes: 65536, versionCacheSize: 500, maxPropertyTypes: 4 });
  });
});

describe('DPF-010 PropertyRevision and Property additions', () => {
  const baseRevision = {
    propertyId: new Types.ObjectId(), revisionNumber: 2, createdByActorId: new Types.ObjectId(), operationType: 'sale', title: 'عقار للبيع',
    description: 'وصف طويل بما يكفي للعقار', governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع', latitude: 30, longitude: 31, area: 120,
    totalPriceMinor: 100_000, coverImageIndex: 0,
  };
  const pin = { formDefinitionId: new Types.ObjectId(), formDefinitionVersionId: new Types.ObjectId(), formDefinitionVersion: 1, formContentHash: LEGACY_RESIDENTIAL_CONTENT_HASH };

  it('no longer requires the legacy spec fields', async () => {
    await expect(new Revision(baseRevision).validate()).resolves.toBeUndefined();
    await expect(new Revision({ ...baseRevision, ...pin, attributes: { bedrooms: 2 } }).validate()).resolves.toBeUndefined();
    const legacy = await new Revision({ ...baseRevision, bedrooms: 2, livingRooms: 1, kitchens: 1, bathrooms: 1, floor: 0, totalFloors: 3, buildingYear: 2000, finishingStatusCode: 'unfinished', deliveryStatusCode: 'immediate' }).validate();
    expect(legacy).toBeUndefined();
    await expect(new PropertyModel({ ownerId: new Types.ObjectId(), operationType: 'sale', propertyTypeCode: 'land', title: 't', description: 'd', governorateCode: 'giza', city: 'c', district: 'd', latitude: 1, longitude: 1, area: 500, totalPriceMinor: 1, images: [], coverImageIndex: 0 }).validate()).resolves.toBeUndefined();
  });

  it('keeps the form pin all-or-nothing, with attributes exactly when pinned', async () => {
    expect(revisionFormPinError({ ...pin, attributes: {} })).toBeNull();
    expect(revisionFormPinError({})).toBeNull();
    expect(revisionFormPinError({ formDefinitionVersionId: pin.formDefinitionVersionId, attributes: {} })).toMatch(/all present or all absent/);
    expect(revisionFormPinError({ ...pin })).toMatch(/exactly when the revision is pinned/);
    expect(revisionFormPinError({ attributes: { bedrooms: 1 } })).toMatch(/exactly when the revision is pinned/);
    expect(revisionFormPinError({ ...pin, attributes: [1] })).toMatch(/flat object/);
    await expect(runPre(PropertyRevisionSchema, 'validate', new Revision({ ...baseRevision, formDefinitionVersionId: pin.formDefinitionVersionId }))).rejects.toThrow(/PROPERTY_REVISION_FORM_PIN_INVALID/);
  });

  it('treats the pin and attributes as immutable outside draft', () => {
    for (const path of ['formDefinitionId', 'formDefinitionVersionId', 'formDefinitionVersion', 'formContentHash', 'attributes']) {
      expect(typeof (PropertyRevisionSchema.path(path) as any).options.immutable).toBe('function');
    }
  });

  it('types Property.facets: integer bedrooms 0-100 only, never arbitrary keys', async () => {
    const facets = PropertySchema.path('facets') as any;
    expect(Object.keys(facets.schema.paths)).toEqual(['bedrooms']);
    await expect(new PropertyModel({ facets: { bedrooms: 2, floorArea: 10 } }).validate(['facets'])).rejects.toThrow(/StrictModeError/);
    const invalid = new PropertyModel({ ownerId: new Types.ObjectId(), operationType: 'sale', propertyTypeCode: 'x', title: 't', description: 'd', governorateCode: 'g', city: 'c', district: 'd', latitude: 1, longitude: 1, area: 1, totalPriceMinor: 1, images: [], coverImageIndex: 0, facets: { bedrooms: 2.5 } });
    await expect(invalid.validate()).rejects.toThrow(/facets.bedrooms must be an integer/);
    const outOfRange = new PropertyModel({ ownerId: new Types.ObjectId(), operationType: 'sale', propertyTypeCode: 'x', title: 't', description: 'd', governorateCode: 'g', city: 'c', district: 'd', latitude: 1, longitude: 1, area: 1, totalPriceMinor: 1, images: [], coverImageIndex: 0, facets: { bedrooms: 101 } });
    await expect(outOfRange.validate()).rejects.toThrow();
  });

  it('adds the frozen DPF error codes', () => {
    expect(PropertyErrorCode).toMatchObject({
      ATTRIBUTES_MALFORMED: 'PROPERTY_ATTRIBUTES_MALFORMED', ATTRIBUTES_INVALID: 'PROPERTY_ATTRIBUTES_INVALID', FORM_VERSION_OUTDATED: 'PROPERTY_FORM_VERSION_OUTDATED',
      FORM_DEFINITION_INVALID: 'PROPERTY_FORM_DEFINITION_INVALID', FORM_DEFINITION_NOT_PUBLISHED: 'PROPERTY_FORM_DEFINITION_NOT_PUBLISHED',
      FORM_DEFINITION_ARCHIVED: 'PROPERTY_FORM_DEFINITION_ARCHIVED', CLIENT_UPGRADE_REQUIRED: 'PROPERTY_CLIENT_UPGRADE_REQUIRED',
      AMENITIES_NOT_ENABLED: 'PROPERTY_AMENITIES_NOT_ENABLED', SUBCATEGORIES_INVALID: 'PROPERTY_SUBCATEGORIES_INVALID', LEGACY_INPUT_NOT_ACCEPTED: 'PROPERTY_LEGACY_INPUT_NOT_ACCEPTED',
    });
  });
});
