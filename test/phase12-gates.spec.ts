import { ValidationPipe } from '@nestjs/common';
import { SystemRole } from '../src/auth/roles.enum';

import { Capability } from '../src/authorization/capability';
import { AccountStatus, AccountType, BrokerStatus } from '../src/users/identity.types';
import { ListPublishedPropertiesDto } from '../src/properties/dto/list-published-properties.dto';
import { assertAmenitySelection, assertUsableVersion } from '../src/properties/property-form-write';
import { computeFormContentHash } from '../src/property-form-definitions/property-form-definition.constants';
import { PHASE9_PROMOTED_FACET_KEYS } from '../src/migrations/030-phase9-facet-promotion';

/** Phase 12 gates: role matrix for critical operations and public-query safety. */

const principal = (systemRole: SystemRole, accountType = AccountType.USER, brokerStatus = BrokerStatus.NOT_APPLIED) =>
  ({ userId: '64b000000000000000000001', systemRole, accountType, accountStatus: AccountStatus.ACTIVE, brokerStatus }) as any;

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
