'use strict';

const { PropertyErrorCode } = require('../src/common/errors/property-error-codes');
const { Types } = require('mongoose');
const {
  buildDraftContent,
  diffFormContent,
  publishableContent,
  storedContent,
  validateFormContent,
  FormDraftErrorCode,
} = require('../src/domain/property-form-definitions/form-definition-drafts');
const {
  CURRENT_RENDERER_VERSION,
  LEGACY_RESIDENTIAL_CONTENT,
  LEGACY_RESIDENTIAL_CONTENT_HASH,
  SHIPPED_MEDIA_PROFILES,
  computeFormContentHash,
  computeLegacyWritable,
} = require('../src/domain/property-form-definitions/property-form-definition.constants');
const {
  assertAmenitySelection,
  amenityNotAllowed,
  amenitiesNotEnabled,
} = require('../src/domain/properties/property-form-write');
const {
  MEDIA_PROFILE_DEFINITIONS,
  mediaRequirements,
} = require('../src/domain/properties/media-profiles');
const { PHASE9_PROMOTED_FACET_KEYS } = require('../src/migrations/030-phase9-facet-promotion');
const {
  PROPERTY_ATTRIBUTE_FACET_KEYS,
} = require('../src/domain/property-attributes/property-attribute.constants');
const {
  PHASE11_NEW_AMENITY_SEED,
  PHASE11_PRE_EXISTING_AMENITY_CODES,
} = require('../src/migrations/033-phase11-amenity-catalog');
const {
  IDS,
  LAND_FIELDS,
  PropertyWorld,
  dynamicPayload,
  legacyPayload,
  photos,
} = require('./support/property-world');
/**
 * Phase 11 (Type-Aware Amenities): `allowedAmenityCodes` on FormVersionContent
 * — persistence, canonicalization, content hash, diff, validation, and the
 * property-write enforcement it drives. Also a regression proof that Phase 11
 * changed nothing about shipped media profiles or search/facet scope.
 */
const catalog = (entries) => new Map(entries.map(([code, isActive]) => [code, { code, isActive }]));
const registry = new Map();
function baseContent(overrides = {}) {
  return {
    rendererVersion: CURRENT_RENDERER_VERSION,
    fields: [],
    mediaProfile: 'generic',
    amenitiesEnabled: true,
    ...overrides,
  };
}
describe('Phase 11: FormVersionContent.allowedAmenityCodes — hash, canonicalization, legacy-writable', () => {
  it('is not hashed when absent: every version published before Phase 11 hashes exactly as before', () => {
    expect(computeFormContentHash(LEGACY_RESIDENTIAL_CONTENT)).toBe(
      LEGACY_RESIDENTIAL_CONTENT_HASH,
    );
    const withUndefined = computeFormContentHash({
      ...LEGACY_RESIDENTIAL_CONTENT,
      allowedAmenityCodes: undefined,
    });
    expect(withUndefined).toBe(LEGACY_RESIDENTIAL_CONTENT_HASH);
  });
  it('participates in the hash when present, and an empty array hashes differently from absent', () => {
    const absent = computeFormContentHash(baseContent());
    const empty = computeFormContentHash(baseContent({ allowedAmenityCodes: [] }));
    const withCodes = computeFormContentHash(baseContent({ allowedAmenityCodes: ['parking'] }));
    expect(new Set([absent, empty, withCodes]).size).toBe(3);
  });
  it('hashes identically regardless of input order once canonicalized by publishableContent (the path every real caller uses)', () => {
    const a = computeFormContentHash(
      publishableContent({
        fields: [],
        mediaProfile: 'generic',
        amenitiesEnabled: true,
        allowedAmenityCodes: ['security', 'elevator', 'parking'],
      }),
    );
    const b = computeFormContentHash(
      publishableContent({
        fields: [],
        mediaProfile: 'generic',
        amenitiesEnabled: true,
        allowedAmenityCodes: ['parking', 'security', 'elevator'],
      }),
    );
    expect(a).toBe(b);
  });
  it('a version with a restricted amenity list is never legacy-writable', () => {
    expect(
      computeLegacyWritable({ ...LEGACY_RESIDENTIAL_CONTENT, allowedAmenityCodes: ['elevator'] }),
    ).toBe(false);
    expect(computeLegacyWritable(LEGACY_RESIDENTIAL_CONTENT)).toBe(true);
  });
});
describe('Phase 11 representative create, submit, approve and public flows', () => {
  const cases = [
    {
      code: 'shop',
      allowed: [
        'elevator',
        'parking',
        'security',
        'air_conditioning',
        'fire_safety',
        'accessibility',
      ],
      selected: 'accessibility',
      disallowed: 'fenced',
    },
    {
      code: 'office',
      allowed: [
        'elevator',
        'parking',
        'security',
        'air_conditioning',
        'fire_safety',
        'accessibility',
      ],
      selected: 'fire_safety',
      disallowed: 'fenced',
    },
    {
      code: 'factory',
      allowed: ['parking', 'security', 'fire_safety', 'storage_yard'],
      selected: 'fire_safety',
      disallowed: 'elevator',
    },
    {
      code: 'warehouse',
      allowed: ['parking', 'security', 'fire_safety', 'storage_yard'],
      selected: 'storage_yard',
      disallowed: 'elevator',
    },
    {
      code: 'agricultural_land',
      allowed: ['security', 'fenced', 'drainage'],
      selected: 'fenced',
      disallowed: 'parking',
    },
  ];
  it.each(cases)(
    '$code accepts only its allowed amenities through publication',
    async ({ code, allowed, selected, disallowed }) => {
      const world = new PropertyWorld();
      for (const seed of PHASE11_NEW_AMENITY_SEED)
        world.amenityCatalog.push({ ...seed, isActive: true, usageCount: 0 });
      world.amenityCatalog.push(
        {
          code: 'security',
          nameAr: 'أمن',
          nameEn: 'Security',
          iconKey: 'security',
          category: 'service',
          isActive: true,
          usageCount: 0,
        },
        {
          code: 'air_conditioning',
          nameAr: 'تكييف',
          nameEn: 'Air Conditioning',
          iconKey: 'air_conditioning',
          category: 'feature',
          isActive: true,
          usageCount: 0,
        },
      );
      const typeId = new Types.ObjectId().toHexString();
      world.propertyTypes.push({
        _id: new Types.ObjectId(typeId),
        code,
        nameAr: code,
        purposeCategoryId: new Types.ObjectId(IDS.purpose),
        isActive: true,
        sortOrder: 10,
        usageCount: 0,
      });
      const version = world.forms.publish(typeId, {
        fields: LAND_FIELDS,
        mediaProfile: 'generic',
        amenitiesEnabled: true,
        allowedAmenityCodes: [...allowed],
      });
      expect(version.allowedAmenityCodes).toEqual(allowed);
      expect(version.mediaProfile).toBe('generic');
      const { files, media } = photos(['additional_1']);
      const payload = (amenityCodes) =>
        dynamicPayload(
          version,
          { plotShape: 'regular' },
          { purposeSubcategoryId: typeId, amenityCodes, ...media },
        );
      const rejection = await world.service.create(IDS.user, payload([disallowed]), files).then(
        () => null,
        (error) => error,
      );
      expect(rejection?.getResponse()).toMatchObject({
        code: PropertyErrorCode.AMENITY_NOT_ALLOWED,
      });
      const created = await world.service.create(IDS.user, payload([selected]), files);
      const propertyId = created.property.id;
      const revisionId = created.property.revisionId;
      await world.service.submitRevision(
        IDS.user,
        propertyId,
        revisionId,
        world.revision(revisionId).decisionVersion,
      );
      await world.service.reviewForAdmin(
        propertyId,
        revisionId,
        world.revision(revisionId).decisionVersion,
        'approved',
        undefined,
        IDS.admin,
      );
      const published = await world.service.getPublished(propertyId);
      expect(String(world.property(propertyId).currentPublicRevisionId)).toBe(revisionId);
      expect(published.property.amenities.map((item) => item.code)).toEqual([selected]);
      expect(published.property.amenityCodes).toBeUndefined();
      expect(published.property.amenities[0]).toMatchObject({
        nameAr: expect.any(String),
        nameEn: expect.any(String),
        iconKey: expect.any(String),
        category: expect.any(String),
      });
    },
  );
});
describe('Phase 11: buildDraftContent/publishableContent/storedContent canonicalization', () => {
  it('sorts allowedAmenityCodes deterministically and preserves an explicit empty array', () => {
    const built = buildDraftContent(
      {
        fields: [],
        mediaProfile: 'generic',
        amenitiesEnabled: true,
        allowedAmenityCodes: ['security', 'elevator'],
      },
      registry,
    );
    expect(built.allowedAmenityCodes).toEqual(['elevator', 'security']);
    const empty = buildDraftContent(
      { fields: [], mediaProfile: 'generic', amenitiesEnabled: true, allowedAmenityCodes: [] },
      registry,
    );
    expect(empty.allowedAmenityCodes).toEqual([]);
    const absent = buildDraftContent(
      { fields: [], mediaProfile: 'generic', amenitiesEnabled: false },
      registry,
    );
    expect(absent.allowedAmenityCodes).toBeUndefined();
  });
  it('publishableContent and storedContent re-canonicalize the same way', () => {
    const draft = {
      fields: [],
      mediaProfile: 'generic',
      amenitiesEnabled: true,
      allowedAmenityCodes: ['security', 'elevator'],
    };
    expect(publishableContent(draft).allowedAmenityCodes).toEqual(['elevator', 'security']);
    expect(storedContent({ ...draft, rendererVersion: 1 }).allowedAmenityCodes).toEqual([
      'elevator',
      'security',
    ]);
  });
});
describe('Phase 11: validateFormContent — allowedAmenityCodes rules', () => {
  // stage: 'draft' throughout — these tests are about the allowedAmenityCodes
  // rules specifically, not the unrelated "a published form needs a field" rule.
  const draftStage = { stage: 'draft' };
  it('is silent when the list is absent, regardless of amenitiesEnabled or catalog', () => {
    expect(validateFormContent(baseContent(), registry, draftStage)).toEqual([]);
  });
  it('rejects an unknown amenity code', () => {
    const errors = validateFormContent(baseContent({ allowedAmenityCodes: ['ghost'] }), registry, {
      ...draftStage,
      amenityCatalog: catalog([['parking', true]]),
    });
    expect(errors).toEqual([
      { code: FormDraftErrorCode.AMENITY_CODE_UNKNOWN, property: 'allowedAmenityCodes.ghost' },
    ]);
  });
  it('rejects an inactive amenity code newly added to the list', () => {
    const errors = validateFormContent(
      baseContent({ allowedAmenityCodes: ['retired'] }),
      registry,
      { ...draftStage, amenityCatalog: catalog([['retired', false]]) },
    );
    expect(errors).toEqual([
      { code: FormDraftErrorCode.AMENITY_CODE_INACTIVE, property: 'allowedAmenityCodes.retired' },
    ]);
  });
  it('allows an inactive amenity code that was already in the base (published) version — mirrors deprecated-option grandfathering', () => {
    const errors = validateFormContent(
      baseContent({ allowedAmenityCodes: ['retired'] }),
      registry,
      {
        ...draftStage,
        amenityCatalog: catalog([['retired', false]]),
        baseAllowedAmenityCodes: ['retired'],
      },
    );
    expect(errors).toEqual([]);
  });
  it('rejects a duplicate amenity code (deduplicated like every other identical structured error)', () => {
    const errors = validateFormContent(
      baseContent({ allowedAmenityCodes: ['parking', 'parking'] }),
      registry,
      { ...draftStage, amenityCatalog: catalog([['parking', true]]) },
    );
    expect(errors).toEqual([
      { code: FormDraftErrorCode.AMENITY_CODE_DUPLICATE, property: 'allowedAmenityCodes.parking' },
    ]);
  });
  it('rejects amenitiesEnabled=false with a non-empty allowedAmenityCodes (the chosen, documented invariant)', () => {
    const errors = validateFormContent(
      baseContent({ amenitiesEnabled: false, allowedAmenityCodes: ['parking'] }),
      registry,
      { ...draftStage, amenityCatalog: catalog([['parking', true]]) },
    );
    expect(errors).toEqual([
      {
        code: FormDraftErrorCode.AMENITY_ALLOWED_LIST_NOT_APPLICABLE,
        property: 'allowedAmenityCodes',
      },
    ]);
  });
  it('allows amenitiesEnabled=false with an explicit empty allowedAmenityCodes (consistent either way)', () => {
    const errors = validateFormContent(
      baseContent({ amenitiesEnabled: false, allowedAmenityCodes: [] }),
      registry,
      draftStage,
    );
    expect(errors).toEqual([]);
  });
  it('does not check membership when no catalog is supplied (pure/offline validation)', () => {
    const errors = validateFormContent(
      baseContent({ allowedAmenityCodes: ['anything'] }),
      registry,
      draftStage,
    );
    expect(errors).toEqual([]);
  });
});
describe('Phase 11: diffFormContent reports allowedAmenityCodes changes', () => {
  it('reports a change from absent to a restricted list', () => {
    const before = storedContent({
      fields: [],
      mediaProfile: 'generic',
      amenitiesEnabled: true,
      rendererVersion: 1,
    });
    const after = storedContent({
      fields: [],
      mediaProfile: 'generic',
      amenitiesEnabled: true,
      allowedAmenityCodes: ['parking'],
      rendererVersion: 1,
    });
    const diff = diffFormContent(before, after);
    expect(diff.form).toContainEqual({
      property: 'allowedAmenityCodes',
      before: undefined,
      after: ['parking'],
    });
  });
  it('reports no change when the list is the same set in a different order', () => {
    const before = storedContent({
      fields: [],
      mediaProfile: 'generic',
      amenitiesEnabled: true,
      allowedAmenityCodes: ['parking', 'elevator'],
      rendererVersion: 1,
    });
    const after = storedContent({
      fields: [],
      mediaProfile: 'generic',
      amenitiesEnabled: true,
      allowedAmenityCodes: ['elevator', 'parking'],
      rendererVersion: 1,
    });
    expect(diffFormContent(before, after).form).toEqual([]);
  });
});
describe('Phase 11: assertAmenitySelection — property-write enforcement', () => {
  it('never throws for an empty selection, regardless of the form', () => {
    expect(() => assertAmenitySelection({ amenitiesEnabled: false }, [])).not.toThrow();
  });
  it('throws AMENITIES_NOT_ENABLED for a non-empty selection when disabled', () => {
    expect(() => assertAmenitySelection({ amenitiesEnabled: false }, ['parking'])).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: PropertyErrorCode.AMENITIES_NOT_ENABLED }),
      }),
    );
  });
  it('allows any code (legacy) when enabled and allowedAmenityCodes is absent', () => {
    expect(() =>
      assertAmenitySelection({ amenitiesEnabled: true }, ['parking', 'anything']),
    ).not.toThrow();
  });
  it('allows exactly the listed codes and rejects the rest, naming every disallowed code', () => {
    expect(() =>
      assertAmenitySelection({ amenitiesEnabled: true, allowedAmenityCodes: ['parking'] }, [
        'parking',
      ]),
    ).not.toThrow();
    try {
      assertAmenitySelection({ amenitiesEnabled: true, allowedAmenityCodes: ['parking'] }, [
        'parking',
        'elevator',
        'security',
      ]);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error.response.code).toBe(PropertyErrorCode.AMENITY_NOT_ALLOWED);
      expect(error.response.details.amenityCodes).toEqual(['elevator', 'security']);
    }
  });
  it('rejects everything against an explicit empty allowedAmenityCodes', () => {
    expect(() =>
      assertAmenitySelection({ amenitiesEnabled: true, allowedAmenityCodes: [] }, ['parking']),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: PropertyErrorCode.AMENITY_NOT_ALLOWED }),
      }),
    );
  });
  it('amenityNotAllowed()/amenitiesNotEnabled() carry the exact Phase 11 error codes', () => {
    expect(amenityNotAllowed(['x']).getResponse()).toMatchObject({
      code: PropertyErrorCode.AMENITY_NOT_ALLOWED,
      details: { amenityCodes: ['x'] },
    });
    expect(amenitiesNotEnabled().getResponse()).toMatchObject({
      code: PropertyErrorCode.AMENITIES_NOT_ENABLED,
    });
  });
});
describe('Phase 11: media safety — nothing about shipped media profiles changed', () => {
  it('SHIPPED_MEDIA_PROFILES is still exactly residential_rooms and generic', () => {
    expect([...SHIPPED_MEDIA_PROFILES].sort()).toEqual(['generic', 'residential_rooms']);
  });
  it('no FormDefinition may be published with land/commercial_unit/industrial', () => {
    for (const profile of ['land', 'commercial_unit', 'industrial']) {
      const errors = validateFormContent(baseContent({ mediaProfile: profile }), registry);
      expect(errors).toContainEqual(
        expect.objectContaining({ code: FormDraftErrorCode.MEDIA_PROFILE_UNSUPPORTED }),
      );
    }
  });
  it('residential_rooms and generic media requirements are byte-identical to the pre-Phase-11 shape', () => {
    expect(mediaRequirements('residential_rooms')).toEqual({
      profile: 'residential_rooms',
      minPhotos: 2,
      maxPhotos: 20,
      fixedSlots: [
        {
          slotId: 'exterior',
          tagCode: expect.any(String),
          labelAr: expect.any(String),
          tipAr: expect.any(String),
          iconKey: expect.any(String),
        },
        {
          slotId: 'entrance',
          tagCode: expect.any(String),
          labelAr: expect.any(String),
          tipAr: expect.any(String),
          iconKey: expect.any(String),
        },
      ],
      repeatedSlots: expect.any(Array),
      additionalSlotPrefix: 'additional',
    });
    expect(mediaRequirements('generic')).toEqual({
      profile: 'generic',
      minPhotos: 1,
      maxPhotos: 20,
      fixedSlots: [],
      repeatedSlots: [],
      additionalSlotPrefix: 'additional',
    });
    expect(Object.keys(MEDIA_PROFILE_DEFINITIONS).sort()).toEqual(['generic', 'residential_rooms']);
  });
});
describe('Phase 11: search safety — no facet/search expansion', () => {
  it('PHASE9_PROMOTED_FACET_KEYS is unchanged at exactly 7 keys', () => {
    expect(PHASE9_PROMOTED_FACET_KEYS).toHaveLength(7);
  });
  it('no amenity code is, or ever becomes, a promoted facet key', () => {
    const amenityCodes = [
      ...PHASE11_PRE_EXISTING_AMENITY_CODES,
      ...PHASE11_NEW_AMENITY_SEED.map((seed) => seed.code),
    ];
    for (const code of amenityCodes) expect(PROPERTY_ATTRIBUTE_FACET_KEYS).not.toContain(code);
  });
  it('the 5 new Phase 11 amenities are exactly the approved set', () => {
    expect(PHASE11_NEW_AMENITY_SEED.map((seed) => seed.code).sort()).toEqual(
      ['accessibility', 'drainage', 'fenced', 'fire_safety', 'storage_yard'].sort(),
    );
    // Explicitly never duplicating a concept an existing typed attribute already owns.
    const forbidden = [
      'loading_dock',
      'truck_access',
      'three_phase_power',
      'electricity',
      'water_connection',
      'irrigation',
      'road_access',
    ];
    for (const code of forbidden)
      expect(PHASE11_NEW_AMENITY_SEED.map((seed) => seed.code)).not.toContain(code);
  });
});
describe('Phase 11: end-to-end property-write enforcement and public projection (PropertyWorld)', () => {
  function world() {
    const value = new PropertyWorld();
    const restrictedLand = value.forms.publish(IDS.land, {
      fields: LAND_FIELDS,
      mediaProfile: 'generic',
      amenitiesEnabled: true,
      allowedAmenityCodes: ['parking'],
    });
    return { world: value, service: value.service, restrictedLand };
  }
  const errorOf = async (promise) =>
    promise.then(
      () => {
        throw new Error('expected rejection');
      },
      (error) => error,
    );
  const responseOf = async (promise) => {
    const error = await errorOf(promise);
    return { status: error.getStatus?.(), body: error.getResponse?.() ?? error };
  };
  it('accepts a selection within allowedAmenityCodes at create time', async () => {
    const ctx = world();
    const { files, media } = photos(['additional_1']);
    const result = await ctx.service.create(
      IDS.user,
      dynamicPayload(
        ctx.restrictedLand,
        { plotShape: 'regular' },
        {
          purposeSubcategoryId: IDS.land,
          amenityCodes: ['parking'],
          ...media,
        },
      ),
      files,
    );
    expect(ctx.world.revision(result.property.revisionId).amenityCodes).toEqual(['parking']);
  });
  it('rejects a selection outside allowedAmenityCodes at create time', async () => {
    const ctx = world();
    const { files, media } = photos(['additional_1']);
    const { status, body } = await responseOf(
      ctx.service.create(
        IDS.user,
        dynamicPayload(
          ctx.restrictedLand,
          { plotShape: 'regular' },
          {
            purposeSubcategoryId: IDS.land,
            amenityCodes: ['elevator'],
            ...media,
          },
        ),
        files,
      ),
    );
    expect(status).toBe(400);
    expect(body.code).toBe(PropertyErrorCode.AMENITY_NOT_ALLOWED);
    expect(body.details.amenityCodes).toEqual(['elevator']);
  });
  it('re-enforces allowedAmenityCodes at submit and approval against the still-current version', async () => {
    const ctx = world();
    const { files, media } = photos(['additional_1']);
    const created = await ctx.service.create(
      IDS.user,
      dynamicPayload(
        ctx.restrictedLand,
        { plotShape: 'regular' },
        {
          purposeSubcategoryId: IDS.land,
          amenityCodes: ['parking'],
          ...media,
        },
      ),
      files,
    );
    const ids = { propertyId: created.property.id, revisionId: created.property.revisionId };
    await ctx.service.submitRevision(
      IDS.user,
      ids.propertyId,
      ids.revisionId,
      ctx.world.revision(ids.revisionId).decisionVersion,
    );
    await ctx.service.reviewForAdmin(
      ids.propertyId,
      ids.revisionId,
      ctx.world.revision(ids.revisionId).decisionVersion,
      'approved',
      undefined,
      IDS.admin,
    );
    const published = await ctx.service.getPublished(ids.propertyId);
    expect(published.property.amenities).toEqual([
      {
        code: 'parking',
        nameAr: 'موقف سيارات',
        nameEn: 'Parking',
        iconKey: 'parking',
        category: 'facility',
      },
    ]);
    expect(published.property.amenityCodes).toBeUndefined();
    ctx.world.amenityCatalog.find((amenity) => amenity.code === 'parking').isActive = false;
    expect((await ctx.service.getPublished(ids.propertyId)).property.amenities).toEqual(
      published.property.amenities,
    );
  });
  it("legacy (unrestricted) residential forms keep exactly today's behavior: any active catalog code is allowed and publicly resolved", async () => {
    const ctx = world();
    const { files, media } = photos([
      'exterior',
      'entrance',
      'living_1',
      'bedroom_1',
      'bedroom_2',
      'bedroom_3',
      'kitchen_1',
      'bathroom_1',
      'bathroom_2',
    ]);
    const created = await ctx.service.create(
      IDS.user,
      legacyPayload({ ...media, amenityCodes: ['elevator', 'parking'] }),
      files,
    );
    const ids = { propertyId: created.property.id, revisionId: created.property.revisionId };
    await ctx.service.submitRevision(
      IDS.user,
      ids.propertyId,
      ids.revisionId,
      ctx.world.revision(ids.revisionId).decisionVersion,
    );
    await ctx.service.reviewForAdmin(
      ids.propertyId,
      ids.revisionId,
      ctx.world.revision(ids.revisionId).decisionVersion,
      'approved',
      undefined,
      IDS.admin,
    );
    const published = await ctx.service.getPublished(ids.propertyId);
    expect(published.property.amenities.map((item) => item.code).sort()).toEqual([
      'elevator',
      'parking',
    ]);
  });
  it("a primary-type switch enforces the new form's allowedAmenityCodes on the next write, never carrying a now-disallowed selection through silently", async () => {
    const ctx = world();
    const { files, media } = photos(['additional_1']);
    // First written against the unrestricted legacy apartment form with 'elevator' selected...
    const apartment = ctx.world.forms.current(IDS.apartment);
    const created = await ctx.service.create(
      IDS.user,
      dynamicPayload(
        apartment,
        {
          bedrooms: 3,
          livingRooms: 1,
          kitchens: 1,
          bathrooms: 2,
          floor: 2,
          totalFloors: 5,
          buildingYear: 2020,
          finishingStatus: 'fully_finished',
          deliveryStatus: 'immediate',
        },
        {
          amenityCodes: ['elevator'],
          ...photos([
            'exterior',
            'entrance',
            'living_1',
            'bedroom_1',
            'bedroom_2',
            'bedroom_3',
            'kitchen_1',
            'bathroom_1',
            'bathroom_2',
          ]).media,
        },
      ),
      photos([
        'exterior',
        'entrance',
        'living_1',
        'bedroom_1',
        'bedroom_2',
        'bedroom_3',
        'kitchen_1',
        'bathroom_1',
        'bathroom_2',
      ]).files,
    );
    // ...then the draft is re-saved pinned to the restricted land form still carrying 'elevator': rejected, not silently dropped.
    const { status, body } = await responseOf(
      ctx.service.createDraftRevision(
        IDS.user,
        created.property.id,
        {
          ...dynamicPayload(
            ctx.restrictedLand,
            { plotShape: 'regular' },
            { purposeSubcategoryId: IDS.land, amenityCodes: ['elevator'], ...media },
          ),
          expectedRevisionVersion: created.property.revisionVersion,
        },
        files,
      ),
    );
    expect(status).toBe(400);
    expect(body.code).toBe(PropertyErrorCode.AMENITY_NOT_ALLOWED);
  });
});
