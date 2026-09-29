import { ValidationPipe } from '@nestjs/common';
import { SystemRole } from '../src/auth/roles.enum';
import { AuthorizationPolicyService } from '../src/authorization/authorization-policy.service';
import { Capability } from '../src/authorization/capability';
import { AccountStatus, AccountType, BrokerStatus } from '../src/users/identity.types';
import { ListPublishedPropertiesDto } from '../src/properties/dto/list-published-properties.dto';
import { ListPublicAuctionsDto } from '../src/auctions/dto/list-auctions.dto';
import { assertAmenitySelection, assertUsableVersion } from '../src/properties/property-form-write';
import { computeFormContentHash } from '../src/property-form-definitions/property-form-definition.constants';
import { PHASE9_PROMOTED_FACET_KEYS } from '../src/migrations/030-phase9-facet-promotion';

/** Phase 12 gates: role matrix for critical operations and public-query safety. */

const principal = (systemRole: SystemRole, accountType = AccountType.USER, brokerStatus = BrokerStatus.NOT_APPLIED) =>
  ({ userId: '64b000000000000000000001', systemRole, accountType, accountStatus: AccountStatus.ACTIVE, brokerStatus }) as any;

const roles: Record<string, any> = {
  public: {},
  USER: principal(SystemRole.USER),
  BROKER: principal(SystemRole.USER, AccountType.BROKER, BrokerStatus.APPROVED),
  COMPANY: principal(SystemRole.USER, AccountType.COMPANY),
  ADMIN: principal(SystemRole.ADMIN, AccountType.USER),
  SUPER_ADMIN: principal(SystemRole.SUPER_ADMIN, AccountType.USER),
};

const matrix: Array<[Capability, string[]]> = [
  [Capability.PROPERTY_CREATE, ['USER', 'BROKER', 'COMPANY']],
  [Capability.AUCTION_CREATE_OWN, ['USER', 'BROKER', 'COMPANY']],
  [Capability.BID_PLACE, ['USER', 'BROKER', 'COMPANY']],
  [Capability.ADMIN_PROPERTY_REVIEW, ['ADMIN', 'SUPER_ADMIN']],
  [Capability.ADMIN_CATALOG_MANAGE, ['ADMIN', 'SUPER_ADMIN']],
  [Capability.ADMIN_AUCTION_FEE_MANAGE, ['ADMIN', 'SUPER_ADMIN']],
  [Capability.ADMIN_FORM_DEFINITION_PUBLISH, ['SUPER_ADMIN']],
  [Capability.SUPER_ADMIN_ROLE_MANAGE, ['SUPER_ADMIN']],
];

describe('Phase 12 role matrix for critical property/catalog/form/review/auction actions', () => {
  it.each(matrix)('%s is granted to exactly the expected roles', (capability, allowed) => {
    for (const [name, identity] of Object.entries(roles)) {
      expect([name, AuthorizationPolicyService.can(identity, capability)]).toEqual([name, allowed.includes(name)]);
    }
  });
});

describe('Phase 12 public query safety', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const run = (metatype: any, value: Record<string, unknown>) => pipe.transform(value, { type: 'query', metatype });
  const rejects = async (metatype: any, value: Record<string, unknown>) => { await expect(run(metatype, value)).rejects.toMatchObject({ status: 400 }); };

  it('accepts only the seven approved promoted facets on property search', async () => {
    expect([...PHASE9_PROMOTED_FACET_KEYS].sort()).toEqual(['builtAreaSqm', 'commercialUseTypes', 'industrialUseType', 'powerSource', 'shopFloorLevel', 'soilType', 'waterSource']);
    await expect(run(ListPublishedPropertiesDto, { shopFloorLevel: 'ground' })).resolves.toBeDefined();
    await expect(run(ListPublishedPropertiesDto, { minBuiltAreaSqm: '10', maxBuiltAreaSqm: '20' })).resolves.toBeDefined();
  });

  it.each([
    ['amenity search', { amenityCodes: 'elevator' }],
    ['amenity search (single)', { amenity: 'elevator' }],
    ['arbitrary attribute search', { 'attr.bedrooms': '3' }],
    ['arbitrary attribute search (nested)', { attr: { bedrooms: '3' } }],
    ['unpromoted specification key', { bedrooms: '3' }],
    ['raw facet path', { 'facets.shopFloorLevel': 'ground' }],
    ['raw mongo operator', { $where: '1' }],
  ])('property search rejects %s', async (_name, query) => { await rejects(ListPublishedPropertiesDto, query); });

  it.each([
    ['a Phase 9 facet', { shopFloorLevel: 'ground' }],
    ['a facet range', { minBuiltAreaSqm: '10' }],
    ['amenity filtering', { amenityCodes: 'elevator' }],
    ['arbitrary attribute filtering', { 'attr.bedrooms': '3' }],
  ])('auction discovery rejects %s', async (_name, query) => { await rejects(ListPublicAuctionsDto, query); });

  it('auction discovery still accepts its own property-derived filters', async () => {
    await expect(run(ListPublicAuctionsDto, { governorateCode: 'cairo', city: 'x' })).resolves.toBeDefined();
  });
});

describe('Phase 12 form-version write gates', () => {
  const content = (overrides: Record<string, unknown> = {}) => ({ rendererVersion: 1, fields: [], mediaProfile: 'generic', amenitiesEnabled: true, ...overrides }) as any;
  const version = (overrides: Record<string, unknown> = {}) => { const value = content(overrides); return { ...value, contentHash: computeFormContentHash(value) } as any; };

  it('a stored version with an unsupported media profile can never back a write', () => {
    expect(() => assertUsableVersion(version(), 'type')).not.toThrow();
    expect(() => assertUsableVersion(version({ mediaProfile: 'video_tour' }), 'type')).toThrow(expect.objectContaining({ response: expect.objectContaining({ details: expect.objectContaining({ reason: 'MEDIA_PROFILE_UNSUPPORTED' }) }) }));
  });

  it('allowedAmenityCodes is enforced on every selection, never bypassed', () => {
    const restricted = version({ allowedAmenityCodes: ['parking'] });
    expect(() => assertAmenitySelection(restricted, ['parking'])).not.toThrow();
    expect(() => assertAmenitySelection(restricted, ['parking', 'elevator'])).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'PROPERTY_AMENITY_NOT_ALLOWED' }) }));
    expect(() => assertAmenitySelection(version({ amenitiesEnabled: false }), ['parking'])).toThrow();
  });
});
