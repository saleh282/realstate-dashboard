import 'reflect-metadata';
import { Types } from 'mongoose';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';
import { PropertyErrorCode } from '../src/common/errors/property-error-codes';
import { FormDraftErrorCode } from '../src/property-form-definitions/form-definition-drafts';
import {
  FormDefinitionErrorCode,
  LEGACY_RESIDENTIAL_CONTENT_HASH,
  computeFormContentHash,
  computeLegacyWritable,
} from '../src/property-form-definitions/property-form-definition.constants';
import { creatableTypesForClient } from '../src/property-form-definitions/creatable-types';
import { clone, writeConflict } from './support/fake-form-mongo';
import { ACTORS, UNMAPPED_TYPE, bodyOf, errorOf, formAdminWorld, inputOf, landInput, preparedDefinition, type FormAdminWorld } from './support/form-admin-world';
import { IDS, PropertyWorld, dynamicPayload, legacyPayload, photos } from './support/property-world';

/**
 * DPF-030..032 through the real Admin service over a transactional MongoDB
 * model: definition creation for a post-026 type, the one-draft lifecycle,
 * optimistic concurrency, validation, diff, atomic publish (rollback, retry,
 * races), archive/restore, audit, and what the public reads and Phase-4
 * property writes see afterwards.
 */

const legacyDraft = async (world: FormAdminWorld, typeId: string = IDS.apartment) => {
  const { definitionId } = world.legacy[typeId];
  const opened = await world.service.createDraft(String(definitionId), { expectedVersion: 1 }, world.actor);
  return { definitionId: String(definitionId), opened };
};
const save = (world: FormAdminWorld, definitionId: string, expectedDraftRevision: number, input: any) =>
  world.service.updateDraft(definitionId, { expectedDraftRevision, ...input }, world.actor);
const audits = (world: FormAdminWorld, action?: AuditAction) => world.mongo.rows('audit').filter((row) => !action || row.action === action);

describe('DPF-030 definitions: reads and creation for a new property type', () => {
  it('lists every type with its definition state, including a post-026 type with no head', async () => {
    const world = formAdminWorld();
    const { items } = await world.service.listDefinitions();
    const byType = new Map(items.map((item) => [item.purposeSubcategoryId, item]));
    expect(byType.get(IDS.apartment)!.definition).toMatchObject({ status: 'active', currentVersion: 1, version: 1, draftVersionId: null, currentContentHash: LEGACY_RESIDENTIAL_CONTENT_HASH, currentLegacyWritable: true });
    expect(byType.get(IDS.unreleased)!.definition).toBeNull();
    expect(byType.get(IDS.unreleased)!.type).toMatchObject({ id: IDS.unreleased, isActive: true });
  });

  it('reads the registry read-only with identity, hard bounds and option statuses', async () => {
    const world = formAdminWorld();
    const { items } = await world.service.listAttributes();
    expect(items.map((item) => item.key)).toEqual([...items.map((item) => item.key)].sort());
    expect(items.find((item) => item.key === 'bedrooms')).toMatchObject({ dataType: 'integer', hardBounds: { min: 0, max: 100 }, facetKey: 'bedrooms', origin: 'system', status: 'active' });
    expect(items.find((item) => item.key === 'plotShape')!.options).toContainEqual({ code: 'corner', labelAr: 'ناصية', labelEn: null, status: 'deprecated' });
    expect(Object.keys(world.service)).not.toContain('updateAttribute');
  });

  it('creates a head and an empty draft for an eligible type, never publishing or inventing fields', async () => {
    const world = formAdminWorld();
    const created = await world.service.createDefinition({ purposeSubcategoryId: IDS.unreleased }, world.actor);
    expect(created.definition).toMatchObject({ purposeSubcategoryId: IDS.unreleased, status: 'active', version: 0, currentVersionId: null, currentVersion: null, nextVersionNumber: 1 });
    expect(created.draft).toMatchObject({ state: 'draft', fields: [], mediaProfile: 'generic', amenitiesEnabled: false, draftRevision: 0, basedOnVersionId: null, version: null, contentHash: null });
    expect(created.current).toBeNull();
    expect(world.mongo.rows('versions').filter((version) => String(version.purposeSubcategoryId) === IDS.unreleased)).toHaveLength(1);
    // Still hidden from every client: no published version, so no creation pointer.
    const pointers = await world.publicService.creationPointers();
    expect(pointers.has(IDS.unreleased)).toBe(false);
    expect(audits(world).map((row) => row.action)).toEqual([AuditAction.ADMIN_FORM_DEFINITION_CREATED, AuditAction.ADMIN_FORM_DRAFT_CREATED]);
    expect(audits(world)[0]).toMatchObject({ actorUserId: new Types.ObjectId(ACTORS.superAdmin), targetResourceId: created.definition.definitionId, metadata: { definitionId: created.definition.definitionId, purposeSubcategoryId: IDS.unreleased } });
  });

  it('refuses a type that already has a definition, an unknown type and a type with no purpose', async () => {
    const world = formAdminWorld();
    expect(await bodyOf(world.service.createDefinition({ purposeSubcategoryId: IDS.apartment }, world.actor))).toMatchObject({ status: 409, code: FormDefinitionErrorCode.EXISTS, details: { definitionId: String(world.legacy[IDS.apartment].definitionId) } });
    expect(await bodyOf(world.service.createDefinition({ purposeSubcategoryId: new Types.ObjectId().toHexString() }, world.actor))).toMatchObject({ status: 400, code: FormDefinitionErrorCode.TYPE_NOT_ELIGIBLE, details: { reason: 'TYPE_NOT_FOUND' } });
    expect(await bodyOf(world.service.createDefinition({ purposeSubcategoryId: UNMAPPED_TYPE }, world.actor))).toMatchObject({ status: 400, code: FormDefinitionErrorCode.TYPE_NOT_ELIGIBLE, details: { reason: 'TYPE_NOT_MAPPED' } });
    expect(world.mongo.rows('definitions')).toHaveLength(2);
    expect(audits(world)).toHaveLength(0);
  });

  it('converges two concurrent creations for one type on exactly one head (unique index backstop)', async () => {
    const world = formAdminWorld();
    const results = await Promise.allSettled([
      world.service.createDefinition({ purposeSubcategoryId: IDS.unreleased }, world.actor),
      world.service.createDefinition({ purposeSubcategoryId: IDS.unreleased }, world.actor),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.getResponse()).toMatchObject({ code: FormDefinitionErrorCode.EXISTS });
    expect(world.mongo.rows('definitions').filter((head) => String(head.purposeSubcategoryId) === IDS.unreleased)).toHaveLength(1);
    expect(world.mongo.rows('versions').filter((version) => String(version.purposeSubcategoryId) === IDS.unreleased)).toHaveLength(1);
  });

  it('retries a creation that lost the race after its read (duplicate key on the head index) and reports EXISTS', async () => {
    const world = formAdminWorld();
    let winner: Promise<unknown> | undefined;
    // The first creation reads "no head", then the second creation commits before the first inserts its head.
    world.mongo.gate = async (event) => {
      if (event.collection === 'definitions' && event.op === 'create' && !winner) {
        winner = world.service.createDefinition({ purposeSubcategoryId: IDS.unreleased }, world.actor);
        await winner;
      }
    };
    const loser = await bodyOf(world.service.createDefinition({ purposeSubcategoryId: IDS.unreleased }, world.actor));
    world.mongo.gate = undefined;
    expect(await winner).toBeTruthy();
    expect(loser).toMatchObject({ status: 409, code: FormDefinitionErrorCode.EXISTS });
    expect(world.mongo.aborts).toBeGreaterThanOrEqual(1);
    expect(world.mongo.rows('definitions').filter((head) => String(head.purposeSubcategoryId) === IDS.unreleased)).toHaveLength(1);
    expect(world.mongo.rows('versions').filter((version) => String(version.purposeSubcategoryId) === IDS.unreleased)).toHaveLength(1);
  });

  it('reads the definition detail, the current and draft versions, and 404s for unknown or malformed ids', async () => {
    const world = formAdminWorld();
    const { definitionId } = await legacyDraft(world);
    const detail = await world.service.getDefinition(definitionId);
    expect(detail.current).toMatchObject({ state: 'published', version: 1, contentHash: LEGACY_RESIDENTIAL_CONTENT_HASH, legacyWritable: true });
    expect(detail.draft).toMatchObject({ state: 'draft', basedOnVersionId: detail.current!.versionId, draftRevision: 0 });
    expect(detail.draft!.fields).toEqual(detail.current!.fields);
    expect(detail.history.map((entry) => entry.version)).toEqual([1]);
    expect((await world.service.getVersion(definitionId, detail.draft!.versionId)).version.state).toBe('draft');
    for (const call of [
      () => world.service.getDefinition('not-an-id'),
      () => world.service.getDefinition(new Types.ObjectId().toHexString()),
      () => world.service.getVersion(definitionId, new Types.ObjectId().toHexString()),
      // A version of another definition is not readable through this one.
      () => world.service.getVersion(definitionId, String(world.legacy[IDS.villa].versionId)),
    ]) expect(await bodyOf(call())).toMatchObject({ status: 404, code: FormDefinitionErrorCode.NOT_FOUND });
  });
});

describe('DPF-031 draft lifecycle', () => {
  it('opens one draft copied from the current version and refuses a second one', async () => {
    const world = formAdminWorld();
    const { definitionId, opened } = await legacyDraft(world);
    expect(opened.definition).toMatchObject({ version: 2, draftVersionId: opened.draft!.versionId });
    expect(await bodyOf(world.service.createDraft(definitionId, { expectedVersion: 2 }, world.actor))).toMatchObject({ status: 409, code: FormDefinitionErrorCode.DRAFT_EXISTS, details: { draftVersionId: opened.draft!.versionId } });
    expect(audits(world, AuditAction.ADMIN_FORM_DRAFT_CREATED)[0].metadata).toEqual({ definitionId, draftVersionId: opened.draft!.versionId, basedOnVersionId: String(world.legacy[IDS.apartment].versionId), basedOnVersion: 1 });
  });

  it('keeps one draft per definition through the partial unique index even when the application check is bypassed', async () => {
    const world = formAdminWorld();
    const { opened } = await legacyDraft(world);
    const models = world.mongo.models();
    const error = await errorOf(models.versions.create([{ definitionId: world.legacy[IDS.apartment].definitionId, purposeSubcategoryId: new Types.ObjectId(IDS.apartment), state: 'draft', fields: [], mediaProfile: 'generic', amenitiesEnabled: false, draftRevision: 0 }]));
    expect(error).toMatchObject({ code: 11000, message: expect.stringContaining('property_form_version_one_draft') });
    expect(world.mongo.rows('versions').filter((version) => version.state === 'draft')).toHaveLength(1);
    expect(opened.draft).toBeTruthy();
  });

  it('lets exactly one of two concurrent draft openings win', async () => {
    const world = formAdminWorld();
    const id = String(world.legacy[IDS.apartment].definitionId);
    const results = await Promise.allSettled([1, 2].map(() => world.service.createDraft(id, { expectedVersion: 1 }, world.actor)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const reason = (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.getResponse();
    expect([FormDefinitionErrorCode.VERSION_CONFLICT, FormDefinitionErrorCode.DRAFT_EXISTS]).toContain(reason.code);
    expect(world.mongo.rows('versions').filter((version) => version.state === 'draft')).toHaveLength(1);
  });

  it('saves every editable property category and bumps the draft revision', async () => {
    const world = formAdminWorld();
    const { definitionId } = await preparedDefinition(world);
    const saved = await save(world, definitionId, 1, {
      fields: [
        { key: 'plotShape', labelAr: '  شكل\u0007 الأرض  ', labelEn: 'Plot shape', helpAr: 'اختر الشكل', required: false, order: 5, widget: 'dropdown', operations: ['sale'], options: [{ code: 'irregular', order: 1 }, { code: 'regular', labelAr: 'منتظم تماماً', labelEn: 'Regular', order: 2 }] },
        { key: 'irrigationTypes', labelAr: 'طرق الري', required: false, order: 6, widget: 'chips', validation: { minItems: 1, maxItems: 2 }, options: [{ code: 'drip', order: 1 }, { code: 'pivot', order: 2 }] },
        { key: 'roadWidth', labelAr: 'عرض الطريق', required: true, order: 7, validation: { min: 2, max: 50, scale: 1 } },
        { key: 'notes', labelAr: 'ملاحظات', placeholderAr: 'اكتب', required: false, order: 8, validation: { minLength: 2, maxLength: 150 } },
        { key: 'description2', labelAr: 'وصف', required: false, order: 9, validation: { maxLength: 400 } },
        { key: 'handoverDate', labelAr: 'التسليم', required: false, order: 10, validation: { min: '2001-01-01', max: '2100-12-31' } },
        { key: 'leaseTermYears', labelAr: 'المدة', required: false, order: 11, widget: 'input', operations: ['rent', 'sale'], validation: { min: 1, max: 30 } },
      ],
      mediaProfile: 'generic',
      amenitiesEnabled: true,
      changeNote: 'تعديل',
    });
    const draft = saved.draft!;
    expect(draft.draftRevision).toBe(2);
    expect(draft.amenitiesEnabled).toBe(true);
    expect(draft.changeNote).toBe('تعديل');
    expect(draft.fields.map((field) => field.key)).toEqual(['plotShape', 'irrigationTypes', 'roadWidth', 'notes', 'description2', 'handoverDate', 'leaseTermYears']);
    const [plot, irrigation, road, notes, , date, lease] = draft.fields;
    // Identity from the registry; labels sanitized; option labels default to the registry's; options ordered.
    expect(plot).toEqual({
      key: 'plotShape', dataType: 'singleSelect', optionSource: 'inline', labelAr: 'شكل الأرض', labelEn: 'Plot shape', helpAr: 'اختر الشكل', required: false, order: 5,
      operations: ['sale'], options: [{ code: 'irregular', labelAr: 'غير منتظم', order: 1 }, { code: 'regular', labelAr: 'منتظم تماماً', labelEn: 'Regular', order: 2 }], widget: 'dropdown',
    });
    expect(irrigation.validation).toEqual({ minItems: 1, maxItems: 2 });
    expect(road).toMatchObject({ dataType: 'decimal', unit: 'm', required: true, validation: { min: 2, max: 50, scale: 1 } });
    expect(notes.validation).toEqual({ minLength: 2, maxLength: 150 });
    expect(date.validation).toEqual({ min: '2001-01-01', max: '2100-12-31' });
    // Listing every operation is stored as "all operations" (absence).
    expect(lease).not.toHaveProperty('operations');
    expect(audits(world, AuditAction.ADMIN_FORM_DRAFT_UPDATED).at(-1)!.metadata).toMatchObject({ definitionId, draftRevision: 2, fieldCount: 7, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('switches the media profile and refuses a profile that has not shipped', async () => {
    const world = formAdminWorld();
    const { definitionId, opened } = await legacyDraft(world);
    const fields = inputOf(opened.draft!.fields);
    const generic = await save(world, definitionId, 0, { fields, mediaProfile: 'generic', amenitiesEnabled: true });
    expect(generic.draft!.mediaProfile).toBe('generic');
    expect(await bodyOf(save(world, definitionId, 1, { fields, mediaProfile: 'land', amenitiesEnabled: true }))).toMatchObject({
      status: 400, code: FormDefinitionErrorCode.DRAFT_INVALID, details: { errors: [{ code: FormDraftErrorCode.MEDIA_PROFILE_UNSUPPORTED, property: 'mediaProfile', params: { supported: ['residential_rooms', 'generic'] } }] },
    });
  });

  it('refuses invalid content with every structured error and saves nothing', async () => {
    const world = formAdminWorld();
    const { definitionId } = await preparedDefinition(world);
    const before = clone(world.mongo.rows('versions'));
    const response = await bodyOf(save(world, definitionId, 1, {
      fields: [
        { key: 'plotShape', labelAr: 'شكل', required: true, order: 1, widget: 'stepper', options: [{ code: 'regular', order: 1 }, { code: 'regular', order: 2 }, { code: 'corner', order: 3 }, { code: 'square', order: 4 }] },
        { key: 'leaseTermYears', labelAr: '', required: true, order: 1, validation: { min: 0, max: 120, minLength: 3 } },
        { key: 'unknownKey', labelAr: 'مجهول', required: false, order: 3 },
        { key: 'title', labelAr: 'عنوان', required: false, order: 4 },
        { key: 'oldFlag', labelAr: 'قديم', required: false, order: 5 },
        { key: 'roadWidth', labelAr: 'عرض', required: false, order: 6, validation: { min: 20, max: 10, scale: 3 } },
        { key: 'hasGarden', labelAr: 'حديقة', required: false, order: 7, options: [{ code: 'yes', order: 1 }], operations: ['lease'] },
        { key: 'hasGarden', labelAr: 'حديقة', required: false, order: 8 },
      ],
      mediaProfile: 'generic',
      amenitiesEnabled: false,
    }));
    expect(response).toMatchObject({ status: 400, code: FormDefinitionErrorCode.DRAFT_INVALID });
    expect(response.details.errors).toEqual([
      { code: FormDraftErrorCode.FIELD_KEY_DUPLICATE, fieldKey: 'hasGarden', property: 'key' },
      { code: FormDraftErrorCode.OPERATIONS_INVALID, fieldKey: 'hasGarden', property: 'operations', params: { allowed: ['sale', 'rent'] } },
      { code: FormDraftErrorCode.OPTIONS_NOT_ALLOWED, fieldKey: 'hasGarden', property: 'options' },
      { code: FormDraftErrorCode.LABEL_INVALID, fieldKey: 'leaseTermYears', property: 'labelAr', params: { maxLength: 80 } },
      { code: FormDraftErrorCode.FIELD_ORDER_DUPLICATE, fieldKey: 'leaseTermYears', property: 'order', params: { order: 1 } },
      { code: FormDraftErrorCode.BOUND_OUTSIDE_REGISTRY, fieldKey: 'leaseTermYears', property: 'validation.max', params: { max: 99 } },
      { code: FormDraftErrorCode.BOUND_OUTSIDE_REGISTRY, fieldKey: 'leaseTermYears', property: 'validation.min', params: { min: 1 } },
      { code: FormDraftErrorCode.VALIDATION_NOT_APPLICABLE, fieldKey: 'leaseTermYears', property: 'validation.minLength' },
      { code: FormDraftErrorCode.ATTRIBUTE_DEPRECATED, fieldKey: 'oldFlag', property: 'key' },
      { code: FormDraftErrorCode.OPTION_DEPRECATED, fieldKey: 'plotShape', property: 'options.corner' },
      { code: FormDraftErrorCode.OPTION_DUPLICATE, fieldKey: 'plotShape', property: 'options.regular' },
      // An unknown option has no registry label to fall back on either.
      { code: FormDraftErrorCode.OPTION_INVALID, fieldKey: 'plotShape', property: 'options.square' },
      { code: FormDraftErrorCode.OPTION_UNKNOWN, fieldKey: 'plotShape', property: 'options.square' },
      { code: FormDraftErrorCode.FIELD_ORDER_DUPLICATE, fieldKey: 'plotShape', property: 'order', params: { order: 1 } },
      { code: FormDraftErrorCode.WIDGET_UNSUPPORTED, fieldKey: 'plotShape', property: 'widget', params: { allowed: ['chips', 'dropdown'] } },
      { code: FormDraftErrorCode.BOUND_RANGE_INVALID, fieldKey: 'roadWidth', property: 'validation.min', params: { against: 'validation.max' } },
      { code: FormDraftErrorCode.BOUND_OUTSIDE_REGISTRY, fieldKey: 'roadWidth', property: 'validation.scale', params: { max: 2 } },
      { code: FormDraftErrorCode.ATTRIBUTE_KEY_RESERVED, fieldKey: 'title', property: 'key' },
      { code: FormDraftErrorCode.ATTRIBUTE_UNKNOWN, fieldKey: 'unknownKey', property: 'key' },
    ]);
    expect(world.mongo.rows('versions')).toEqual(before);
    expect(audits(world, AuditAction.ADMIN_FORM_DRAFT_UPDATED)).toHaveLength(1);
  });

  it('saves an empty draft, but reports it unpublishable and refuses to publish it', async () => {
    const world = formAdminWorld();
    const created = await world.service.createDefinition({ purposeSubcategoryId: IDS.unreleased }, world.actor);
    const definitionId = created.definition.definitionId;
    const saved = await save(world, definitionId, 0, { fields: [], mediaProfile: 'generic', amenitiesEnabled: false, changeNote: 'بداية' });
    expect(saved.draft).toMatchObject({ fields: [], draftRevision: 1 });
    expect(await world.service.validateDraft(definitionId)).toMatchObject({ valid: false, errors: [{ code: FormDraftErrorCode.FIELDS_EMPTY, property: 'fields', params: { min: 1 } }] });
    const before = clone({ d: world.mongo.rows('definitions'), v: world.mongo.rows('versions'), a: world.mongo.rows('audit') });
    expect(await bodyOf(world.service.publish(definitionId, { expectedVersion: 0, expectedDraftRevision: 1 }, world.actor))).toMatchObject({
      status: 400, code: FormDefinitionErrorCode.PUBLISH_INVALID, details: { errors: [{ code: FormDraftErrorCode.FIELDS_EMPTY, property: 'fields', params: { min: 1 } }] },
    });
    expect(clone({ d: world.mongo.rows('definitions'), v: world.mongo.rows('versions'), a: world.mongo.rows('audit') })).toEqual(before);
    expect((await world.publicService.creationPointers()).has(IDS.unreleased)).toBe(false);
    // The initial empty draft (never saved) is refused the same way.
    const other = formAdminWorld();
    const fresh = await other.service.createDefinition({ purposeSubcategoryId: IDS.unreleased }, other.actor);
    expect(await bodyOf(other.service.publish(fresh.definition.definitionId, { expectedVersion: 0, expectedDraftRevision: 0 }, other.actor))).toMatchObject({ code: FormDefinitionErrorCode.PUBLISH_INVALID });
  });

  it('fails a stale draft save with a stable conflict instead of last-write-wins', async () => {
    const world = formAdminWorld();
    const { definitionId } = await preparedDefinition(world);
    await save(world, definitionId, 1, landInput({ amenitiesEnabled: true }));
    const stale = await bodyOf(save(world, definitionId, 1, landInput({ mediaProfile: 'generic' })));
    expect(stale).toMatchObject({ status: 409, code: FormDefinitionErrorCode.VERSION_CONFLICT, details: { token: 'expectedDraftRevision', current: 2 } });
    expect((await world.service.getDefinition(definitionId)).draft!.amenitiesEnabled).toBe(true);
  });

  it('lets exactly one of two concurrent saves with the same revision win', async () => {
    const world = formAdminWorld();
    const { definitionId } = await preparedDefinition(world);
    const results = await Promise.allSettled([
      save(world, definitionId, 1, landInput({ amenitiesEnabled: true })),
      save(world, definitionId, 1, landInput({ amenitiesEnabled: false, fields: landInput().fields.slice(0, 1) })),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.getResponse().code).toBe(FormDefinitionErrorCode.VERSION_CONFLICT);
    expect((await world.service.getDefinition(definitionId)).draft!.draftRevision).toBe(2);
  });

  it('validates the stored draft without changing it', async () => {
    const world = formAdminWorld();
    const { definitionId } = await preparedDefinition(world);
    const before = clone(world.mongo.rows('versions'));
    const valid = await world.service.validateDraft(definitionId);
    expect(valid).toMatchObject({ valid: true, errors: [], draftRevision: 1, legacyWritable: false, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    // Registry drift after the save: the attribute is deprecated for new use.
    world.mongo.data.attributes.forEach((attribute) => { if (attribute.key === 'roadWidth') attribute.status = 'deprecated'; });
    const invalid = await world.service.validateDraft(definitionId);
    expect(invalid).toMatchObject({ valid: false, errors: [{ code: FormDraftErrorCode.ATTRIBUTE_DEPRECATED, fieldKey: 'roadWidth', property: 'key' }] });
    expect(world.mongo.rows('versions')).toEqual(before);
    expect(world.mongo.writes.filter((write) => write.collection === 'versions').length).toBe(2);
  });

  it('keeps a deprecated attribute or option a form already used, but never lets one be newly added', async () => {
    const world = formAdminWorld();
    const { definitionId, draftRevision } = await preparedDefinition(world);
    await world.service.publish(definitionId, { expectedVersion: 0, expectedDraftRevision: draftRevision }, world.actor);
    world.mongo.data.attributes.forEach((attribute) => {
      if (attribute.key === 'roadWidth') attribute.status = 'deprecated';
      if (attribute.key === 'plotShape') attribute.options[0].status = 'deprecated';
    });
    const opened = await world.service.createDraft(definitionId, { expectedVersion: 1 }, world.actor);
    const kept = await save(world, definitionId, 0, { fields: inputOf(opened.draft!.fields), mediaProfile: 'generic', amenitiesEnabled: true });
    expect(kept.draft!.draftRevision).toBe(1);
    expect(await bodyOf(save(world, definitionId, 1, { fields: [...inputOf(opened.draft!.fields), { key: 'oldFlag', labelAr: 'قديم', required: false, order: 90 }], mediaProfile: 'generic', amenitiesEnabled: true })))
      .toMatchObject({ details: { errors: [{ code: FormDraftErrorCode.ATTRIBUTE_DEPRECATED, fieldKey: 'oldFlag' }] } });
  });

  it('discards the draft under both tokens, leaving published history intact', async () => {
    const world = formAdminWorld();
    const { definitionId, opened } = await legacyDraft(world);
    expect(await bodyOf(world.service.discardDraft(definitionId, { expectedVersion: 1, expectedDraftRevision: 0 }, world.actor))).toMatchObject({ status: 409, details: { token: 'expectedVersion' } });
    const discarded = await world.service.discardDraft(definitionId, { expectedVersion: 2, expectedDraftRevision: 0 }, world.actor);
    expect(discarded.draft).toBeNull();
    expect(discarded.definition).toMatchObject({ draftVersionId: null, version: 3, currentVersion: 1 });
    expect(world.mongo.get('versions', opened.draft!.versionId)).toBeUndefined();
    expect(world.mongo.get('versions', world.legacy[IDS.apartment].versionId)).toMatchObject({ state: 'published' });
    expect(await bodyOf(world.service.validateDraft(definitionId))).toMatchObject({ status: 404, code: FormDefinitionErrorCode.DRAFT_NOT_FOUND });
    expect(audits(world, AuditAction.ADMIN_FORM_DRAFT_DISCARDED)).toHaveLength(1);
  });
});

describe('DPF-032 diff', () => {
  const diffAfter = async (edit: (fields: any[]) => any[], extra: Record<string, unknown> = {}) => {
    const world = formAdminWorld();
    const { definitionId, opened } = await legacyDraft(world);
    await save(world, definitionId, 0, { fields: edit(inputOf(opened.draft!.fields)), mediaProfile: 'residential_rooms', amenitiesEnabled: true, ...extra });
    return world.service.diffDraft(definitionId);
  };

  it('reports no changes for an untouched draft, including one re-sent with reordered keys and fields', async () => {
    const untouched = await diffAfter((fields) => fields);
    expect(untouched).toMatchObject({ hasChanges: false, form: [], fieldsAdded: [], fieldsRemoved: [], fieldsChanged: [], draftContentHash: LEGACY_RESIDENTIAL_CONTENT_HASH, base: { version: 1, contentHash: LEGACY_RESIDENTIAL_CONTENT_HASH } });
    const reordered = await diffAfter((fields) => fields.reverse().map((field) => Object.fromEntries(Object.entries(field).reverse().map(([key, value]) => [key, value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value]))));
    expect(reordered.hasChanges).toBe(false);
    expect(reordered.draftContentHash).toBe(LEGACY_RESIDENTIAL_CONTENT_HASH);
  });

  it('reports field additions/removals and per-property changes in a fixed order', async () => {
    const diff = await diffAfter((fields) => [
      ...fields.filter((field) => field.key !== 'kitchens').map((field) => {
        if (field.key === 'bedrooms') return { ...field, labelAr: 'عدد الغرف', required: false, order: 15, validation: { min: 0, max: 20 }, widget: 'input' };
        if (field.key === 'floor') return { ...field, operations: ['sale'] };
        return field;
      }),
      { key: 'hasGarden', labelAr: 'حديقة', required: false, order: 100 },
    ], { mediaProfile: 'generic', amenitiesEnabled: false });
    expect(diff.hasChanges).toBe(true);
    expect(diff.form).toEqual([
      { property: 'mediaProfile', before: 'residential_rooms', after: 'generic' },
      { property: 'amenitiesEnabled', before: true, after: false },
      { property: 'legacyWritable', before: true, after: false },
    ]);
    expect(diff.fieldsAdded).toEqual([{ key: 'hasGarden', dataType: 'boolean', labelAr: 'حديقة', required: false, order: 100 }]);
    expect(diff.fieldsRemoved.map((field) => field.key)).toEqual(['kitchens']);
    expect(diff.fieldsChanged).toEqual([
      { key: 'bedrooms', changes: [
        { property: 'labelAr', before: 'غرف النوم', after: 'عدد الغرف' },
        { property: 'order', before: 10, after: 15 },
        { property: 'required', before: true, after: false },
        { property: 'validation.max', before: 100, after: 20 },
        { property: 'validation.min', before: 1, after: 0 },
        { property: 'widget', before: 'stepper', after: 'input' },
      ] },
      { key: 'floor', changes: [{ property: 'operations', before: null, after: ['sale'] }] },
    ]);
  });

  it('reports option changes per option code', async () => {
    const world = formAdminWorld();
    const { definitionId, draftRevision } = await preparedDefinition(world);
    await world.service.publish(definitionId, { expectedVersion: 0, expectedDraftRevision: draftRevision }, world.actor);
    await world.service.createDraft(definitionId, { expectedVersion: 1 }, world.actor);
    const fields = landInput().fields.map((field) => (field.key === 'plotShape' ? { ...field, options: [{ code: 'regular', labelAr: 'مربع', order: 1 }] } : field));
    await save(world, definitionId, 0, landInput({ fields }));
    const diff = await world.service.diffDraft(definitionId);
    expect(diff.fieldsChanged).toEqual([{ key: 'plotShape', changes: [
      { property: 'options.irregular', before: { code: 'irregular', labelAr: 'غير منتظم', order: 2 }, after: null },
      { property: 'options.regular', before: { code: 'regular', labelAr: 'منتظم', order: 1 }, after: { code: 'regular', labelAr: 'مربع', order: 1 } },
    ] }]);
  });

  it('diffs a first draft against nothing', async () => {
    const world = formAdminWorld();
    const { definitionId } = await preparedDefinition(world);
    const diff = await world.service.diffDraft(definitionId);
    expect(diff.base).toBeNull();
    expect(diff.form.map((change) => change.property)).toEqual(['rendererVersion', 'mediaProfile', 'amenitiesEnabled', 'legacyWritable']);
    expect(diff.fieldsAdded.map((field) => field.key)).toEqual(['hasWaterAccess', 'leaseTermYears', 'plotShape', 'roadWidth']);
  });
});

describe('DPF-032 publish', () => {
  it('publishes the first version of a new type: immutable v1, head pointers moved, draft closed, audited in the transaction', async () => {
    const world = formAdminWorld();
    const { definitionId, draftRevision } = await preparedDefinition(world);
    const draftId = (await world.service.getDefinition(definitionId)).draft!.versionId;
    const result = await world.service.publish(definitionId, { expectedVersion: 0, expectedDraftRevision: draftRevision }, world.actor);
    expect(result.published).toMatchObject({ versionId: draftId, state: 'published', version: 1, legacyWritable: false, rendererVersion: 1 });
    expect(result.definition).toMatchObject({ currentVersionId: draftId, currentVersion: 1, nextVersionNumber: 2, draftVersionId: null, version: 1 });
    const stored = world.mongo.get('versions', draftId)!;
    expect(stored.contentHash).toBe(computeFormContentHash({ rendererVersion: 1, fields: stored.fields, mediaProfile: stored.mediaProfile, amenitiesEnabled: stored.amenitiesEnabled }));
    expect(stored).toMatchObject({ publishedBy: new Types.ObjectId(ACTORS.superAdmin), publishedAt: expect.any(Date) });
    const [audit] = audits(world, AuditAction.ADMIN_FORM_VERSION_PUBLISHED);
    expect(audit.metadata).toEqual({
      definitionId, purposeSubcategoryId: IDS.unreleased, versionId: draftId, version: 1, contentHash: stored.contentHash, legacyWritable: false, rendererVersion: 1,
      previousVersionId: null, previousVersion: null, fieldCount: 4, fieldsAdded: 4, fieldsRemoved: 0, fieldsChanged: 0,
    });
    // Bounded, non-sensitive metadata: ids, numbers and the hash, never the form content.
    expect(JSON.stringify(audit.metadata).length).toBeLessThan(700);
    expect(JSON.stringify(audit)).not.toContain('شكل الأرض');
  });

  it('publishes v2 over v1: v1 superseded with its content untouched, the head points at v2, both stay readable', async () => {
    const world = formAdminWorld();
    const { definitionId, opened } = await legacyDraft(world);
    const v1Before = clone(world.mongo.get('versions', world.legacy[IDS.apartment].versionId)!);
    await save(world, definitionId, 0, { fields: [...inputOf(opened.draft!.fields), { key: 'hasGarden', labelAr: 'حديقة', required: false, order: 100 }], mediaProfile: 'residential_rooms', amenitiesEnabled: true });
    const result = await world.service.publish(definitionId, { expectedVersion: 2, expectedDraftRevision: 1 }, world.actor);
    expect(result.published).toMatchObject({ version: 2, legacyWritable: true });
    const v1After = world.mongo.get('versions', world.legacy[IDS.apartment].versionId)!;
    expect(v1After.state).toBe('superseded');
    expect(v1After.supersededAt).toBeInstanceOf(Date);
    const { state: _s, supersededAt: _a, updatedAt: _u, ...v1Content } = v1After;
    const { state: _s0, updatedAt: _u0, ...v1ContentBefore } = v1Before;
    expect(v1Content).toEqual(v1ContentBefore);
    expect(result.definition).toMatchObject({ currentVersion: 2, currentVersionId: result.published.versionId, nextVersionNumber: 3, version: 3 });
    expect(result.history.map((entry) => [entry.version, entry.state])).toEqual([[2, 'published'], [1, 'superseded']]);

    const publicV2 = await world.publicService.getPublicVersion(result.published.versionId);
    expect(publicV2).toMatchObject({ version: 2, contentHash: result.published.contentHash });
    expect(publicV2.fields.map((field) => field.key)).toContain('hasGarden');
    const publicV1 = await world.publicService.getPublicVersion(String(world.legacy[IDS.apartment].versionId));
    expect(publicV1).toMatchObject({ version: 1, contentHash: LEGACY_RESIDENTIAL_CONTENT_HASH });
    expect((await world.publicService.creationPointers()).get(IDS.apartment)).toMatchObject({ currentVersion: 2, legacyWritable: true });
    expect(audits(world, AuditAction.ADMIN_FORM_VERSION_PUBLISHED)[0].metadata).toMatchObject({ version: 2, previousVersion: 1, previousVersionId: String(world.legacy[IDS.apartment].versionId), fieldsAdded: 1 });
  });

  it('hashes canonical content deterministically: the same form published for two types has one hash', async () => {
    const world = formAdminWorld({ withoutHead: [IDS.unreleased, IDS.land] });
    const first = await preparedDefinition(world, landInput(), IDS.unreleased);
    const reversed = landInput({ fields: [...landInput().fields].reverse() });
    const second = await preparedDefinition(world, reversed, IDS.land);
    const a = await world.service.publish(first.definitionId, { expectedVersion: 0, expectedDraftRevision: 1 }, world.actor);
    const b = await world.service.publish(second.definitionId, { expectedVersion: 0, expectedDraftRevision: 1 }, world.actor);
    expect(a.published.contentHash).toBe(b.published.contentHash);
    expect(a.current!.fields).toEqual(b.current!.fields);
  });

  it('refuses to publish an unchanged draft', async () => {
    const world = formAdminWorld();
    const { definitionId } = await legacyDraft(world);
    expect(await bodyOf(world.service.publish(definitionId, { expectedVersion: 2, expectedDraftRevision: 0 }, world.actor))).toMatchObject({ status: 409, code: FormDefinitionErrorCode.NO_CHANGES });
    expect(world.mongo.get('versions', world.legacy[IDS.apartment].versionId)!.state).toBe('published');
  });

  it('re-runs full validation at publish and refuses a draft made invalid by registry drift', async () => {
    const world = formAdminWorld();
    const { definitionId, draftRevision } = await preparedDefinition(world);
    world.mongo.data.attributes.forEach((attribute) => { if (attribute.key === 'plotShape') attribute.status = 'deprecated'; });
    expect(await bodyOf(world.service.publish(definitionId, { expectedVersion: 0, expectedDraftRevision: draftRevision }, world.actor))).toMatchObject({
      status: 400, code: FormDefinitionErrorCode.PUBLISH_INVALID, details: { errors: [{ code: FormDraftErrorCode.ATTRIBUTE_DEPRECATED, fieldKey: 'plotShape' }] },
    });
    expect((await world.service.getDefinition(definitionId)).draft).toMatchObject({ state: 'draft', draftRevision });
  });

  it('refuses stale head or draft tokens', async () => {
    const world = formAdminWorld();
    const { definitionId, draftRevision } = await preparedDefinition(world);
    expect(await bodyOf(world.service.publish(definitionId, { expectedVersion: 5, expectedDraftRevision: draftRevision }, world.actor))).toMatchObject({ status: 409, code: FormDefinitionErrorCode.VERSION_CONFLICT, details: { token: 'expectedVersion', current: 0 } });
    expect(await bodyOf(world.service.publish(definitionId, { expectedVersion: 0, expectedDraftRevision: draftRevision - 1 }, world.actor))).toMatchObject({ status: 409, code: FormDefinitionErrorCode.VERSION_CONFLICT, details: { token: 'expectedDraftRevision' } });
    expect(audits(world, AuditAction.ADMIN_FORM_VERSION_PUBLISHED)).toHaveLength(0);
  });

  it('refuses to publish while the definition is archived', async () => {
    const world = formAdminWorld();
    const { definitionId } = await legacyDraft(world);
    await world.service.archive(definitionId, { expectedVersion: 2, reason: 'مراجعة' }, world.actor);
    expect(await bodyOf(world.service.publish(definitionId, { expectedVersion: 3, expectedDraftRevision: 0 }, world.actor))).toMatchObject({ status: 409, code: FormDefinitionErrorCode.ARCHIVED });
  });

  describe('atomicity', () => {
    const stateOf = (world: FormAdminWorld) => clone({ definitions: world.mongo.rows('definitions'), versions: world.mongo.rows('versions'), audit: world.mongo.rows('audit') });
    const scenarios: Array<[string, (event: any) => boolean]> = [
      ['superseding the old version', (event) => event.collection === 'versions' && event.update?.$set?.state === 'superseded'],
      ['writing the new version', (event) => event.collection === 'versions' && event.update?.$set?.state === 'published'],
      ['updating the head', (event) => event.collection === 'definitions' && event.kind === 'update'],
      ['writing the audit record', (event) => event.collection === 'audit'],
    ];

    it.each(scenarios)('rolls back everything when %s fails, and a retry then publishes cleanly', async (_name, when) => {
      const world = formAdminWorld();
      const { definitionId, opened } = await legacyDraft(world);
      await save(world, definitionId, 0, { fields: [...inputOf(opened.draft!.fields), { key: 'hasGarden', labelAr: 'حديقة', required: false, order: 100 }], mediaProfile: 'residential_rooms', amenitiesEnabled: true });
      const before = stateOf(world);
      world.mongo.failWrite = (event) => (when(event) ? new Error('disk full') : undefined);
      const error = await errorOf(world.service.publish(definitionId, { expectedVersion: 2, expectedDraftRevision: 1 }, world.actor));
      expect(error.message).toBe('disk full');
      expect(stateOf(world)).toEqual(before);
      expect(world.mongo.get('versions', world.legacy[IDS.apartment].versionId)!.state).toBe('published');
      expect((await world.publicService.creationPointers()).get(IDS.apartment)!.currentVersion).toBe(1);
      // The draft is still there and still publishable with the same tokens.
      world.mongo.failWrite = undefined;
      const retried = await world.service.publish(definitionId, { expectedVersion: 2, expectedDraftRevision: 1 }, world.actor);
      expect(retried.published.version).toBe(2);
      expect(audits(world, AuditAction.ADMIN_FORM_VERSION_PUBLISHED)).toHaveLength(1);
    });

    it('rolls back when the commit itself fails', async () => {
      const world = formAdminWorld();
      const { definitionId, draftRevision } = await preparedDefinition(world);
      const before = stateOf(world);
      world.mongo.failCommit = () => new Error('commit failed');
      await errorOf(world.service.publish(definitionId, { expectedVersion: 0, expectedDraftRevision: draftRevision }, world.actor));
      expect(stateOf(world)).toEqual(before);
    });

    it('retries a transient write conflict transparently and commits exactly once', async () => {
      const world = formAdminWorld();
      const { definitionId, draftRevision } = await preparedDefinition(world);
      let failures = 1;
      world.mongo.failWrite = (event) => (event.collection === 'definitions' && event.kind === 'update' && failures-- > 0 ? writeConflict() : undefined);
      const commitsBefore = world.mongo.commits;
      const result = await world.service.publish(definitionId, { expectedVersion: 0, expectedDraftRevision: draftRevision }, world.actor);
      expect(result.published.version).toBe(1);
      expect(world.mongo.commits - commitsBefore).toBe(1);
      expect(audits(world, AuditAction.ADMIN_FORM_VERSION_PUBLISHED)).toHaveLength(1);
    });

    it('converges two concurrent publishes of the same draft on one new version', async () => {
      const world = formAdminWorld();
      const { definitionId, opened } = await legacyDraft(world);
      await save(world, definitionId, 0, { fields: [...inputOf(opened.draft!.fields), { key: 'hasGarden', labelAr: 'حديقة', required: false, order: 100 }], mediaProfile: 'residential_rooms', amenitiesEnabled: true });
      // Hold both transactions after their reads so they decide from the same snapshot.
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      world.mongo.gate = async (event) => {
        if (event.transaction !== null && event.collection === 'versions' && event.op === 'updateOne' && arrived < 2) {
          arrived += 1;
          if (arrived === 2) release();
          await barrier;
        }
      };
      const results = await Promise.allSettled([1, 2].map(() => world.service.publish(definitionId, { expectedVersion: 2, expectedDraftRevision: 1 }, world.actor)));
      world.mongo.gate = undefined;
      expect(arrived).toBe(2);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.getResponse()).toMatchObject({ code: expect.stringMatching(/FORM_DEFINITION_(VERSION_CONFLICT|DRAFT_NOT_FOUND)/) });
      const versions = world.mongo.rows('versions').filter((version) => String(version.definitionId) === definitionId);
      expect(versions.map((version) => [version.version, version.state]).sort()).toEqual([[1, 'superseded'], [2, 'published']]);
      expect(world.mongo.get('definitions', definitionId)).toMatchObject({ currentVersion: 2, nextVersionNumber: 3 });
      expect(audits(world, AuditAction.ADMIN_FORM_VERSION_PUBLISHED)).toHaveLength(1);
    });

    it('serializes a draft save racing a publish: the loser gets a conflict, never a half-applied state', async () => {
      const world = formAdminWorld();
      const { definitionId, draftRevision } = await preparedDefinition(world);
      const results = await Promise.allSettled([
        world.service.publish(definitionId, { expectedVersion: 0, expectedDraftRevision: draftRevision }, world.actor),
        save(world, definitionId, draftRevision, landInput({ amenitiesEnabled: true })),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const head = world.mongo.get('definitions', definitionId)!;
      if (results[0].status === 'fulfilled') {
        expect(head.currentVersion).toBe(1);
        expect(world.mongo.get('versions', head.currentVersionId)!.amenitiesEnabled).toBe(false);
      } else {
        expect(head.currentVersionId).toBeUndefined();
        expect(world.mongo.get('versions', head.draftVersionId)!.amenitiesEnabled).toBe(true);
      }
    });
  });

  it('repeats every concurrency token in the guarded write itself (backstop beyond the in-transaction check)', async () => {
    const world = formAdminWorld();
    const { definitionId, opened } = await legacyDraft(world);
    await save(world, definitionId, 0, { fields: [...inputOf(opened.draft!.fields), { key: 'hasGarden', labelAr: 'حديقة', required: false, order: 100 }], mediaProfile: 'residential_rooms', amenitiesEnabled: true });
    await world.service.publish(definitionId, { expectedVersion: 2, expectedDraftRevision: 1 }, world.actor);
    await world.service.archive(definitionId, { expectedVersion: 3, reason: 'x' }, world.actor);
    await world.service.restore(definitionId, { expectedVersion: 4 }, world.actor);
    const headUpdates = world.mongo.writes.filter((write) => write.collection === 'definitions' && write.kind === 'update');
    expect(headUpdates.map((write) => write.filter!.version)).toEqual([1, 2, 3, 4]);
    const draftWrites = world.mongo.writes.filter((write) => write.collection === 'versions' && write.kind === 'update' && write.update?.$set?.state !== 'superseded');
    expect(draftWrites.map((write) => [write.filter!.state, write.filter!.draftRevision])).toEqual([['draft', 0], ['draft', 1]]);
  });

  it('never edits or deletes a published version through the draft paths or the model', async () => {
    const world = formAdminWorld();
    const { definitionId, draftRevision } = await preparedDefinition(world);
    const result = await world.service.publish(definitionId, { expectedVersion: 0, expectedDraftRevision: draftRevision }, world.actor);
    const published = clone(world.mongo.get('versions', result.published.versionId)!);
    expect(await bodyOf(save(world, definitionId, draftRevision + 1, landInput()))).toMatchObject({ status: 404, code: FormDefinitionErrorCode.DRAFT_NOT_FOUND });
    // Corrupt head pointing its draft pointer at the published version: still refused.
    world.mongo.data.definitions.get(definitionId.toLowerCase())!.draftVersionId = new Types.ObjectId(result.published.versionId);
    expect(await bodyOf(save(world, definitionId, draftRevision + 1, landInput()))).toMatchObject({ status: 409, code: FormDefinitionErrorCode.NOT_DRAFT });
    const models = world.mongo.models();
    expect(await models.versions.updateOne({ _id: new Types.ObjectId(result.published.versionId) }, { $set: { amenitiesEnabled: true } }).exec()).toMatchObject({ matchedCount: 0 });
    expect(await models.versions.deleteOne({ _id: new Types.ObjectId(result.published.versionId) }).exec()).toMatchObject({ deletedCount: 0 });
    expect(world.mongo.get('versions', result.published.versionId)).toEqual(published);
  });
});

describe('DPF-032 archive and restore', () => {
  it('archives without touching versions and restores without mutating them', async () => {
    const world = formAdminWorld();
    const definitionId = String(world.legacy[IDS.apartment].definitionId);
    const versionsBefore = clone(world.mongo.rows('versions'));
    const archived = await world.service.archive(definitionId, { expectedVersion: 1, reason: '  إيقاف مؤقت  ' }, world.actor);
    expect(archived.definition).toMatchObject({ status: 'archived', archivedReason: 'إيقاف مؤقت', archivedBy: ACTORS.superAdmin, version: 2, currentVersion: 1 });
    expect(world.mongo.rows('versions')).toEqual(versionsBefore);
    expect((await world.publicService.creationPointers()).has(IDS.apartment)).toBe(false);
    // History stays readable while archived.
    expect(await world.publicService.getPublicVersion(String(world.legacy[IDS.apartment].versionId))).toMatchObject({ version: 1 });
    expect(archived.history).toHaveLength(1);

    const restored = await world.service.restore(definitionId, { expectedVersion: 2 }, world.actor);
    expect(restored.definition).toMatchObject({ status: 'active', archivedAt: null, archivedBy: null, archivedReason: null, version: 3 });
    expect(world.mongo.rows('versions')).toEqual(versionsBefore);
    expect((await world.publicService.creationPointers()).get(IDS.apartment)).toMatchObject({ currentVersion: 1, legacyWritable: true });
    expect(audits(world).map((row) => [row.action, row.reason])).toEqual([
      [AuditAction.ADMIN_FORM_DEFINITION_ARCHIVED, 'إيقاف مؤقت'],
      [AuditAction.ADMIN_FORM_DEFINITION_RESTORED, 'restored property form definition'],
    ]);
  });

  it('refuses double archive, restoring an active definition, and stale tokens', async () => {
    const world = formAdminWorld();
    const definitionId = String(world.legacy[IDS.apartment].definitionId);
    expect(await bodyOf(world.service.restore(definitionId, { expectedVersion: 1 }, world.actor))).toMatchObject({ status: 409, code: FormDefinitionErrorCode.NOT_ARCHIVED });
    expect(await bodyOf(world.service.archive(definitionId, { expectedVersion: 0, reason: 'x' }, world.actor))).toMatchObject({ status: 409, code: FormDefinitionErrorCode.VERSION_CONFLICT, details: { token: 'expectedVersion', current: 1 } });
    await world.service.archive(definitionId, { expectedVersion: 1, reason: 'x' }, world.actor);
    expect(await bodyOf(world.service.archive(definitionId, { expectedVersion: 2, reason: 'x' }, world.actor))).toMatchObject({ status: 409, code: FormDefinitionErrorCode.ARCHIVED });
    expect(await bodyOf(world.service.restore(definitionId, { expectedVersion: 1 }, world.actor))).toMatchObject({ status: 409, code: FormDefinitionErrorCode.VERSION_CONFLICT, details: { token: 'expectedVersion', current: 2 } });
  });

  it('refuses to restore onto a current version whose stored content no longer matches its hash', async () => {
    const world = formAdminWorld();
    const definitionId = String(world.legacy[IDS.apartment].definitionId);
    await world.service.archive(definitionId, { expectedVersion: 1, reason: 'x' }, world.actor);
    world.mongo.data.versions.get(String(world.legacy[IDS.apartment].versionId).toLowerCase())!.amenitiesEnabled = false;
    expect(await bodyOf(world.service.restore(definitionId, { expectedVersion: 2 }, world.actor))).toMatchObject({ status: 409, code: FormDefinitionErrorCode.CURRENT_VERSION_INVALID });
    expect(world.mongo.get('definitions', definitionId)!.status).toBe('archived');
  });
});

describe('Phase-4 compatibility: what clients and property writes see', () => {
  /** A PropertyWorld whose form definitions live in FakeFormMongo and are managed by the Admin service. */
  function linked() {
    const forms = formAdminWorld({ typeIds: [IDS.apartment, IDS.duplex, IDS.villa, IDS.land, IDS.studio], withoutHead: [IDS.unreleased] });
    const property = new PropertyWorld();
    Object.assign(property.service as any, forms.mongo.formModels());
    return { forms, property, service: property.service as any };
  }
  const code = async (promise: Promise<unknown>) => (await errorOf(promise)).getResponse?.().code;

  it('keeps a post-026 type non-writable until a version is published, then accepts dynamic writes only', async () => {
    const { forms, service } = linked();
    const { files, media } = photos(['additional_1']);
    const payload = () => legacyPayload({ purposeSubcategoryId: IDS.unreleased, amenityCodes: [], ...media });
    expect(await code(service.create(IDS.user, payload(), files))).toBe(PropertyErrorCode.FORM_DEFINITION_NOT_PUBLISHED);
    const { definitionId, draftRevision } = await preparedDefinition(forms);
    // A draft is never a writable pin.
    const draftId = (await forms.service.getDefinition(definitionId)).draft!.versionId;
    expect(await code(service.create(IDS.user, dynamicPayload({ _id: draftId }, { plotShape: 'regular' }, { purposeSubcategoryId: IDS.unreleased, amenityCodes: [], ...media }), files))).toBe(PropertyErrorCode.FORM_DEFINITION_INVALID);
    const published = await forms.service.publish(definitionId, { expectedVersion: 0, expectedDraftRevision: draftRevision }, forms.actor);
    const created = await service.create(IDS.user, dynamicPayload({ _id: published.published.versionId }, { plotShape: 'regular', roadWidth: 12.5 }, { purposeSubcategoryId: IDS.unreleased, amenityCodes: [], ...media }), files);
    expect(created.property.id).toBeDefined();
    // Old clients: not legacy-writable, so hidden and refused.
    expect(await code(service.create(IDS.user, payload(), files))).toBe(PropertyErrorCode.CLIENT_UPGRADE_REQUIRED);
    const pointers = await forms.publicService.creationPointers();
    const types = [IDS.apartment, IDS.unreleased].map((id) => ({ id }));
    expect(creatableTypesForClient(types, pointers, false).map((type) => type.id)).toEqual([IDS.apartment]);
    expect(creatableTypesForClient(types, pointers, true).map((type) => type.id)).toEqual([IDS.apartment, IDS.unreleased]);
  });

  it('publishes a residential_rooms form that omits room counts; writes get no injected fields and no photo slots for them', async () => {
    const { forms, service, property } = linked();
    // Bedrooms and bathrooms only: no livingRooms, no kitchens, and no totalFloors for the floor cross-field rule.
    const input = {
      fields: [
        { key: 'bedrooms', labelAr: 'غرف النوم', required: true, order: 10, widget: 'stepper', validation: { min: 1, max: 10 } },
        { key: 'bathrooms', labelAr: 'الحمامات', required: true, order: 20, validation: { min: 1, max: 10 } },
        { key: 'floor', labelAr: 'الدور', required: false, order: 30, validation: { min: -10, max: 300 } },
      ],
      mediaProfile: 'residential_rooms',
      amenitiesEnabled: true,
    };
    const { definitionId, draftRevision } = await preparedDefinition(forms, input as any);
    expect((await forms.service.validateDraft(definitionId)).errors).toEqual([]);
    const published = await forms.service.publish(definitionId, { expectedVersion: 0, expectedDraftRevision: draftRevision }, forms.actor);
    expect(published.current!.fields.map((field) => field.key)).toEqual(['bedrooms', 'bathrooms', 'floor']);
    const publicVersion = await forms.publicService.getPublicVersion(published.published.versionId);
    expect(publicVersion.mediaRequirements.profile).toBe('residential_rooms');
    expect(publicVersion.fields.map((field) => field.key)).toEqual(['bedrooms', 'bathrooms', 'floor']);
    // Required slots come only from the counts the form collects.
    const { files, media } = photos(['exterior', 'entrance', 'bedroom_1', 'bedroom_2', 'bathroom_1']);
    const created = await service.create(IDS.user, dynamicPayload({ _id: published.published.versionId }, { bedrooms: 2, bathrooms: 1, floor: 250 }, { purposeSubcategoryId: IDS.unreleased, ...media }), files);
    expect(property.revision(created.property.revisionId).attributes).toEqual({ bedrooms: 2, bathrooms: 1, floor: 250 });
    // Sending a room count the form does not define is refused, not stored.
    expect(await code(service.create(IDS.user, dynamicPayload({ _id: published.published.versionId }, { bedrooms: 2, bathrooms: 1, kitchens: 1 }, { purposeSubcategoryId: IDS.unreleased, ...media }), files))).toBe(PropertyErrorCode.ATTRIBUTES_INVALID);
  });

  it('fails a write pinned to the superseded version with the Phase-4 freshness conflict after a publish', async () => {
    const { forms, service } = linked();
    const apartmentV1 = forms.legacy[IDS.apartment].versionId;
    const { definitionId, opened } = await legacyDraft(forms);
    await save(forms, definitionId, 0, { fields: [...inputOf(opened.draft!.fields), { key: 'hasGarden', labelAr: 'حديقة', required: false, order: 100 }], mediaProfile: 'residential_rooms', amenitiesEnabled: true });
    await forms.service.publish(definitionId, { expectedVersion: 2, expectedDraftRevision: 1 }, forms.actor);
    const attributes = { bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatus: 'fully_finished', deliveryStatus: 'immediate' };
    expect(await code(service.create(IDS.user, dynamicPayload({ _id: apartmentV1 }, attributes), {}))).toBe(PropertyErrorCode.FORM_VERSION_OUTDATED);
    // v2 stays legacy-writable (only an optional field was added), so old clients keep writing.
    expect(computeLegacyWritable(forms.mongo.get('versions', forms.mongo.get('definitions', definitionId)!.currentVersionId)! as any)).toBe(true);
  });

  it('blocks new writes for an archived definition while pinned history stays readable, and restore re-enables writes', async () => {
    const { forms, service, property } = linked();
    const created = await service.create(IDS.user, legacyPayload(), {});
    const revision = property.revision(created.property.revisionId);
    const definitionId = String(forms.legacy[IDS.apartment].definitionId);
    await forms.service.archive(definitionId, { expectedVersion: 1, reason: 'مراجعة' }, forms.actor);
    expect(await code(service.create(IDS.user, legacyPayload(), {}))).toBe(PropertyErrorCode.FORM_DEFINITION_ARCHIVED);
    expect(await forms.publicService.getPublicVersion(String(revision.formDefinitionVersionId))).toMatchObject({ version: 1, contentHash: revision.formContentHash });
    expect(forms.mongo.get('versions', revision.formDefinitionVersionId)).toMatchObject({ state: 'published' });
    await forms.service.restore(definitionId, { expectedVersion: 2 }, forms.actor);
    expect((await service.create(IDS.user, legacyPayload(), {})).property.id).toBeDefined();
  });
});
