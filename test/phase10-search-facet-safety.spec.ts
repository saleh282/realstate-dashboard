import { PropertiesService } from '../src/properties/properties.service';
import { GetFilterMetadataDto } from '../src/properties/dto/get-filter-metadata.dto';
import { PHASE9_FACET_METADATA, facetMetadataForPropertyTypeCode } from '../src/properties/property-search-facets';
import { PHASE9_PROMOTED_FACET_KEYS } from '../src/migrations/030-phase9-facet-promotion';
import { PROPERTY_ATTRIBUTE_FACET_KEYS } from '../src/property-attributes/property-attribute.constants';
import { PHASE10_NEW_ATTRIBUTE_SEED } from '../src/migrations/032-phase10-unit-floor-level-registry';
import { approvedFacets } from '../src/properties/property-form-write';
import { validateFormContent } from '../src/property-form-definitions/form-definition-drafts';
import { CURRENT_RENDERER_VERSION } from '../src/property-form-definitions/property-form-definition.constants';

/**
 * Phase 10 (Complete Remaining Property Types) search/facet safety: proves
 * that reusing already-promoted Phase 9 attribute keys (builtAreaSqm,
 * powerSource, industrialUseType, soilType, waterSource) on the 9 new forms
 * does NOT expand search exposure — `PHASE9_FACET_METADATA` applicability
 * stays exactly {shop, factory, agricultural_land} — while `Property.facets`
 * MAY legitimately be populated for the reusing types (approved product
 * decision 3). Also proves `unitFloorLevel` can never become a facet, by
 * construction, regardless of any accidental facetKey.
 */

const PHASE10_TYPE_IDS: Record<string, string> = {
  office: '64d900000000000000000001',
  clinic: '64d900000000000000000002',
  commercial_unit: '64d900000000000000000003',
  commercial_building: '64d900000000000000000004',
  commercial_land: '64d900000000000000000005',
  warehouse: '64d900000000000000000006',
  workshop: '64d900000000000000000007',
  industrial_land: '64d900000000000000000008',
  farm: '64d900000000000000000009',
};

const emptyLookup = { find: jest.fn().mockReturnValue({ lean: () => ({ exec: jest.fn().mockResolvedValue([]) }) }) };

function service() {
  const instance = Object.create(PropertiesService.prototype) as any;
  Object.assign(instance, {
    governorates: emptyLookup,
    propertyTypes: {
      ...emptyLookup,
      findById: jest.fn((id: string) => ({
        lean: () => ({
          exec: jest.fn().mockResolvedValue(
            Object.entries(PHASE10_TYPE_IDS).find(([, typeId]) => typeId === id)
              ? { _id: id, code: Object.entries(PHASE10_TYPE_IDS).find(([, typeId]) => typeId === id)![0] }
              : null,
          ),
        }),
      })),
    },
  });
  return instance as PropertiesService;
}

describe('Phase 10 search/facet safety (no expansion of Phase 9 exposure)', () => {
  it('PHASE9_FACET_METADATA applicability remains exactly {shop, factory, agricultural_land}: no Phase 10 code is present anywhere in it', () => {
    const applicableCodes = new Set(PHASE9_FACET_METADATA.flatMap((entry) => entry.applicablePropertyTypeCodes));
    expect(applicableCodes).toEqual(new Set(['shop', 'factory', 'agricultural_land']));
    for (const phase10Code of Object.keys(PHASE10_TYPE_IDS)) {
      expect(applicableCodes.has(phase10Code)).toBe(false);
    }
  });

  it.each(Object.keys(PHASE10_TYPE_IDS))('GET /properties/filter-metadata exposes zero facets for %s, even though its published form may reuse a promoted key', async (code) => {
    const result = await service().getFilterMetadata({ purposeSubcategoryId: PHASE10_TYPE_IDS[code] } as GetFilterMetadataDto);
    expect(result).toEqual({ facets: [] });
  });

  it('facetMetadataForPropertyTypeCode returns [] for every Phase 10 type code directly (pure function, no DB)', () => {
    for (const code of Object.keys(PHASE10_TYPE_IDS)) {
      expect(facetMetadataForPropertyTypeCode(code)).toEqual([]);
    }
  });

  it('approved product decision 3: approvedFacets() DOES derive values for reused promoted keys regardless of which type the attributes came from (pure, type-agnostic by construction)', () => {
    // Shaped like an approved warehouse revision's effective attributes.
    expect(approvedFacets({ builtAreaSqm: 500, powerSource: 'grid', industrialUseType: 'light', ceilingHeightM: 6, hasLoadingDock: true }))
      .toEqual({ builtAreaSqm: 500, powerSource: 'grid', industrialUseType: 'light' });
    // Shaped like an approved farm revision's effective attributes.
    expect(approvedFacets({ soilType: 'clay', waterSource: 'well', irrigationTypes: ['drip'], plotShape: 'regular' }))
      .toEqual({ soilType: 'clay', waterSource: 'well' });
    // Shaped like an approved industrial_land revision reusing only powerSource.
    expect(approvedFacets({ powerSource: 'generator', roadFrontageM: 20 })).toEqual({ powerSource: 'generator' });
  });

  it('unitFloorLevel can never become a facet: it is architecturally absent from the facet-derivation pipeline, independent of any facetKey', () => {
    expect(PHASE10_NEW_ATTRIBUTE_SEED).toHaveLength(1);
    expect((PHASE10_NEW_ATTRIBUTE_SEED[0] as any).facetKey).toBeUndefined();
    expect(PROPERTY_ATTRIBUTE_FACET_KEYS as readonly string[]).not.toContain('unitFloorLevel');
    // Even if attributes carried a value under that key (e.g. a bug elsewhere), it is never in PROMOTED_FACET_DEFINITIONS's source seeds.
    const result = approvedFacets({ unitFloorLevel: 'ground', bedrooms: 3 });
    expect(result).toEqual({ bedrooms: 3 });
    expect(result).not.toHaveProperty('unitFloorLevel');
  });

  it('a non-generic mediaProfile is structurally rejected at the form-content validator (the real guard behind "no bespoke media profiles in Phase 10")', () => {
    const content = { rendererVersion: CURRENT_RENDERER_VERSION, fields: [], mediaProfile: 'land' as any, amenitiesEnabled: false };
    const errors = validateFormContent(content, new Map(), { stage: 'publish' });
    expect(errors.some((error) => error.code === 'MEDIA_PROFILE_UNSUPPORTED' && error.property === 'mediaProfile')).toBe(true);
  });

  it('PHASE9_PROMOTED_FACET_KEYS stays exactly the 7 Phase 9 keys; Phase 10 adds none', () => {
    expect([...PHASE9_PROMOTED_FACET_KEYS].sort()).toEqual(
      ['builtAreaSqm', 'commercialUseTypes', 'industrialUseType', 'powerSource', 'shopFloorLevel', 'soilType', 'waterSource'].sort(),
    );
  });
});
