'use strict';

const { approvedFacets } = require('../src/domain/properties/property-form-write');
/**
 * Phase 9 (Search & Facets): `approvedFacets()` extended beyond integer-only
 * to support decimal/boolean/singleSelect/multiSelect, driven by the same
 * static, engineering-owned registry seeds approval has always used. Pure
 * function: no database, no HTTP.
 */
describe('approvedFacets() — Phase 9 generic derivation', () => {
  it('preserves existing bedrooms (integer) behavior exactly', () => {
    expect(approvedFacets({ bedrooms: 4 })).toEqual({ bedrooms: 4 });
    expect(approvedFacets({ bedrooms: 0 })).toEqual({ bedrooms: 0 });
    expect(approvedFacets({ bedrooms: 100 })).toEqual({ bedrooms: 100 });
    expect(approvedFacets({ bedrooms: 101 })).toEqual({}); // above hard bound
    expect(approvedFacets({ bedrooms: -1 })).toEqual({}); // below hard bound
    expect(approvedFacets({ bedrooms: 2.5 })).toEqual({}); // not an integer
    expect(approvedFacets({ bedrooms: '4' })).toEqual({}); // wrong type
    expect(approvedFacets({})).toEqual({});
  });
  it('derives singleSelect facets only for a registry-approved option code', () => {
    expect(approvedFacets({ shopFloorLevel: 'ground' })).toEqual({ shopFloorLevel: 'ground' });
    expect(approvedFacets({ shopFloorLevel: 'basement' })).toEqual({ shopFloorLevel: 'basement' });
    expect(approvedFacets({ shopFloorLevel: 'not-a-real-code' })).toEqual({});
    expect(approvedFacets({ shopFloorLevel: 5 })).toEqual({});
    expect(approvedFacets({ powerSource: 'both' })).toEqual({ powerSource: 'both' });
    expect(approvedFacets({ industrialUseType: 'heavy' })).toEqual({ industrialUseType: 'heavy' });
    expect(approvedFacets({ soilType: 'loamy' })).toEqual({ soilType: 'loamy' });
    expect(approvedFacets({ waterSource: 'canal' })).toEqual({ waterSource: 'canal' });
  });
  it('derives decimal facets within the registry hard bounds only', () => {
    expect(approvedFacets({ builtAreaSqm: 2500.75 })).toEqual({ builtAreaSqm: 2500.75 });
    expect(approvedFacets({ builtAreaSqm: 0 })).toEqual({ builtAreaSqm: 0 });
    expect(approvedFacets({ builtAreaSqm: 1_000_000 })).toEqual({ builtAreaSqm: 1_000_000 });
    expect(approvedFacets({ builtAreaSqm: 1_000_001 })).toEqual({}); // above hard bound
    expect(approvedFacets({ builtAreaSqm: -1 })).toEqual({}); // below hard bound
    expect(approvedFacets({ builtAreaSqm: Infinity })).toEqual({});
    expect(approvedFacets({ builtAreaSqm: NaN })).toEqual({});
    expect(approvedFacets({ builtAreaSqm: 'big' })).toEqual({});
  });
  it('derives multiSelect facets, deduplicated and filtered to registry-approved codes only', () => {
    expect(approvedFacets({ commercialUseTypes: ['retail', 'food'] })).toEqual({
      commercialUseTypes: ['retail', 'food'],
    });
    expect(approvedFacets({ commercialUseTypes: ['retail', 'retail', 'food'] })).toEqual({
      commercialUseTypes: ['retail', 'food'],
    }); // deduplicated
    expect(approvedFacets({ commercialUseTypes: ['retail', 'not-a-real-code'] })).toEqual({
      commercialUseTypes: ['retail'],
    }); // invalid code dropped, valid kept
    expect(approvedFacets({ commercialUseTypes: ['not-a-real-code'] })).toEqual({}); // nothing valid left -> omitted entirely
    expect(approvedFacets({ commercialUseTypes: [] })).toEqual({}); // empty array -> omitted
    expect(approvedFacets({ commercialUseTypes: 'retail' })).toEqual({}); // not an array
    expect(approvedFacets({ commercialUseTypes: [1, 2] })).toEqual({}); // wrong element type
  });
  it('would support a boolean facet if one were ever promoted (structural readiness, none promoted in Phase 9 V1)', () => {
    // hasStorefront/hasServiceAccess/hasLoadingDock/hasRoadAccess are boolean-typed Phase 8
    // attributes but are NOT in PHASE9_PROMOTED_FACET_KEYS, so they are never derived,
    // exactly like every other presentation-only Phase 8 attribute.
    expect(approvedFacets({ hasStorefront: true })).toEqual({});
    expect(approvedFacets({ hasLoadingDock: false })).toEqual({});
  });
  it('never derives a facet for a presentation-only (non-promoted) Phase 8 attribute', () => {
    const presentationOnlyValues = {
      frontageWidthM: 5,
      hasStorefront: true,
      hasServiceAccess: true,
      ceilingHeightM: 4,
      electricalCapacityKw: 50,
      hasLoadingDock: true,
      irrigationTypes: ['drip'],
      plotShape: 'square',
      hasRoadAccess: true,
      roadFrontageM: 10,
    };
    expect(approvedFacets(presentationOnlyValues)).toEqual({});
  });
  it('derives every promoted key present at once, independent of each other', () => {
    expect(
      approvedFacets({
        bedrooms: 3,
        shopFloorLevel: 'mezzanine',
        commercialUseTypes: ['pharmacy'],
        builtAreaSqm: 900.5,
        powerSource: 'generator',
        industrialUseType: 'light',
        soilType: 'sandy',
        waterSource: 'well',
      }),
    ).toEqual({
      bedrooms: 3,
      shopFloorLevel: 'mezzanine',
      commercialUseTypes: ['pharmacy'],
      builtAreaSqm: 900.5,
      powerSource: 'generator',
      industrialUseType: 'light',
      soilType: 'sandy',
      waterSource: 'well',
    });
  });
  it('omits a missing value rather than defaulting it', () => {
    expect(approvedFacets({ someUnrelatedField: 1 })).toEqual({});
  });
  it('is a pure function of its input (never reads global/database state, same input -> same output)', () => {
    const input = { bedrooms: 2, shopFloorLevel: 'ground' };
    expect(approvedFacets(input)).toEqual(approvedFacets({ ...input }));
  });
});
