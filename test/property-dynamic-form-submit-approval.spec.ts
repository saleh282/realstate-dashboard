import { Types } from 'mongoose';
import { PropertyErrorCode } from '../src/common/errors/property-error-codes';
import { PropertyMarketingMode, PropertyMediaTagCode } from '../src/properties/property.types';
import { LEGACY_RESIDENTIAL_FIELDS } from '../src/property-form-definitions/property-form-definition.constants';
import { IDS, LAND_FIELDS, PropertyWorld, VILLA_V2_FIELDS, dynamicPayload, legacyPayload, photos } from './support/property-world';

/**
 * DPF-021 submit validation and form freshness, DPF-022 profile-based media
 * completeness, DPF-023 approval sync of the aggregate and promoted facets.
 */

const RESIDENTIAL_SLOTS = ['exterior', 'entrance', 'living_1', 'bedroom_1', 'bedroom_2', 'bedroom_3', 'kitchen_1', 'bathroom_1', 'bathroom_2'];
const APARTMENT_ATTRIBUTES = { bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatus: 'fully_finished', deliveryStatus: 'immediate' };

function world() {
  const value = new PropertyWorld();
  const land = value.forms.publish(IDS.land, { fields: LAND_FIELDS, mediaProfile: 'generic', amenitiesEnabled: false });
  const villa = value.forms.publish(IDS.villa, { fields: VILLA_V2_FIELDS });
  return { world: value, service: value.service as any, land, villa, apartment: value.forms.current(IDS.apartment) };
}
type Ctx = ReturnType<typeof world>;

const errorOf = async (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected rejection'); }, (error) => error);
const responseOf = async (promise: Promise<unknown>) => { const error = await errorOf(promise); return { status: error.getStatus?.(), body: error.getResponse?.() ?? error }; };

/** A saved draft; returns ids and the current draft version. */
async function draft(ctx: Ctx, dto: any, files: any = {}) {
  const result = await ctx.service.create(IDS.user, dto, files);
  return { propertyId: result.property.id as string, revisionId: result.property.revisionId as string };
}
const submit = (ctx: Ctx, ids: { propertyId: string; revisionId: string }) =>
  ctx.service.submitRevision(IDS.user, ids.propertyId, ids.revisionId, ctx.world.revision(ids.revisionId).decisionVersion);
const review = (ctx: Ctx, ids: { propertyId: string; revisionId: string }, status: 'approved' | 'rejected', reason?: string) =>
  ctx.service.reviewForAdmin(ids.propertyId, ids.revisionId, ctx.world.revision(ids.revisionId).decisionVersion, status, reason, IDS.admin);
const residential = (overrides: Record<string, unknown> = {}) => {
  const { files, media } = photos(RESIDENTIAL_SLOTS);
  return { dto: legacyPayload({ ...media, ...overrides }), files };
};
const landPayload = (attributes: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  (ctx: Ctx) => dynamicPayload(ctx.land, attributes, { purposeSubcategoryId: IDS.land, amenityCodes: [], ...overrides });

describe('DPF-021 submit re-validates the complete property', () => {
  it('submits a complete pinned draft exactly on its current version', async () => {
    const ctx = world();
    const { dto, files } = residential();
    const ids = await draft(ctx, dto, files);
    const result = await submit(ctx, ids);
    expect(result.revision.status).toBe('pending_review');
    expect(String(ctx.world.property(ids.propertyId).pendingRevisionId)).toBe(ids.revisionId);
  });

  it('rejects required attributes missing from a stored draft at submit', async () => {
    const ctx = world();
    const ids = await draft(ctx, landPayload({ plotShape: 'regular' }, { marketingMode: PropertyMarketingMode.PLATFORM_MANAGED })(ctx));
    delete ctx.world.revision(ids.revisionId).attributes.plotShape;
    const { status, body } = await responseOf(submit(ctx, ids));
    expect(status).toBe(400);
    expect(body).toEqual({ message: expect.any(String), code: PropertyErrorCode.ATTRIBUTES_INVALID, details: { formDefinitionVersionId: String(ctx.land._id), fieldErrors: [{ key: 'plotShape', code: 'REQUIRED', params: {} }] } });
    expect(ctx.world.revision(ids.revisionId).moderationStatus).toBe('draft');
  });

  it('re-checks cross-field rules and catalog codes that became inactive after the draft was saved', async () => {
    const ctx = world();
    const { dto, files } = residential();
    const ids = await draft(ctx, dto, files);
    ctx.world.revision(ids.revisionId).attributes.floor = 9;
    ctx.world.options.find((option) => option.code === 'fully_finished')!.isActive = false;
    const { body } = await responseOf(submit(ctx, ids));
    expect(body.details.fieldErrors).toEqual([
      { key: 'floor', code: 'CROSS_FIELD', params: { rule: 'floorNotAboveTotalFloors', relatedKeys: ['totalFloors'] } },
      { key: 'finishingStatus', code: 'OPTION_INVALID', params: {} },
    ]);
  });

  it('fails submit when a selected type was deactivated or its definition archived', async () => {
    const ctx = world();
    const { dto, files } = residential({ purposeSubcategoryIds: [IDS.apartment, IDS.duplex] });
    const ids = await draft(ctx, dto, files);
    ctx.world.forms.archive(IDS.duplex);
    expect((await responseOf(submit(ctx, ids))).body).toMatchObject({ code: PropertyErrorCode.FORM_DEFINITION_ARCHIVED, details: { purposeSubcategoryId: IDS.duplex } });
    ctx.world.propertyTypes.find((type) => String(type._id) === IDS.duplex)!.isActive = false;
    expect((await responseOf(submit(ctx, ids))).body).toMatchObject({ code: PropertyErrorCode.SUBCATEGORIES_INVALID, details: { reason: 'INACTIVE', invalidIds: [IDS.duplex] } });
  });
});

describe('DPF-021 form version freshness', () => {
  it('rejects a draft pinned to a replaced primary version with 409 and never upgrades it', async () => {
    const ctx = world();
    const { dto, files } = residential();
    const ids = await draft(ctx, dto, files);
    const before = JSON.stringify(ctx.world.revision(ids.revisionId));
    const current = ctx.world.forms.publish(IDS.apartment, { fields: VILLA_V2_FIELDS });
    const { status, body } = await responseOf(submit(ctx, ids));
    expect(status).toBe(409);
    expect(body).toEqual({
      message: expect.any(String),
      code: PropertyErrorCode.FORM_VERSION_OUTDATED,
      details: {
        purposeSubcategoryId: IDS.apartment, definitionId: String(current.definitionId),
        submittedVersionId: String(ctx.apartment._id), submittedVersion: 1,
        currentVersionId: String(current._id), currentVersion: 2, currentContentHash: current.contentHash, rendererVersion: 1,
      },
    });
    // No automatic upgrade, remap or submission against the stale version.
    expect(JSON.stringify(ctx.world.revision(ids.revisionId))).toBe(before);
    expect(ctx.world.property(ids.propertyId).pendingRevisionId).toBeUndefined();

    // Re-saving on the current version (what the client does after remapping) submits.
    await ctx.service.createDraftRevision(IDS.user, ids.propertyId, { ...dynamicPayload(current, { ...APARTMENT_ATTRIBUTES, hasGarden: false }), ...photos(RESIDENTIAL_SLOTS).media, expectedRevisionVersion: 0 }, photos(RESIDENTIAL_SLOTS).files);
    await expect(submit(ctx, ids)).resolves.toMatchObject({ revision: { status: 'pending_review' } });
  });

  it('ignores republished additional types: only the primary type\'s version can make a draft stale', async () => {
    const ctx = world();
    const { dto, files } = residential({ purposeSubcategoryIds: [IDS.apartment, IDS.duplex, IDS.land] });
    const ids = await draft(ctx, dto, files);
    ctx.world.forms.publish(IDS.duplex, { fields: VILLA_V2_FIELDS });
    ctx.world.forms.publish(IDS.land, { fields: LAND_FIELDS.slice(0, 2), mediaProfile: 'generic', amenitiesEnabled: false });
    await expect(submit(ctx, ids)).resolves.toMatchObject({ revision: { status: 'pending_review' } });
  });

  it('submits a legacy draft saved before pinning only while the current version is still the legacy form', async () => {
    const ctx = world();
    const { dto, files } = residential();
    const ids = await draft(ctx, dto, files);
    const stored = ctx.world.revision(ids.revisionId);
    for (const key of ['formDefinitionId', 'formDefinitionVersionId', 'formDefinitionVersion', 'formContentHash', 'attributes']) delete stored[key];
    Object.assign(stored, { bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatusCode: 'fully_finished', deliveryStatusCode: 'immediate' });

    const current = ctx.world.forms.publish(IDS.apartment, { fields: VILLA_V2_FIELDS });
    const { status, body } = await responseOf(submit(ctx, ids));
    expect(status).toBe(409);
    expect(body.details).toMatchObject({ submittedVersionId: null, submittedVersion: null, currentVersionId: String(current._id) });

    const fresh = world();
    const legacyIds = await draft(fresh, residential().dto, residential().files);
    const legacyDraft = fresh.world.revision(legacyIds.revisionId);
    for (const key of ['formDefinitionId', 'formDefinitionVersionId', 'formDefinitionVersion', 'formContentHash', 'attributes']) delete legacyDraft[key];
    Object.assign(legacyDraft, { bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatusCode: 'fully_finished', deliveryStatusCode: 'immediate' });
    await expect(submit(fresh, legacyIds)).resolves.toMatchObject({ revision: { status: 'pending_review' } });
    // Still a legacy revision: submit never pins or rewrites it.
    expect(fresh.world.revision(legacyIds.revisionId).formDefinitionVersionId).toBeUndefined();
  });

  it('blocks submit of a draft whose primary definition was archived meanwhile', async () => {
    const ctx = world();
    const ids = await draft(ctx, landPayload({ plotShape: 'regular' }, { marketingMode: PropertyMarketingMode.PLATFORM_MANAGED })(ctx));
    ctx.world.forms.archive(IDS.land);
    expect((await responseOf(submit(ctx, ids))).body).toMatchObject({ code: PropertyErrorCode.FORM_DEFINITION_ARCHIVED, details: { purposeSubcategoryId: IDS.land } });
  });
});

describe('DPF-022 media completeness from the primary form\'s media profile', () => {
  describe('residential_rooms', () => {
    it('saves a draft with incomplete photos, then enforces today\'s required slots at submit', async () => {
      const ctx = world();
      const partial = RESIDENTIAL_SLOTS.filter((slot) => !['kitchen_1', 'bathroom_2'].includes(slot));
      const { files, media } = photos(partial);
      const ids = await draft(ctx, legacyPayload(media), files);
      expect(ctx.world.revision(ids.revisionId).galleryMedia.map((asset: any) => asset.slotId)).toEqual(partial);
      const { status, body } = await responseOf(submit(ctx, ids));
      expect(status).toBe(400);
      expect(body).toEqual({ message: 'لا يمكن نشر العقار قبل استكمال صور العرض المطلوبة', code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING, details: { missingPhotoSlots: ['kitchen_1', 'bathroom_2'] } });
    });

    it('saves a SELF_SERVICE draft with no photos at all', async () => {
      const ctx = world();
      const ids = await draft(ctx, legacyPayload());
      expect(ctx.world.revision(ids.revisionId).galleryMedia).toEqual([]);
      expect((await responseOf(submit(ctx, ids))).body.details).toEqual({ missingPhotoSlots: RESIDENTIAL_SLOTS, minPhotos: 2, photoCount: 0 });
    });

    it('rejects invalid slot ids and reused content at draft save, with the DPF-003 details', async () => {
      const ctx = world();
      const invalid = photos([...RESIDENTIAL_SLOTS.slice(0, 3), 'garage_1']);
      const invalidResponse = await responseOf(ctx.service.create(IDS.user, legacyPayload(invalid.media), invalid.files));
      expect(invalidResponse.body).toEqual({
        message: 'يجب استكمال جميع فئات صور العقار المطلوبة', code: 'PROPERTY_REQUIRED_PHOTO_SLOTS_MISSING',
        details: { missingPhotoSlots: RESIDENTIAL_SLOTS.slice(3), invalidPhotoSlots: ['garage_1'] },
      });
      const duplicate = photos(RESIDENTIAL_SLOTS);
      duplicate.files.images[1] = duplicate.files.images[0];
      const duplicateResponse = await responseOf(ctx.service.create(IDS.user, legacyPayload(duplicate.media), duplicate.files));
      expect(duplicateResponse.body).toEqual({ message: 'يجب استخدام صورة مستقلة لكل قسم مطلوب', code: 'PROPERTY_PHOTO_SLOT_MEDIA_DUPLICATED', details: { duplicatePhotoSlots: ['exterior', 'entrance'] } });
      expect(ctx.world.revisions).toHaveLength(0);
    });

    it('re-checks duplicate content and unknown slots at submit', async () => {
      const ctx = world();
      const { dto, files } = residential();
      const ids = await draft(ctx, dto, files);
      const gallery = ctx.world.revision(ids.revisionId).galleryMedia;
      gallery[3].contentDigest = gallery[2].contentDigest;
      expect((await responseOf(submit(ctx, ids))).body).toEqual({ message: expect.any(String), code: 'PROPERTY_PHOTO_SLOT_MEDIA_DUPLICATED', details: { duplicatePhotoSlots: ['living_1', 'bedroom_1'] } });
      gallery[3].contentDigest = 'a'.repeat(64);
      gallery.push({ ...gallery[0], slotId: 'garage_1', contentDigest: 'b'.repeat(64) });
      expect((await responseOf(submit(ctx, ids))).body.details).toEqual({ missingPhotoSlots: [], invalidPhotoSlots: ['garage_1'] });
    });

    it('derives required slots and tags from the pinned attributes, identical to today', async () => {
      const ctx = world();
      const slots = ['exterior', 'entrance', 'living_1', 'living_2', 'bedroom_1', 'kitchen_1', 'bathroom_1', 'additional_1'];
      const { files, media } = photos(slots);
      const ids = await draft(ctx, dynamicPayload(ctx.apartment, { ...APARTMENT_ATTRIBUTES, livingRooms: 2, bedrooms: 1, bathrooms: 1 }, media), files);
      expect(ctx.world.revision(ids.revisionId).galleryMedia.map((asset: any) => asset.tagCode)).toEqual([
        PropertyMediaTagCode.EXTERIOR, PropertyMediaTagCode.ENTRANCE, PropertyMediaTagCode.LIVING_ROOM, PropertyMediaTagCode.LIVING_ROOM,
        PropertyMediaTagCode.BEDROOM, PropertyMediaTagCode.KITCHEN, PropertyMediaTagCode.BATHROOM, PropertyMediaTagCode.OTHER,
      ]);
      await expect(submit(ctx, ids)).resolves.toMatchObject({ revision: { status: 'pending_review' } });
    });
  });

  describe('generic', () => {
    it('has no required slots: a draft with no photos saves, submit needs the one-photo minimum', async () => {
      const ctx = world();
      const ids = await draft(ctx, landPayload({ plotShape: 'regular' })(ctx));
      const { status, body } = await responseOf(submit(ctx, ids));
      expect(status).toBe(400);
      expect(body).toEqual({ message: expect.any(String), code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING, details: { missingPhotoSlots: [], minPhotos: 1, photoCount: 0 } });

      const { files, media } = photos(['additional_1']);
      await ctx.service.createDraftRevision(IDS.user, ids.propertyId, { ...landPayload({ plotShape: 'regular' })(ctx), ...media, expectedRevisionVersion: 0 }, files);
      await expect(submit(ctx, ids)).resolves.toMatchObject({ revision: { status: 'pending_review' } });
    });

    it('treats residential slot ids as invalid for a generic form', async () => {
      const ctx = world();
      const { files, media } = photos(['exterior', 'additional_1']);
      const { body } = await responseOf(ctx.service.create(IDS.user, landPayload({ plotShape: 'regular' }, media)(ctx), files));
      expect(body).toMatchObject({ code: 'PROPERTY_REQUIRED_PHOTO_SLOTS_MISSING', details: { missingPhotoSlots: [], invalidPhotoSlots: ['exterior'] } });
    });

    it('is never influenced by an additional residential type', async () => {
      const ctx = world();
      const { files, media } = photos(['additional_1']);
      const ids = await draft(ctx, landPayload({ plotShape: 'regular' }, { ...media, purposeSubcategoryIds: [IDS.land, IDS.apartment] })(ctx), files);
      await expect(submit(ctx, ids)).resolves.toMatchObject({ revision: { status: 'pending_review' } });
    });
  });

  describe('PLATFORM_MANAGED', () => {
    it('keeps today\'s behavior: no photos needed to save or submit, one photo needed to approve', async () => {
      const ctx = world();
      const ids = await draft(ctx, legacyPayload({ marketingMode: PropertyMarketingMode.PLATFORM_MANAGED }));
      await submit(ctx, ids);
      const { body } = await responseOf(review(ctx, ids, 'approved'));
      expect(body).toMatchObject({ code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING });
      ctx.world.revision(ids.revisionId).galleryMedia = [{ publicId: 'p', resourceType: 'image', url: 'https://cdn.example/p.png', mediaId: 'm', origin: 'platform', tagCode: 'other' }];
      await review(ctx, ids, 'approved');
      expect(ctx.world.revision(ids.revisionId).moderationStatus).toBe('approved');
    });
  });

  it('reports profile-based completeness to Admin', async () => {
    const ctx = world();
    const land = await draft(ctx, landPayload({ plotShape: 'regular' }, photos(['additional_1']).media)(ctx), photos(['additional_1']).files);
    await submit(ctx, land);
    const landView = await ctx.service.getForAdmin(land.propertyId);
    expect(landView.property.pendingRevision.mediaCompleteness).toEqual({ mediaProfile: 'generic', requiredPhotoSlots: [], missingPhotoSlots: [], minimumPhotoCount: 1, photoCount: 1, complete: true });

    const partial = photos(RESIDENTIAL_SLOTS.slice(0, 8));
    const flat = await draft(ctx, legacyPayload(partial.media), partial.files);
    const flatView = await ctx.service.getForAdmin(flat.propertyId);
    expect(flatView.property.revisions[0].mediaCompleteness).toEqual({ mediaProfile: 'residential_rooms', requiredPhotoSlots: RESIDENTIAL_SLOTS, missingPhotoSlots: ['bathroom_2'], minimumPhotoCount: 9, photoCount: 8, complete: false });
  });
});

describe('DPF-023 approval synchronizes the aggregate and facets', () => {
  const approve = async (ctx: Ctx, dto: any, files: any = {}) => {
    const ids = await draft(ctx, dto, files);
    await submit(ctx, ids);
    await review(ctx, ids, 'approved');
    return ids;
  };

  it('copies the approved revision\'s facts and bedrooms facet in the single transactional aggregate update', async () => {
    const ctx = world();
    const { files, media } = photos(['exterior', 'entrance', 'living_1', 'bedroom_1', 'bedroom_2', 'bedroom_3', 'bedroom_4', 'kitchen_1', 'bathroom_1', 'bathroom_2']);
    const ids = await draft(ctx, dynamicPayload(ctx.villa, { ...APARTMENT_ATTRIBUTES, bedrooms: 4, hasGarden: true }, { ...media, purposeSubcategoryId: IDS.villa, purposeSubcategoryIds: [IDS.villa, IDS.duplex], area: 320, operationType: 'rent' }), files);
    await submit(ctx, ids);
    ctx.world.writes.length = 0;
    await review(ctx, ids, 'approved');
    const aggregateWrites = ctx.world.writes.filter((write) => write.collection === 'properties');
    expect(aggregateWrites).toHaveLength(1);
    expect(aggregateWrites[0]).toMatchObject({ op: 'updateOne', inTransaction: true });
    const property = ctx.world.property(ids.propertyId);
    expect(property).toMatchObject({ status: 'approved', area: 320, operationType: 'rent', propertyTypeCode: 'villa', facets: { bedrooms: 4 } });
    expect(String(property.purposeSubcategoryId)).toBe(IDS.villa);
    expect(property.purposeSubcategoryIds.map(String)).toEqual([IDS.duplex, IDS.villa]);
    expect(String(property.currentPublicRevisionId)).toBe(ids.revisionId);
    // Only the typed facet; no other attribute reaches the aggregate.
    expect(property.facets).toEqual({ bedrooms: 4 });
    expect(property.hasGarden).toBeUndefined();
    expect(property.attributes).toBeUndefined();
  });

  it('omits the facet (no zero, no default) for a form without bedrooms, and removes a previous one', async () => {
    const ctx = world();
    const { files, media } = photos(RESIDENTIAL_SLOTS);
    const ids = await approve(ctx, legacyPayload(media), files);
    expect(ctx.world.property(ids.propertyId).facets).toEqual({ bedrooms: 3 });
    // The owner changes the primary type to land; the land form has no bedrooms field.
    const land = photos(['additional_1']);
    await ctx.service.createDraftRevision(IDS.user, ids.propertyId, { ...landPayload({ plotShape: 'regular' })(ctx), ...land.media }, land.files);
    const next = ctx.world.revisions.find((revision) => revision.moderationStatus === 'draft')!;
    await submit(ctx, { propertyId: ids.propertyId, revisionId: String(next._id) });
    await review(ctx, { propertyId: ids.propertyId, revisionId: String(next._id) }, 'approved');
    expect(ctx.world.property(ids.propertyId)).not.toHaveProperty('facets');
  });

  it('derives the same facet from a legacy (unpinned) revision\'s flat bedrooms', async () => {
    const ctx = world();
    const ids = await draft(ctx, legacyPayload({ marketingMode: PropertyMarketingMode.PLATFORM_MANAGED }));
    await submit(ctx, ids);
    const pending = ctx.world.revision(ids.revisionId);
    for (const key of ['formDefinitionId', 'formDefinitionVersionId', 'formDefinitionVersion', 'formContentHash', 'attributes']) delete pending[key];
    Object.assign(pending, { bedrooms: 2, livingRooms: 1, kitchens: 1, bathrooms: 1, galleryMedia: [{ publicId: 'p', resourceType: 'image', url: 'https://cdn.example/p.png' }] });
    await review(ctx, ids, 'approved');
    expect(ctx.world.property(ids.propertyId).facets).toEqual({ bedrooms: 2 });
  });

  it('changes no aggregate facts or facets on rejection', async () => {
    const ctx = world();
    const { files, media } = photos(RESIDENTIAL_SLOTS);
    const ids = await approve(ctx, legacyPayload(media), files);
    const next = await ctx.service.createDraftRevision(IDS.user, ids.propertyId, { ...dynamicPayload(ctx.apartment, { ...APARTMENT_ATTRIBUTES, bedrooms: 7 }), ...photos(['exterior', 'entrance', 'living_1', ...[1, 2, 3, 4, 5, 6, 7].map((n) => `bedroom_${n}`), 'kitchen_1', 'bathroom_1', 'bathroom_2']).media, area: 999 },
      photos(['exterior', 'entrance', 'living_1', ...[1, 2, 3, 4, 5, 6, 7].map((n) => `bedroom_${n}`), 'kitchen_1', 'bathroom_1', 'bathroom_2']).files);
    const nextIds = { propertyId: ids.propertyId, revisionId: next.property.revisionId };
    await submit(ctx, nextIds);
    const before = { ...ctx.world.property(ids.propertyId) };
    await review(ctx, nextIds, 'rejected', 'صور غير واضحة');
    const after = ctx.world.property(ids.propertyId);
    expect(after.facets).toEqual({ bedrooms: 3 });
    expect(after.area).toBe(before.area);
    expect(String(after.currentPublicRevisionId)).toBe(ids.revisionId);
  });

  it('approves a pending revision pinned to a version superseded after it was submitted', async () => {
    const ctx = world();
    const { files, media } = photos(RESIDENTIAL_SLOTS);
    const ids = await draft(ctx, legacyPayload(media), files);
    await submit(ctx, ids);
    ctx.world.forms.publish(IDS.apartment, { fields: VILLA_V2_FIELDS });
    // No currency or catalog-active check at approval (frozen §C).
    ctx.world.options.find((option) => option.code === 'fully_finished')!.isActive = false;
    await review(ctx, ids, 'approved');
    expect(ctx.world.revision(ids.revisionId).moderationStatus).toBe('approved');
    expect(ctx.world.property(ids.propertyId).facets).toEqual({ bedrooms: 3 });
  });

  it('re-validates the pinned structure at approval and rolls back when it fails', async () => {
    const ctx = world();
    const { files, media } = photos(RESIDENTIAL_SLOTS);
    const ids = await draft(ctx, legacyPayload(media), files);
    await submit(ctx, ids);
    ctx.world.revision(ids.revisionId).attributes.bedrooms = '3';
    const { body } = await responseOf(review(ctx, ids, 'approved'));
    expect(body).toMatchObject({ code: PropertyErrorCode.ATTRIBUTES_INVALID, details: { fieldErrors: [{ key: 'bedrooms', code: 'TYPE_MISMATCH', params: { expected: 'integer' } }] } });
    expect(ctx.world.revision(ids.revisionId).moderationStatus).toBe('pending_review');
    expect(ctx.world.property(ids.propertyId).facets).toBeUndefined();
  });
});

describe('DPF-023 read compatibility after approval', () => {
  it('keeps an auction anchored to its revision\'s specifications after a newer revision is approved', async () => {
    const ctx = world();
    const { files, media } = photos(RESIDENTIAL_SLOTS);
    const first = await draft(ctx, legacyPayload(media), files);
    await submit(ctx, first);
    await review(ctx, first, 'approved');

    const next = photos(['exterior', 'entrance', 'living_1', 'bedroom_1', 'bedroom_2', 'bedroom_3', 'bedroom_4', 'kitchen_1', 'bathroom_1', 'bathroom_2']);
    const second = await ctx.service.createDraftRevision(IDS.user, first.propertyId, { ...dynamicPayload(ctx.apartment, { ...APARTMENT_ATTRIBUTES, bedrooms: 4 }), ...next.media }, next.files);
    const secondIds = { propertyId: first.propertyId, revisionId: second.property.revisionId };
    await submit(ctx, secondIds);
    await review(ctx, secondIds, 'approved');

    const anchored = await ctx.service.getAnchoredPublicProjections([{ propertyId: first.propertyId, revisionId: first.revisionId }], { specifications: true });
    const specs = anchored.get(`${first.propertyId}:${first.revisionId}`).specifications;
    expect(specs.items.find((item: any) => item.key === 'bedrooms').value).toBe(3);
    const published = await ctx.service.getPublished(first.propertyId);
    expect(published.property.specifications.items.find((item: any) => item.key === 'bedrooms').value).toBe(4);
    expect(ctx.world.property(first.propertyId).facets).toEqual({ bedrooms: 4 });
  });

  it('keeps reading an approved revision through its own pinned version after the form changes', async () => {
    const ctx = world();
    const { files, media } = photos(RESIDENTIAL_SLOTS);
    const ids = await draft(ctx, legacyPayload(media), files);
    await submit(ctx, ids);
    await review(ctx, ids, 'approved');
    ctx.world.forms.publish(IDS.apartment, { fields: [...LEGACY_RESIDENTIAL_FIELDS.map((field) => ({ ...field, labelAr: `${field.labelAr} (جديد)` }))] });
    const published = await ctx.service.getPublished(ids.propertyId);
    expect(published.property.specifications).toMatchObject({ source: 'definition', formDefinitionVersion: 1 });
    expect(published.property.specifications.items[0]).toMatchObject({ key: 'bedrooms', labelAr: 'غرف النوم', value: 3 });
    expect(new Types.ObjectId(published.property.specifications.formDefinitionVersionId).equals(ctx.apartment._id)).toBe(true);
  });
});
