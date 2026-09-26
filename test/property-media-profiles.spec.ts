import { MEDIA_PROFILES, SHIPPED_MEDIA_PROFILES } from '../src/property-form-definitions/property-form-definition.constants';
import { MEDIA_PROFILE_DEFINITIONS, mediaRequirements, requiredSlots, slotTag } from '../src/properties/media-profiles';
import { PropertiesService } from '../src/properties/properties.service';
import { evaluateMedia } from '../src/properties/property-form-write';
import { PropertyMediaTagCode } from '../src/properties/property.types';

/**
 * DPF-012: the residential profile must reproduce the pre-DPF-012 guided
 * photography exactly. The two reference functions below are the removed
 * implementations, copied verbatim.
 */
function referenceRequiredPhotoSlots(dto: any): string[] {
  return [
    'exterior',
    'entrance',
    ...Array.from({ length: dto.livingRooms }, (_, index) => `living_${index + 1}`),
    ...Array.from({ length: dto.bedrooms }, (_, index) => `bedroom_${index + 1}`),
    ...Array.from({ length: dto.kitchens }, (_, index) => `kitchen_${index + 1}`),
    ...Array.from({ length: dto.bathrooms }, (_, index) => `bathroom_${index + 1}`),
  ];
}
function referenceMediaTagFromGuidedSlot(slotId?: string): PropertyMediaTagCode {
  if (slotId === 'exterior') return PropertyMediaTagCode.EXTERIOR;
  if (slotId === 'entrance') return PropertyMediaTagCode.ENTRANCE;
  if (slotId?.startsWith('living_')) return PropertyMediaTagCode.LIVING_ROOM;
  if (slotId?.startsWith('bedroom_')) return PropertyMediaTagCode.BEDROOM;
  if (slotId?.startsWith('kitchen_')) return PropertyMediaTagCode.KITCHEN;
  if (slotId?.startsWith('bathroom_')) return PropertyMediaTagCode.BATHROOM;
  return PropertyMediaTagCode.OTHER;
}

const counts = [0, 1, 2, 3, 7, 100];
const roomFixtures: any[] = [];
for (const livingRooms of counts) for (const bedrooms of [0, 1, 4]) for (const kitchens of [1, 2]) for (const bathrooms of [0, 1, 3]) roomFixtures.push({ livingRooms, bedrooms, kitchens, bathrooms });
roomFixtures.push(
  {},
  { livingRooms: undefined, bedrooms: null, kitchens: 1, bathrooms: 1 },
  { livingRooms: 2.7, bedrooms: -1, kitchens: Number.NaN, bathrooms: '2' },
  { livingRooms: 1, bedrooms: 1, kitchens: 1, bathrooms: 1, floor: 3, extra: 9 },
);
const slotIds = [
  undefined, '', 'exterior', 'entrance', 'EXTERIOR', 'exterior_1', 'entrance_2', 'living_1', 'living_12', 'living_', 'living', 'livingroom_1',
  'bedroom_1', 'bedroom_x', 'kitchen_2', 'bathroom_3', 'bathroom', 'additional_1', 'additional_20', 'other', 'living_1_extra', ' living_1',
];

describe('DPF-012 media profiles', () => {
  const service = Object.create(PropertiesService.prototype) as any;

  it('residential_rooms reproduces the removed requiredPhotoSlots for every fixture', () => {
    for (const fixture of roomFixtures) {
      expect(requiredSlots('residential_rooms', fixture)).toEqual(referenceRequiredPhotoSlots(fixture));
      // DPF-022: the write, submit, approval and Admin paths all go through evaluateMedia.
      expect(evaluateMedia('residential_rooms', fixture, []).requiredPhotoSlots).toEqual(referenceRequiredPhotoSlots(fixture));
    }
  });

  it('residential_rooms reproduces the removed mediaTagFromGuidedSlot for every slot id', () => {
    for (const slotId of slotIds) {
      expect(slotTag('residential_rooms', slotId)).toBe(referenceMediaTagFromGuidedSlot(slotId));
      expect(service.mediaTagFromGuidedSlot(slotId)).toBe(referenceMediaTagFromGuidedSlot(slotId));
    }
  });

  it('generic requires no slots and at least one photo, and tags every slot as other', () => {
    expect(requiredSlots('generic', { bedrooms: 3, livingRooms: 2, kitchens: 1, bathrooms: 1 })).toEqual([]);
    for (const slotId of slotIds) expect(slotTag('generic', slotId)).toBe(PropertyMediaTagCode.OTHER);
    expect(mediaRequirements('generic')).toEqual({ profile: 'generic', minPhotos: 1, maxPhotos: 20, fixedSlots: [], repeatedSlots: [], additionalSlotPrefix: 'additional' });
  });

  it('exposes the residential requirements (slots, tags, counts, labels) to clients', () => {
    const requirements = mediaRequirements('residential_rooms');
    expect(requirements).toMatchObject({ profile: 'residential_rooms', minPhotos: 2, maxPhotos: 20, additionalSlotPrefix: 'additional' });
    expect(requirements.fixedSlots.map((slot) => [slot.slotId, slot.tagCode])).toEqual([['exterior', 'exterior'], ['entrance', 'entrance']]);
    expect(requirements.repeatedSlots.map((slot) => [slot.slotPrefix, slot.countFromAttribute, slot.tagCode])).toEqual([
      ['living', 'livingRooms', 'living_room'], ['bedroom', 'bedrooms', 'bedroom'], ['kitchen', 'kitchens', 'kitchen'], ['bathroom', 'bathrooms', 'bathroom'],
    ]);
    for (const slot of [...requirements.fixedSlots, ...requirements.repeatedSlots]) {
      expect(slot.labelAr.length).toBeGreaterThan(0);
      expect(slot.tipAr.length).toBeGreaterThan(0);
      expect(slot.iconKey).toMatch(/^[a-z_]+$/);
    }
    requirements.fixedSlots[0].labelAr = 'mutated';
    expect(mediaRequirements('residential_rooms').fixedSlots[0].labelAr).toBe('المبنى من الخارج');
  });

  it('ships exactly residential_rooms and generic; the other profiles wait for PD-1', () => {
    expect(MEDIA_PROFILES).toEqual(['residential_rooms', 'land', 'commercial_unit', 'industrial', 'generic']);
    expect(Object.keys(MEDIA_PROFILE_DEFINITIONS).sort()).toEqual([...SHIPPED_MEDIA_PROFILES].sort());
    for (const profile of ['land', 'commercial_unit', 'industrial'] as const) {
      expect(() => requiredSlots(profile, {})).toThrow(/has not shipped/);
      expect(() => mediaRequirements(profile)).toThrow(/has not shipped/);
    }
  });
});
