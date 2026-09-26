import 'reflect-metadata';
import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { SystemRole } from '../src/auth/roles.enum';
import { PropertyErrorCode } from '../src/common/errors/property-error-codes';
import { PropertiesController } from '../src/properties/properties.controller';
import { PropertiesService } from '../src/properties/properties.service';
import { PropertyMarketingMode, PropertyMediaTagCode } from '../src/properties/property.types';
import { LEGACY_RESIDENTIAL_CONTENT_HASH, LEGACY_RESIDENTIAL_FIELDS } from '../src/property-form-definitions/property-form-definition.constants';
import { AccountType, BrokerStatus } from '../src/users/identity.types';
import { IDS, LAND_FIELDS, PropertyWorld, VILLA_V2_FIELDS, dynamicPayload, legacyPayload, photos } from './support/property-world';

/**
 * DPF-020 — dynamic property writes: create, draft save and new revision pin
 * the PRIMARY type's current published FormDefinitionVersion and store its
 * validated attributes; legacy clients keep writing legacy-writable types.
 */

const LEGACY_FLAT_FIELDS = ['bedrooms', 'livingRooms', 'kitchens', 'bathrooms', 'floor', 'totalFloors', 'buildingYear', 'finishingStatusCode', 'deliveryStatusCode'];
const RESIDENTIAL_SLOTS = ['exterior', 'entrance', 'living_1', 'bedroom_1', 'bedroom_2', 'bedroom_3', 'kitchen_1', 'bathroom_1', 'bathroom_2'];
const APARTMENT_ATTRIBUTES = { bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatus: 'fully_finished', deliveryStatus: 'immediate' };

function world() {
  const value = new PropertyWorld();
  const land = value.forms.publish(IDS.land, { fields: LAND_FIELDS, mediaProfile: 'generic', amenitiesEnabled: false });
  const villa = value.forms.publish(IDS.villa, { fields: VILLA_V2_FIELDS });
  return { world: value, service: value.service as any, land, villa, apartment: value.forms.current(IDS.apartment) };
}

const errorOf = async (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected rejection'); }, (error) => error);
const responseOf = async (promise: Promise<unknown>) => { const error = await errorOf(promise); return { status: error.getStatus?.(), body: error.getResponse?.() ?? error }; };
const pin = (revision: any) => ({
  formDefinitionId: String(revision.formDefinitionId), formDefinitionVersionId: String(revision.formDefinitionVersionId),
  formDefinitionVersion: revision.formDefinitionVersion, formContentHash: revision.formContentHash,
});
const expectedPin = (version: any) => ({ formDefinitionId: String(version.definitionId), formDefinitionVersionId: String(version._id), formDefinitionVersion: version.version, formContentHash: version.contentHash });
const noLegacyFlatFields = (record: any) => LEGACY_FLAT_FIELDS.filter((field) => record[field] !== undefined);

describe('DPF-020 dynamic create, draft save and new revision', () => {
  it('pins a dynamic create to the primary type\'s current version and stores normalized attributes', async () => {
    const ctx = world();
    const { files, media } = photos(['additional_1']);
    const result = await ctx.service.create(IDS.user, dynamicPayload(ctx.land, {
      notes: '  أرض  على الطريق ', irrigationTypes: ['pivot', 'drip'], plotShape: 'regular', hasWaterAccess: false, roadWidth: 12.5,
    }, { purposeSubcategoryId: IDS.land, amenityCodes: [], ...media }), files);
    const revision = ctx.world.revision(result.property.revisionId);
    expect(pin(revision)).toEqual(expectedPin(ctx.land));
    // Normalized: trimmed text, multiSelect in the version's option order, false kept as a provided boolean; field order.
    expect(revision.attributes).toEqual({ plotShape: 'regular', irrigationTypes: ['drip', 'pivot'], hasWaterAccess: false, roadWidth: 12.5, notes: 'أرض  على الطريق' });
    expect(Object.keys(revision.attributes)).toEqual(['plotShape', 'irrigationTypes', 'hasWaterAccess', 'roadWidth', 'notes']);
    expect(Object.getPrototypeOf(revision.attributes)).toBe(Object.prototype);
    expect(noLegacyFlatFields(revision)).toEqual([]);
    expect(noLegacyFlatFields(ctx.world.property(result.property.id))).toEqual([]);
    // Generic photos carry no guided tag.
    expect(revision.galleryMedia.map((asset: any) => asset.tagCode)).toEqual([PropertyMediaTagCode.OTHER]);
  });

  it('pins the seeded legacy v1 when a dynamic client writes a legacy-form type', async () => {
    const ctx = world();
    const result = await ctx.service.create(IDS.user, dynamicPayload(ctx.apartment, APARTMENT_ATTRIBUTES));
    const revision = ctx.world.revision(result.property.revisionId);
    expect(revision.formContentHash).toBe(LEGACY_RESIDENTIAL_CONTENT_HASH);
    expect(revision.attributes).toEqual(APARTMENT_ATTRIBUTES);
    // Catalog-backed values count as used, exactly like the legacy fields did.
    expect(ctx.world.optionUsage('finishing_status', 'fully_finished')).toBe(1);
    expect(ctx.world.optionUsage('delivery_status', 'immediate')).toBe(1);
  });

  it('replaces an existing draft wholesale and re-pins it (legacy flat fields removed from a legacy draft)', async () => {
    const ctx = world();
    const created = await ctx.service.create(IDS.user, legacyPayload());
    const draftId = created.property.revisionId;
    // Simulate a draft written before pinning existed.
    const stored = ctx.world.revision(draftId);
    for (const key of ['formDefinitionId', 'formDefinitionVersionId', 'formDefinitionVersion', 'formContentHash', 'attributes']) delete stored[key];
    Object.assign(stored, { bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatusCode: 'fully_finished', deliveryStatusCode: 'immediate' });

    await ctx.service.createDraftRevision(IDS.user, created.property.id, dynamicPayload(ctx.apartment, { ...APARTMENT_ATTRIBUTES, bedrooms: 4 }, { expectedRevisionVersion: 0 }), {});
    const draft = ctx.world.revision(draftId);
    expect(pin(draft)).toEqual(expectedPin(ctx.apartment));
    expect(draft.attributes.bedrooms).toBe(4);
    expect(noLegacyFlatFields(draft)).toEqual([]);
    expect(draft.decisionVersion).toBe(1);
    expect(ctx.world.revisions).toHaveLength(1);
  });

  it('pins a new revision of an approved property, leaving the approved revision untouched', async () => {
    const ctx = world();
    const { propertyId, approvedId } = await approvedLegacyProperty(ctx);
    const approvedBefore = JSON.stringify(ctx.world.revision(approvedId));
    const result = await ctx.service.createDraftRevision(IDS.user, propertyId, dynamicPayload(ctx.apartment, { ...APARTMENT_ATTRIBUTES, floor: 3 }), {});
    const revision = ctx.world.revision(result.property.revisionId);
    expect(revision.revisionNumber).toBe(2);
    expect(pin(revision)).toEqual(expectedPin(ctx.apartment));
    expect(revision.attributes.floor).toBe(3);
    expect(JSON.stringify(ctx.world.revision(approvedId))).toBe(approvedBefore);
  });

  it('applies exactly the same form rules on the Admin proxy create and proxy revision paths', async () => {
    const ctx = world();
    const created = await ctx.service.createForAdmin(IDS.admin, IDS.user, dynamicPayload(ctx.land, { plotShape: 'irregular' }, { purposeSubcategoryId: IDS.land, amenityCodes: [], marketingMode: PropertyMarketingMode.PLATFORM_MANAGED }), {});
    const revision = ctx.world.revision(created.property.revisionId);
    expect(pin(revision)).toEqual(expectedPin(ctx.land));
    expect(String(revision.createdByActorId)).toBe(IDS.admin);

    const invalid = await responseOf(ctx.service.createDraftRevisionForAdmin(IDS.admin, created.property.id, dynamicPayload(ctx.land, { plotShape: 'round' }, { purposeSubcategoryId: IDS.land, amenityCodes: [], expectedRevisionVersion: 0 }), {}));
    expect(invalid.body).toEqual({ message: expect.any(String), code: PropertyErrorCode.ATTRIBUTES_INVALID, details: { formDefinitionVersionId: String(ctx.land._id), fieldErrors: [{ key: 'plotShape', code: 'OPTION_INVALID', params: {} }] } });

    await ctx.service.createDraftRevisionForAdmin(IDS.admin, created.property.id, dynamicPayload(ctx.land, { plotShape: 'regular', hasWaterAccess: true }, { purposeSubcategoryId: IDS.land, amenityCodes: [], expectedRevisionVersion: 0, marketingMode: PropertyMarketingMode.PLATFORM_MANAGED }), {});
    expect(ctx.world.revision(created.property.revisionId).attributes).toEqual({ plotShape: 'regular', hasWaterAccess: true });
  });

  it('stores an empty attribute map for a form whose fields are all optional, and the pinned revision passes schema validation', async () => {
    const ctx = world();
    const optional = ctx.world.forms.publish(IDS.studio, { fields: [{ key: 'hasBalcony', dataType: 'boolean', labelAr: 'شرفة', required: false, order: 1 }], mediaProfile: 'generic' });
    const result = await ctx.service.create(IDS.user, dynamicPayload(optional, {}, { purposeSubcategoryId: IDS.studio }));
    const revision = ctx.world.revision(result.property.revisionId);
    expect(revision.attributes).toEqual({});
    expect(pin(revision)).toEqual(expectedPin(optional));
  });
});

describe('DPF-020 attribute validation on writes (frozen §B)', () => {
  const invalid = async (attributes: Record<string, unknown> | string, overrides: Record<string, unknown> = {}) => {
    const ctx = world();
    const response = await responseOf(ctx.service.create(IDS.user, dynamicPayload(ctx.land, attributes, { purposeSubcategoryId: IDS.land, amenityCodes: [], ...overrides })));
    expect(ctx.world.revisions).toHaveLength(0);
    expect(ctx.world.properties).toHaveLength(0);
    return response;
  };

  it('rejects unknown attributes instead of stripping them', async () => {
    const { status, body } = await invalid({ plotShape: 'regular', bedrooms: 3, zzz: 1 });
    expect(status).toBe(400);
    expect(body.details.fieldErrors).toEqual([{ key: 'bedrooms', code: 'UNKNOWN_FIELD', params: {} }, { key: 'zzz', code: 'UNKNOWN_FIELD', params: {} }]);
  });

  it('rejects wrong value types without coercion', async () => {
    const { body } = await invalid({ plotShape: 'regular', hasWaterAccess: 'true', roadWidth: '12' });
    expect(body.details.fieldErrors).toEqual([
      { key: 'hasWaterAccess', code: 'TYPE_MISMATCH', params: { expected: 'boolean' } },
      { key: 'roadWidth', code: 'TYPE_MISMATCH', params: { expected: 'decimal' } },
    ]);
  });

  it('rejects inline options outside the version and catalog codes that are not active', async () => {
    expect((await invalid({ plotShape: 'triangle' })).body.details.fieldErrors).toEqual([{ key: 'plotShape', code: 'OPTION_INVALID', params: {} }]);
    const ctx = world();
    ctx.world.options.find((option) => option.code === 'semi_finished')!.isActive = false;
    const { body } = await responseOf(ctx.service.create(IDS.user, dynamicPayload(ctx.apartment, { ...APARTMENT_ATTRIBUTES, finishingStatus: 'semi_finished', deliveryStatus: 'unknown_code' })));
    expect(body.details.fieldErrors).toEqual([
      { key: 'finishingStatus', code: 'OPTION_INVALID', params: {} },
      { key: 'deliveryStatus', code: 'OPTION_INVALID', params: {} },
    ]);
  });

  it('rejects a field that does not apply to the operation', async () => {
    const { body } = await invalid({ plotShape: 'regular', leaseTermYears: 5 });
    expect(body.details.fieldErrors).toEqual([{ key: 'leaseTermYears', code: 'NOT_APPLICABLE', params: { operationType: 'sale' } }]);
    const ctx = world();
    await ctx.service.create(IDS.user, dynamicPayload(ctx.land, { plotShape: 'regular', leaseTermYears: 5 }, { purposeSubcategoryId: IDS.land, amenityCodes: [], operationType: 'rent' }));
    expect(ctx.world.revisions[0].attributes).toEqual({ plotShape: 'regular', leaseTermYears: 5 });
  });

  it('reports every failing field with bounds, scale and required errors in field order', async () => {
    const { body } = await invalid({ roadWidth: 12.25, notes: 'x'.repeat(101), irrigationTypes: ['drip', 'drip'] });
    expect(body.details.fieldErrors).toEqual([
      { key: 'plotShape', code: 'REQUIRED', params: {} },
      { key: 'irrigationTypes', code: 'DUPLICATE_ITEMS', params: {} },
      { key: 'roadWidth', code: 'SCALE_EXCEEDED', params: { scale: 1 } },
      { key: 'notes', code: 'MAX_LENGTH', params: { maxLength: 100 } },
    ]);
  });

  it('checks the engineering cross-field rule on dynamic writes', async () => {
    const ctx = world();
    const { body } = await responseOf(ctx.service.create(IDS.user, dynamicPayload(ctx.apartment, { ...APARTMENT_ATTRIBUTES, floor: 7, totalFloors: 5 })));
    expect(body.details.fieldErrors).toEqual([{ key: 'floor', code: 'CROSS_FIELD', params: { rule: 'floorNotAboveTotalFloors', relatedKeys: ['totalFloors'] } }]);
  });

  it.each([
    ['not JSON', '{plotShape:', 'INVALID_JSON'],
    ['an array', '["regular"]', 'NOT_OBJECT'],
    ['a prototype-pollution key', '{"__proto__":{"polluted":true},"plotShape":"regular"}', 'INVALID_KEY'],
    ['a denylisted key', '{"constructor":1}', 'INVALID_KEY'],
    ['nested JSON', '{"plotShape":{"code":"regular"}}', 'NESTED_VALUE'],
    ['more than 16 KB', JSON.stringify({ notes: 'x'.repeat(16_400) }), 'TOO_LARGE'],
    ['a missing attributes field', undefined, 'INVALID_JSON'],
  ])('rejects %s as PROPERTY_ATTRIBUTES_MALFORMED', async (_label, raw, reason) => {
    const ctx = world();
    const payload = dynamicPayload(ctx.land, {}, { purposeSubcategoryId: IDS.land, amenityCodes: [] });
    payload.attributes = raw;
    const { status, body } = await responseOf(ctx.service.create(IDS.user, payload));
    expect(status).toBe(400);
    expect(body).toEqual({ message: expect.any(String), code: PropertyErrorCode.ATTRIBUTES_MALFORMED, details: { reason } });
    expect(({} as any).polluted).toBeUndefined();
  });

  it('rejects amenities for a form with amenities disabled', async () => {
    const { body } = await invalid({ plotShape: 'regular' }, { amenityCodes: ['elevator'] });
    expect(body).toEqual({ message: expect.any(String), code: PropertyErrorCode.AMENITIES_NOT_ENABLED });
  });
});

describe('DPF-020 pin integrity (frozen §B8, §C)', () => {
  const pinError = async (mutate: (ctx: ReturnType<typeof world>) => any) => {
    const ctx = world();
    const response = await responseOf(ctx.service.create(IDS.user, mutate(ctx)));
    expect(ctx.world.revisions).toHaveLength(0);
    return response;
  };
  const invalidReason = (response: { status: number; body: any }) => {
    expect(response.status).toBe(400);
    expect(response.body.code).toBe(PropertyErrorCode.FORM_DEFINITION_INVALID);
    return response.body.details.reason;
  };

  it('rejects an unknown version id and a draft version', async () => {
    expect(invalidReason(await pinError(() => dynamicPayload({ _id: new Types.ObjectId() }, APARTMENT_ATTRIBUTES)))).toBe('VERSION_NOT_FOUND');
    expect(invalidReason(await pinError((ctx) => dynamicPayload(ctx.world.forms.draft(IDS.apartment, { fields: [...LEGACY_RESIDENTIAL_FIELDS] }), APARTMENT_ATTRIBUTES)))).toBe('VERSION_NOT_PUBLISHED');
  });

  it('rejects a version of another type than the primary, even one of the additional selected types', async () => {
    const response = await pinError((ctx) => dynamicPayload(ctx.world.forms.current(IDS.duplex), APARTMENT_ATTRIBUTES, { purposeSubcategoryIds: [IDS.apartment, IDS.duplex] }));
    expect(invalidReason(response)).toBe('SUBCATEGORY_MISMATCH');
    expect(response.body.details.purposeSubcategoryId).toBe(IDS.apartment);
  });

  it('rejects a formDefinitionId that is not the primary type\'s definition', async () => {
    expect(invalidReason(await pinError((ctx) => dynamicPayload(ctx.apartment, APARTMENT_ATTRIBUTES, { formDefinitionId: String(ctx.land.definitionId) })))).toBe('DEFINITION_MISMATCH');
  });

  it('rejects a mismatched formDefinitionVersion or formContentHash, and accepts matching echoes', async () => {
    expect(invalidReason(await pinError((ctx) => dynamicPayload(ctx.apartment, APARTMENT_ATTRIBUTES, { formDefinitionVersion: 2 })))).toBe('VERSION_NUMBER_MISMATCH');
    expect(invalidReason(await pinError((ctx) => dynamicPayload(ctx.apartment, APARTMENT_ATTRIBUTES, { formContentHash: 'f'.repeat(64) })))).toBe('CONTENT_HASH_MISMATCH');
    const ctx = world();
    await ctx.service.create(IDS.user, dynamicPayload(ctx.apartment, APARTMENT_ATTRIBUTES, {
      formDefinitionId: String(ctx.apartment.definitionId), formDefinitionVersion: 1, formContentHash: LEGACY_RESIDENTIAL_CONTENT_HASH,
    }));
    expect(pin(ctx.world.revisions[0])).toEqual(expectedPin(ctx.apartment));
  });

  it('rejects a superseded version with 409 PROPERTY_FORM_VERSION_OUTDATED and the current pointers', async () => {
    const ctx = world();
    const superseded = ctx.world.forms.current(IDS.apartment);
    const current = ctx.world.forms.publish(IDS.apartment, { fields: VILLA_V2_FIELDS });
    const { status, body } = await responseOf(ctx.service.create(IDS.user, dynamicPayload(superseded, APARTMENT_ATTRIBUTES)));
    expect(status).toBe(409);
    expect(body).toEqual({
      message: expect.any(String),
      code: PropertyErrorCode.FORM_VERSION_OUTDATED,
      details: {
        purposeSubcategoryId: IDS.apartment, definitionId: String(current.definitionId),
        submittedVersionId: String(superseded._id), submittedVersion: 1,
        currentVersionId: String(current._id), currentVersion: 2, currentContentHash: current.contentHash, rendererVersion: 1,
      },
    });
    expect(ctx.world.revisions).toHaveLength(0);
  });

  it('rejects a version whose renderer the backend does not support, and a version whose stored content was altered', async () => {
    const renderer = await pinError((ctx) => dynamicPayload(ctx.world.forms.publish(IDS.studio, { fields: [], rendererVersion: 2, mediaProfile: 'generic' }), {}, { purposeSubcategoryId: IDS.studio }));
    expect(invalidReason(renderer)).toBe('RENDERER_UNSUPPORTED');
    const tampered = await pinError((ctx) => {
      ctx.world.forms.current(IDS.apartment).fields[0].validation = { min: 0, max: 100 };
      return dynamicPayload(ctx.apartment, APARTMENT_ATTRIBUTES);
    });
    expect(invalidReason(tampered)).toBe('VERSION_INTEGRITY');
  });

  it('rejects dynamic-form fields without a version id, and legacy flat fields mixed with one (frozen §B1, §H5)', async () => {
    const ctx = world();
    const withoutVersion = await responseOf(ctx.service.create(IDS.user, { ...legacyPayload(), attributes: '{}' }));
    expect(withoutVersion.body).toMatchObject({ code: PropertyErrorCode.FORM_DEFINITION_INVALID, details: { reason: 'VERSION_ID_REQUIRED' } });
    const hashOnly = await responseOf(ctx.service.create(IDS.user, { ...legacyPayload(), formContentHash: LEGACY_RESIDENTIAL_CONTENT_HASH }));
    expect(hashOnly.body).toMatchObject({ code: PropertyErrorCode.FORM_DEFINITION_INVALID, details: { reason: 'VERSION_ID_REQUIRED' } });
    const mixed = await responseOf(ctx.service.create(IDS.user, { ...dynamicPayload(ctx.apartment, APARTMENT_ATTRIBUTES), bedrooms: 3, finishingStatusCode: 'fully_finished' }));
    expect(mixed.body).toEqual({ message: expect.any(String), code: PropertyErrorCode.LEGACY_INPUT_NOT_ACCEPTED, details: { fields: ['bedrooms', 'finishingStatusCode'] } });
    expect(ctx.world.revisions).toHaveLength(0);
  });
});

describe('DPF-020 form eligibility of every selected type (amendment rule 4)', () => {
  it('rejects a primary type whose definition has no published version or is archived', async () => {
    const ctx = world();
    const unreleased = await responseOf(ctx.service.create(IDS.user, legacyPayload({ purposeSubcategoryId: IDS.unreleased })));
    expect(unreleased.body).toEqual({ message: expect.any(String), code: PropertyErrorCode.FORM_DEFINITION_NOT_PUBLISHED, details: { purposeSubcategoryId: IDS.unreleased } });
    ctx.world.forms.archive(IDS.land);
    const archived = await responseOf(ctx.service.create(IDS.user, dynamicPayload(ctx.land, { plotShape: 'regular' }, { purposeSubcategoryId: IDS.land, amenityCodes: [] })));
    expect(archived.body).toEqual({ message: expect.any(String), code: PropertyErrorCode.FORM_DEFINITION_ARCHIVED, details: { purposeSubcategoryId: IDS.land } });
  });

  it('rejects an additional type that is not listing-enabled, naming it', async () => {
    const ctx = world();
    const unreleased = await responseOf(ctx.service.create(IDS.user, legacyPayload({ purposeSubcategoryIds: [IDS.apartment, IDS.unreleased] })));
    expect(unreleased.body).toMatchObject({ code: PropertyErrorCode.FORM_DEFINITION_NOT_PUBLISHED, details: { purposeSubcategoryId: IDS.unreleased } });
    ctx.world.forms.archive(IDS.duplex);
    const archived = await responseOf(ctx.service.create(IDS.user, dynamicPayload(ctx.apartment, APARTMENT_ATTRIBUTES, { purposeSubcategoryIds: [IDS.apartment, IDS.duplex] })));
    expect(archived.body).toMatchObject({ code: PropertyErrorCode.FORM_DEFINITION_ARCHIVED, details: { purposeSubcategoryId: IDS.duplex } });
    expect(ctx.world.revisions).toHaveLength(0);
  });

  it('keeps additional types as classification only: their forms add no fields, media or amenity rules', async () => {
    const ctx = world();
    // Apartment (legacy residential) primary + Land (generic, amenities off, required plotShape) additional.
    const { files, media } = photos(RESIDENTIAL_SLOTS);
    const result = await ctx.service.create(IDS.user, dynamicPayload(ctx.apartment, APARTMENT_ATTRIBUTES, { purposeSubcategoryIds: [IDS.land, IDS.apartment], ...media }), files);
    const revision = ctx.world.revision(result.property.revisionId);
    expect(pin(revision)).toEqual(expectedPin(ctx.apartment));
    expect(revision.purposeSubcategoryIds.map(String)).toEqual([IDS.apartment, IDS.land]);
    expect(revision.amenityCodes).toEqual(['elevator']);
    expect(revision.galleryMedia.map((asset: any) => asset.tagCode).slice(0, 3)).toEqual([PropertyMediaTagCode.EXTERIOR, PropertyMediaTagCode.ENTRANCE, PropertyMediaTagCode.LIVING_ROOM]);
    const landKey = await responseOf(ctx.service.create(IDS.user, dynamicPayload(ctx.apartment, { ...APARTMENT_ATTRIBUTES, plotShape: 'regular' }, { purposeSubcategoryIds: [IDS.land, IDS.apartment] })));
    expect(landKey.body.details.fieldErrors).toEqual([{ key: 'plotShape', code: 'UNKNOWN_FIELD', params: {} }]);
  });
});

describe('DPF-020 primary type change', () => {
  it('validates against the new primary\'s form only and never keeps the old form\'s attributes', async () => {
    const ctx = world();
    const created = await ctx.service.create(IDS.user, dynamicPayload(ctx.villa, { ...APARTMENT_ATTRIBUTES, hasGarden: true }, { purposeSubcategoryId: IDS.villa }));
    const { id: propertyId, revisionId } = created.property;

    // The old primary's version for the new primary: rejected.
    const oldForm = await responseOf(ctx.service.createDraftRevision(IDS.user, propertyId, dynamicPayload(ctx.villa, { plotShape: 'regular' }, { purposeSubcategoryId: IDS.land, amenityCodes: [], expectedRevisionVersion: 0 }), {}));
    expect(oldForm.body).toMatchObject({ code: PropertyErrorCode.FORM_DEFINITION_INVALID, details: { reason: 'SUBCATEGORY_MISMATCH', purposeSubcategoryId: IDS.land } });
    // The new primary's version with the old form's keys: rejected, not stripped.
    const oldKeys = await responseOf(ctx.service.createDraftRevision(IDS.user, propertyId, dynamicPayload(ctx.land, { plotShape: 'regular', hasGarden: true, bedrooms: 3 }, { purposeSubcategoryId: IDS.land, amenityCodes: [], expectedRevisionVersion: 0 }), {}));
    expect(oldKeys.body.details.fieldErrors.map((error: any) => [error.key, error.code])).toEqual([['bedrooms', 'UNKNOWN_FIELD'], ['hasGarden', 'UNKNOWN_FIELD']]);

    await ctx.service.createDraftRevision(IDS.user, propertyId, dynamicPayload(ctx.land, { plotShape: 'regular' }, { purposeSubcategoryId: IDS.land, amenityCodes: [], expectedRevisionVersion: 0 }), {});
    const draft = ctx.world.revision(revisionId);
    expect(String(draft.purposeSubcategoryId)).toBe(IDS.land);
    expect(pin(draft)).toEqual(expectedPin(ctx.land));
    expect(draft.attributes).toEqual({ plotShape: 'regular' });
  });

  it('carries a non-legacy value forward for an old client only while the primary type is unchanged', async () => {
    const ctx = world();
    const { propertyId } = await approvedDynamicVilla(ctx, { hasGarden: true });
    // Old client, same primary: the invisible hasGarden survives on the new revision.
    const sameType = await ctx.service.createDraftRevision(IDS.user, propertyId, legacyPayload({ purposeSubcategoryId: IDS.villa, bedrooms: 5 }), {});
    expect(ctx.world.revision(sameType.property.revisionId).attributes).toEqual({ ...APARTMENT_ATTRIBUTES, bedrooms: 5, hasGarden: true });
    // Old client switches the primary to apartment, whose current form also has hasGarden:
    // nothing from the villa form is carried, even under the same key.
    const apartmentV2 = ctx.world.forms.publish(IDS.apartment, { fields: VILLA_V2_FIELDS });
    await ctx.service.createDraftRevision(IDS.user, propertyId, legacyPayload({ purposeSubcategoryId: IDS.apartment, expectedRevisionVersion: 0 }), {});
    const switched = ctx.world.revision(sameType.property.revisionId);
    expect(String(switched.purposeSubcategoryId)).toBe(IDS.apartment);
    expect(switched.attributes).toEqual(APARTMENT_ATTRIBUTES);
    expect(pin(switched)).toEqual(expectedPin(apartmentV2));
  });

  it('drops a carried value that is no longer valid instead of failing the old client', async () => {
    const ctx = world();
    const { propertyId } = await approvedDynamicVilla(ctx, { hasGarden: true });
    // Villa v3 turns hasGarden into an integer field; the stored boolean no longer validates.
    ctx.world.forms.publish(IDS.villa, { fields: [...LEGACY_RESIDENTIAL_FIELDS.map((field) => ({ ...field })), { key: 'hasGarden', dataType: 'integer', labelAr: 'حديقة', required: false, order: 100 }] });
    const result = await ctx.service.createDraftRevision(IDS.user, propertyId, legacyPayload({ purposeSubcategoryId: IDS.villa }), {});
    expect(ctx.world.revision(result.property.revisionId).attributes).toEqual(APARTMENT_ATTRIBUTES);
  });
});

describe('DPF-020 legacy (pre-dynamic-form) clients', () => {
  it('keeps a legacy-writable type writable with today\'s flat payload, pinned to the current version without flat fields', async () => {
    const ctx = world();
    const { files, media } = photos(RESIDENTIAL_SLOTS);
    const result = await ctx.service.create(IDS.user, legacyPayload(media), files);
    const revision = ctx.world.revision(result.property.revisionId);
    expect(pin(revision)).toEqual(expectedPin(ctx.apartment));
    expect(revision.attributes).toEqual(APARTMENT_ATTRIBUTES);
    expect(noLegacyFlatFields(revision)).toEqual([]);
    // Guided tags are exactly today's.
    expect(revision.galleryMedia.map((asset: any) => asset.tagCode)).toEqual([
      PropertyMediaTagCode.EXTERIOR, PropertyMediaTagCode.ENTRANCE, PropertyMediaTagCode.LIVING_ROOM, PropertyMediaTagCode.BEDROOM, PropertyMediaTagCode.BEDROOM,
      PropertyMediaTagCode.BEDROOM, PropertyMediaTagCode.KITCHEN, PropertyMediaTagCode.BATHROOM, PropertyMediaTagCode.BATHROOM,
    ]);
    // The old client still reads its flat fields back, derived from the pinned attributes.
    const mine = await ctx.service.getMine(IDS.user, result.property.id);
    expect(mine.property).toMatchObject({ bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatusCode: 'fully_finished', deliveryStatusCode: 'immediate' });
    expect(mine.property.specifications.source).toBe('definition');
  });

  it('keeps today\'s legacy error for floor above total floors and for inactive catalog codes', async () => {
    const ctx = world();
    await expect(ctx.service.create(IDS.user, legacyPayload({ floor: 6, totalFloors: 5 }))).rejects.toThrow('رقم الطابق لا يمكن أن يتجاوز عدد الطوابق');
    await expect(ctx.service.create(IDS.user, legacyPayload({ finishingStatusCode: 'unknown' }))).rejects.toThrow('حالة التشطيب');
  });

  it('never invents values an old client did not send', async () => {
    const ctx = world();
    const payload = legacyPayload();
    delete payload.buildingYear;
    const { body } = await responseOf(ctx.service.create(IDS.user, payload));
    expect(body).toMatchObject({ code: PropertyErrorCode.ATTRIBUTES_INVALID, details: { fieldErrors: [{ key: 'buildingYear', code: 'REQUIRED', params: {} }] } });
  });

  it('rejects a dynamic-only type written through the legacy flat contract', async () => {
    const ctx = world();
    const { status, body } = await responseOf(ctx.service.create(IDS.user, legacyPayload({ purposeSubcategoryId: IDS.land })));
    expect(status).toBe(400);
    expect(body).toEqual({ message: expect.any(String), code: PropertyErrorCode.CLIENT_UPGRADE_REQUIRED, details: { purposeSubcategoryId: IDS.land } });
    expect(ctx.world.revisions).toHaveLength(0);
  });
});

describe('DPF-020 idempotency fingerprint', () => {
  it('fingerprints attributes by content and includes the pin', () => {
    const ctx = world();
    const fingerprint = (dto: any) => ctx.service.requestFingerprint('new', dto, {});
    const base = fingerprint(dynamicPayload(ctx.apartment, '{"bedrooms":3,"floor":2}'));
    expect(fingerprint(dynamicPayload(ctx.apartment, '{ "floor": 2,\n "bedrooms": 3 }'))).toBe(base);
    expect(fingerprint(dynamicPayload(ctx.apartment, '{"bedrooms":4,"floor":2}'))).not.toBe(base);
    expect(fingerprint(dynamicPayload(ctx.villa, '{"bedrooms":3,"floor":2}'))).not.toBe(base);
    expect(fingerprint({ ...dynamicPayload(ctx.apartment, '{"bedrooms":3,"floor":2}'), formContentHash: LEGACY_RESIDENTIAL_CONTENT_HASH })).not.toBe(base);
    // Unparseable input still fingerprints deterministically (it is rejected anyway).
    expect(fingerprint(dynamicPayload(ctx.apartment, '{bad'))).toBe(fingerprint(dynamicPayload(ctx.apartment, '{bad')));
  });
});

/** An approved legacy-pinned apartment listing. */
async function approvedLegacyProperty(ctx: ReturnType<typeof world>) {
  const created = await ctx.service.create(IDS.user, legacyPayload({ marketingMode: PropertyMarketingMode.PLATFORM_MANAGED }));
  const revision = ctx.world.revision(created.property.revisionId);
  Object.assign(revision, { moderationStatus: 'approved', galleryMedia: [{ publicId: 'p', resourceType: 'image', url: 'https://cdn.example/p.png' }] });
  Object.assign(ctx.world.property(created.property.id), { status: 'approved', currentPublicRevisionId: revision._id });
  return { propertyId: created.property.id, approvedId: created.property.revisionId };
}

/** An approved villa listing pinned to villa v2 with extra attributes. */
async function approvedDynamicVilla(ctx: ReturnType<typeof world>, extra: Record<string, unknown>) {
  const created = await ctx.service.create(IDS.user, dynamicPayload(ctx.villa, { ...APARTMENT_ATTRIBUTES, ...extra }, { purposeSubcategoryId: IDS.villa, marketingMode: PropertyMarketingMode.PLATFORM_MANAGED }));
  const revision = ctx.world.revision(created.property.revisionId);
  revision.moderationStatus = 'approved';
  Object.assign(ctx.world.property(created.property.id), { status: 'approved', currentPublicRevisionId: revision._id });
  return { propertyId: created.property.id, approvedId: created.property.revisionId };
}

class TestJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp().getRequest();
    if (!http.headers.authorization) throw new UnauthorizedException();
    http.user = { userId: IDS.user, systemRole: SystemRole.USER, accountStatus: 'active', accountType: AccountType.USER, brokerStatus: BrokerStatus.NOT_APPLIED };
    return true;
  }
}

describe('DPF-020 multipart transport over HTTP', () => {
  let app: INestApplication;
  let ctx: ReturnType<typeof world>;

  beforeEach(async () => {
    ctx = world();
    const moduleRef = await Test.createTestingModule({
      controllers: [PropertiesController],
      providers: [{ provide: PropertiesService, useValue: ctx.service }],
    }).overrideGuard(JwtAuthGuard).useClass(TestJwtAuthGuard).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, { NODE_ENV: 'test' });
    await app.init();
  });
  afterEach(() => app.close());

  const post = (fields: Record<string, unknown>) => {
    let req = request(app.getHttpServer()).post('/api/v1/properties').set('Authorization', 'Bearer user');
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      req = req.field(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
    }
    return req;
  };

  it('accepts the dynamic multipart contract (formDefinitionVersionId + attributes JSON string) and pins the revision', async () => {
    const res = await post(dynamicPayload(ctx.land, { plotShape: 'regular', roadWidth: 8 }, { purposeSubcategoryId: IDS.land, amenityCodes: [], marketingMode: PropertyMarketingMode.PLATFORM_MANAGED }));
    expect(res.status).toBe(201);
    const revision = ctx.world.revision(res.body.data.property.revisionId);
    expect(revision.attributes).toEqual({ plotShape: 'regular', roadWidth: 8 });
    expect(pin(revision)).toEqual(expectedPin(ctx.land));
  });

  it('still accepts today\'s legacy multipart payload unchanged', async () => {
    const res = await post(legacyPayload({ marketingMode: PropertyMarketingMode.PLATFORM_MANAGED }));
    expect(res.status).toBe(201);
    expect(ctx.world.revision(res.body.data.property.revisionId).attributes).toEqual(APARTMENT_ATTRIBUTES);
  });

  it.each(['mediaProfile', 'facets', 'searchable', 'legacyWritable'])('rejects a client-selected %s (whitelisted DTO)', async (field) => {
    const res = await post({ ...dynamicPayload(ctx.land, { plotShape: 'regular' }, { purposeSubcategoryId: IDS.land, amenityCodes: [] }), [field]: 'generic' });
    expect(res.status).toBe(400);
    expect(ctx.world.revisions).toHaveLength(0);
  });

  it('returns the 409 outdated-form contract in the standard envelope', async () => {
    const superseded = ctx.world.forms.current(IDS.apartment);
    const current = ctx.world.forms.publish(IDS.apartment, { fields: VILLA_V2_FIELDS });
    const res = await post(dynamicPayload(superseded, APARTMENT_ATTRIBUTES));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      success: false, message: expect.any(String), code: PropertyErrorCode.FORM_VERSION_OUTDATED, requestId: expect.any(String),
      details: expect.objectContaining({ purposeSubcategoryId: IDS.apartment, submittedVersionId: String(superseded._id), currentVersionId: String(current._id), currentVersion: 2, currentContentHash: current.contentHash }),
    });
  });

  it('returns field errors and malformed reasons under details', async () => {
    const invalid = await post(dynamicPayload(ctx.land, { plotShape: 3 }, { purposeSubcategoryId: IDS.land, amenityCodes: [] }));
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: PropertyErrorCode.ATTRIBUTES_INVALID, details: { formDefinitionVersionId: String(ctx.land._id), fieldErrors: [{ key: 'plotShape', code: 'TYPE_MISMATCH', params: { expected: 'singleSelect' } }] } });
    const malformed = await post(dynamicPayload(ctx.land, '{"__proto__":{}}', { purposeSubcategoryId: IDS.land, amenityCodes: [] }));
    expect(malformed.body).toMatchObject({ code: PropertyErrorCode.ATTRIBUTES_MALFORMED, details: { reason: 'INVALID_KEY' } });
  });

  it('rejects a malformed version id at the transport layer', async () => {
    const res = await post({ ...dynamicPayload(ctx.land, { plotShape: 'regular' }, { purposeSubcategoryId: IDS.land, amenityCodes: [] }), formDefinitionVersionId: 'not-an-id' });
    expect(res.status).toBe(400);
    expect(ctx.world.revisions).toHaveLength(0);
  });
});
