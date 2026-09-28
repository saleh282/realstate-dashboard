import type { FieldDefinition } from '../src/property-form-definitions/property-form-definition.constants';
import { IDS, PropertyWorld, dynamicPayload, photos } from './support/property-world';

/**
 * Phase 9 (Search & Facets): approval-time facet sync end-to-end through the
 * real create -> submit -> reviewForAdmin service flow (not just the pure
 * `approvedFacets()` unit), proving: atomic whole-object replace, a primary
 * type change clears stale facet keys, a field dropped by a newer published
 * form version disappears from facets after re-approval, an unsubmitted
 * draft never touches live `Property.facets`, and an additional (non-primary)
 * type's attributes are never a source of facets.
 */

const SHOP_LIKE_FIELDS: FieldDefinition[] = [
  { key: 'shopFloorLevel', dataType: 'singleSelect', optionSource: 'inline', labelAr: 'مستوى المحل', required: false, order: 10, options: [
    { code: 'ground', labelAr: 'الدور الأرضي', order: 1 }, { code: 'basement', labelAr: 'البدروم', order: 2 }, { code: 'upper', labelAr: 'دور علوي', order: 3 },
  ] },
  { key: 'commercialUseTypes', dataType: 'multiSelect', optionSource: 'inline', labelAr: 'الاستخدامات التجارية', required: false, order: 20, validation: { maxItems: 6 }, options: [
    { code: 'retail', labelAr: 'تجزئة', order: 1 }, { code: 'food', labelAr: 'مطاعم', order: 2 },
  ] },
];
const COMMERCIAL_USE_ONLY_FIELDS: FieldDefinition[] = SHOP_LIKE_FIELDS.filter((field) => field.key === 'commercialUseTypes');
const FACTORY_LIKE_FIELDS: FieldDefinition[] = [
  { key: 'builtAreaSqm', dataType: 'decimal', unit: 'sqm', labelAr: 'المساحة المبنية', required: false, order: 10, validation: { min: 0, max: 1_000_000, scale: 2 } },
  { key: 'powerSource', dataType: 'singleSelect', optionSource: 'inline', labelAr: 'مصدر الكهرباء', required: false, order: 20, options: [
    { code: 'grid', labelAr: 'كهرباء عامة', order: 1 }, { code: 'generator', labelAr: 'مولد', order: 2 },
  ] },
];

function world() {
  const value = new PropertyWorld();
  const shop = value.forms.publish(IDS.land, { fields: SHOP_LIKE_FIELDS, mediaProfile: 'generic', amenitiesEnabled: false });
  return { world: value, service: value.service as any, shop };
}
type Ctx = ReturnType<typeof world>;

const shopPayload = (attributes: Record<string, unknown>, overrides: Record<string, unknown> = {}) => (ctx: Ctx) => {
  const { files, media } = photos(['additional_1']);
  return { dto: dynamicPayload(ctx.shop, attributes, { purposeSubcategoryId: IDS.land, purposeCategoryId: IDS.purpose, amenityCodes: [], ...media, ...overrides }), files };
};

async function createSubmitApprove(ctx: Ctx, attributes: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const { dto, files } = shopPayload(attributes, overrides)(ctx);
  const created = await ctx.service.create(IDS.user, dto, files);
  const propertyId = created.property.id as string;
  const revisionId = created.property.revisionId as string;
  await ctx.service.submitRevision(IDS.user, propertyId, revisionId, ctx.world.revision(revisionId).decisionVersion);
  await ctx.service.reviewForAdmin(propertyId, revisionId, ctx.world.revision(revisionId).decisionVersion, 'approved', undefined, IDS.admin);
  return { propertyId, revisionId };
}

describe('Phase 9 approval-time facet sync (end-to-end through the real service flow)', () => {
  it('approval atomically sets Property.facets from the approved revision (whole-object)', async () => {
    const ctx = world();
    const { propertyId } = await createSubmitApprove(ctx, { shopFloorLevel: 'ground', commercialUseTypes: ['retail', 'food'] });
    expect(ctx.world.property(propertyId).facets).toEqual({ shopFloorLevel: 'ground', commercialUseTypes: ['retail', 'food'] });
  });

  it('rejection never sets or touches Property.facets', async () => {
    const ctx = world();
    const { dto, files } = shopPayload({ shopFloorLevel: 'ground' })(ctx);
    const created = await ctx.service.create(IDS.user, dto, files);
    const propertyId = created.property.id as string;
    const revisionId = created.property.revisionId as string;
    await ctx.service.submitRevision(IDS.user, propertyId, revisionId, ctx.world.revision(revisionId).decisionVersion);
    await ctx.service.reviewForAdmin(propertyId, revisionId, ctx.world.revision(revisionId).decisionVersion, 'rejected', 'بيانات غير مكتملة', IDS.admin);
    expect(ctx.world.property(propertyId).facets).toBeUndefined();
  });

  it('an unsubmitted draft edit never affects the live approved Property.facets', async () => {
    const ctx = world();
    const { propertyId } = await createSubmitApprove(ctx, { shopFloorLevel: 'ground' });
    expect(ctx.world.property(propertyId).facets).toEqual({ shopFloorLevel: 'ground' });

    // Start (but never submit) an edit that would change the facet-bearing attribute.
    const { dto, files } = shopPayload({ shopFloorLevel: 'upper' })(ctx);
    await ctx.service.createDraftRevision(IDS.user, propertyId, dto, files);

    expect(ctx.world.property(propertyId).facets).toEqual({ shopFloorLevel: 'ground' }); // unchanged
  });

  it('a field dropped by a newer published form version disappears from facets after re-approval', async () => {
    const ctx = world();
    const { propertyId } = await createSubmitApprove(ctx, { shopFloorLevel: 'ground', commercialUseTypes: ['retail'] });
    expect(ctx.world.property(propertyId).facets).toEqual({ shopFloorLevel: 'ground', commercialUseTypes: ['retail'] });

    // Publish v2 of the same type's form, dropping shopFloorLevel entirely.
    const v2 = ctx.world.forms.publish(IDS.land, { fields: COMMERCIAL_USE_ONLY_FIELDS, mediaProfile: 'generic', amenitiesEnabled: false });
    const { files, media } = photos(['additional_1']);
    const editDto = dynamicPayload(v2, { commercialUseTypes: ['food'] }, { purposeSubcategoryId: IDS.land, purposeCategoryId: IDS.purpose, amenityCodes: [], ...media });
    const edited = await ctx.service.createDraftRevision(IDS.user, propertyId, editDto, files);
    const revisionId = edited.property.revisionId as string;
    await ctx.service.submitRevision(IDS.user, propertyId, revisionId, ctx.world.revision(revisionId).decisionVersion);
    await ctx.service.reviewForAdmin(propertyId, revisionId, ctx.world.revision(revisionId).decisionVersion, 'approved', undefined, IDS.admin);

    expect(ctx.world.property(propertyId).facets).toEqual({ commercialUseTypes: ['food'] });
    expect(ctx.world.property(propertyId).facets).not.toHaveProperty('shopFloorLevel');
  });

  it('a primary type change clears stale facet keys entirely (whole-object replace, never a merge)', async () => {
    const ctx = world();
    ctx.world.forms.publish(IDS.villa, { fields: FACTORY_LIKE_FIELDS, mediaProfile: 'generic', amenitiesEnabled: false });
    const factoryVersion = ctx.world.forms.current(IDS.villa);
    const { propertyId } = await createSubmitApprove(ctx, { shopFloorLevel: 'ground', commercialUseTypes: ['retail'] });
    expect(ctx.world.property(propertyId).facets).toEqual({ shopFloorLevel: 'ground', commercialUseTypes: ['retail'] });

    // Edit switches the primary type from land (shop-like) to villa (factory-like).
    const { files, media } = photos(['additional_1']);
    const editDto = dynamicPayload(factoryVersion, { builtAreaSqm: 500, powerSource: 'grid' }, {
      purposeSubcategoryId: IDS.villa, purposeSubcategoryIds: [IDS.villa], purposeCategoryId: IDS.purpose, amenityCodes: [], ...media,
    });
    const edited = await ctx.service.createDraftRevision(IDS.user, propertyId, editDto, files);
    const revisionId = edited.property.revisionId as string;
    await ctx.service.submitRevision(IDS.user, propertyId, revisionId, ctx.world.revision(revisionId).decisionVersion);
    await ctx.service.reviewForAdmin(propertyId, revisionId, ctx.world.revision(revisionId).decisionVersion, 'approved', undefined, IDS.admin);

    expect(ctx.world.property(propertyId).facets).toEqual({ builtAreaSqm: 500, powerSource: 'grid' });
    expect(ctx.world.property(propertyId).facets).not.toHaveProperty('shopFloorLevel');
    expect(ctx.world.property(propertyId).facets).not.toHaveProperty('commercialUseTypes');
  });

  it('a multi-type listing derives facets only from the PRIMARY type; the additional type never contributes or merges', async () => {
    const ctx = world();
    // IDS.villa keeps its default legacy residential form (bedrooms, etc.) as the additional, listing-enabled type.
    const { dto, files } = shopPayload(
      { shopFloorLevel: 'basement' },
      { purposeSubcategoryIds: [IDS.land, IDS.villa] },
    )(ctx);
    const created = await ctx.service.create(IDS.user, dto, files);
    const propertyId = created.property.id as string;
    const revisionId = created.property.revisionId as string;
    await ctx.service.submitRevision(IDS.user, propertyId, revisionId, ctx.world.revision(revisionId).decisionVersion);
    await ctx.service.reviewForAdmin(propertyId, revisionId, ctx.world.revision(revisionId).decisionVersion, 'approved', undefined, IDS.admin);

    expect(ctx.world.property(propertyId).facets).toEqual({ shopFloorLevel: 'basement' });
    // No bedrooms/livingRooms/etc. leaked in from villa (the additional, non-primary type).
    expect(Object.keys(ctx.world.property(propertyId).facets)).toEqual(['shopFloorLevel']);
  });
});
