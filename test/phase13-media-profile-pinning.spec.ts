import { FROZEN_MEDIA_PROFILE_HASHES, MEDIA_PROFILE_DEFINITIONS, mediaProfileDefinition, mediaProfileDefinitionHash } from '../src/properties/media-profiles';
import { SHIPPED_MEDIA_PROFILES } from '../src/property-form-definitions/property-form-definition.constants';

describe('Phase 13 media-profile pinning', () => {
  it('every shipped profile still has exactly its frozen definition hash', () => {
    for (const profile of SHIPPED_MEDIA_PROFILES) {
      expect([profile, mediaProfileDefinitionHash(profile)]).toEqual([profile, FROZEN_MEDIA_PROFILE_HASHES[profile]]);
    }
  });

  it('the frozen list and the shipped list are the same set (a new profile must be added to both, an old one never edited)', () => {
    expect(Object.keys(FROZEN_MEDIA_PROFILE_HASHES).sort()).toEqual([...SHIPPED_MEDIA_PROFILES].sort());
    expect(Object.keys(MEDIA_PROFILE_DEFINITIONS).sort()).toEqual([...SHIPPED_MEDIA_PROFILES].sort());
  });

  it('the hash detects a changed slot, a changed count and a changed label', () => {
    const base = mediaProfileDefinition('residential_rooms');
    const variants = [
      { ...base, minPhotos: base.minPhotos + 1 },
      { ...base, fixedSlots: base.fixedSlots.slice(1) },
      { ...base, repeatedSlots: base.repeatedSlots.map((slot, index) => (index === 1 ? { ...slot, countFromAttribute: 'other' } : slot)) },
      { ...base, fixedSlots: base.fixedSlots.map((slot, index) => (index === 0 ? { ...slot, labelAr: 'x' } : slot)) },
    ];
    const original = mediaProfileDefinitionHash('residential_rooms');
    const { canonicalize, sha256 } = jest.requireActual('../src/common/idempotency/idempotency.service');
    for (const variant of variants) expect(sha256(canonicalize(variant))).not.toBe(original);
  });
});
