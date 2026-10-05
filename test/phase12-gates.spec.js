'use strict';

const { ValidationPipe } = require('../src/middleware/validate');
const { AccountStatus, AccountType, BrokerStatus } = require('../src/domain/users/identity.types');
const {
  ListPublishedPropertiesDto,
} = require('../src/validators/properties/list-published-properties.dto');
const {
  assertAmenitySelection,
  assertUsableVersion,
} = require('../src/domain/properties/property-form-write');
const {
  computeFormContentHash,
} = require('../src/domain/property-form-definitions/property-form-definition.constants');
const { PHASE9_PROMOTED_FACET_KEYS } = require('../src/migrations/030-phase9-facet-promotion');
/** Phase 12 gates: role matrix for critical operations and public-query safety. */
const principal = (
  systemRole,
  accountType = AccountType.USER,
  brokerStatus = BrokerStatus.NOT_APPLIED,
) => ({
  userId: '64b000000000000000000001',
  systemRole,
  accountType,
  accountStatus: AccountStatus.ACTIVE,
  brokerStatus,
});
describe('Phase 12 public query safety', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const run = (metatype, value) => pipe.transform(value, { type: 'query', metatype });
  const rejects = async (metatype, value) => {
    await expect(run(metatype, value)).rejects.toMatchObject({ status: 400 });
  };
  it('accepts only the seven approved promoted facets on property search', async () => {
    expect([...PHASE9_PROMOTED_FACET_KEYS].sort()).toEqual([
      'builtAreaSqm',
      'commercialUseTypes',
      'industrialUseType',
      'powerSource',
      'shopFloorLevel',
      'soilType',
      'waterSource',
    ]);
    await expect(
      run(ListPublishedPropertiesDto, { shopFloorLevel: 'ground' }),
    ).resolves.toBeDefined();
    await expect(
      run(ListPublishedPropertiesDto, { minBuiltAreaSqm: '10', maxBuiltAreaSqm: '20' }),
    ).resolves.toBeDefined();
  });
  it.each([
    ['amenity search', { amenityCodes: 'elevator' }],
    ['amenity search (single)', { amenity: 'elevator' }],
    ['arbitrary attribute search', { 'attr.bedrooms': '3' }],
    ['arbitrary attribute search (nested)', { attr: { bedrooms: '3' } }],
    ['unpromoted specification key', { bedrooms: '3' }],
    ['raw facet path', { 'facets.shopFloorLevel': 'ground' }],
    ['raw mongo operator', { $where: '1' }],
  ])('property search rejects %s', async (_name, query) => {
    await rejects(ListPublishedPropertiesDto, query);
  });
});
describe('Phase 12 form-version write gates', () => {
  const content = (overrides = {}) => ({
    rendererVersion: 1,
    fields: [],
    mediaProfile: 'generic',
    amenitiesEnabled: true,
    ...overrides,
  });
  const version = (overrides = {}) => {
    const value = content(overrides);
    return { ...value, contentHash: computeFormContentHash(value) };
  };
  it('a stored version with an unsupported media profile can never back a write', () => {
    expect(() => assertUsableVersion(version(), 'type')).not.toThrow();
    expect(() => assertUsableVersion(version({ mediaProfile: 'video_tour' }), 'type')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          details: expect.objectContaining({ reason: 'MEDIA_PROFILE_UNSUPPORTED' }),
        }),
      }),
    );
  });
  it('allowedAmenityCodes is enforced on every selection, never bypassed', () => {
    const restricted = version({ allowedAmenityCodes: ['parking'] });
    expect(() => assertAmenitySelection(restricted, ['parking'])).not.toThrow();
    expect(() => assertAmenitySelection(restricted, ['parking', 'elevator'])).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'PROPERTY_AMENITY_NOT_ALLOWED' }),
      }),
    );
    expect(() =>
      assertAmenitySelection(version({ amenitiesEnabled: false }), ['parking']),
    ).toThrow();
  });
});
