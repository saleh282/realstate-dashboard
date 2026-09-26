import { PropertyMediaTagCode } from './property.types';
import type { MediaProfile } from '../property-form-definitions/property-form-definition.constants';

/**
 * Media profiles (DPF-012, frozen §I). A profile's required-slot list is frozen
 * once it ships; changing it means a new profile key. V1 ships
 * `residential_rooms` (exactly today's guided photography) and `generic`.
 * `land`, `commercial_unit` and `industrial` wait for PD-1 (DPF-041).
 */

export type FixedMediaSlot = { slotId: string; tagCode: PropertyMediaTagCode; labelAr: string; tipAr: string; iconKey: string };
export type RepeatedMediaSlot = { slotPrefix: string; countFromAttribute: string; tagCode: PropertyMediaTagCode; labelAr: string; tipAr: string; iconKey: string };
export type MediaProfileDefinition = {
  profile: MediaProfile;
  minPhotos: number;
  maxPhotos: number;
  fixedSlots: readonly FixedMediaSlot[];
  repeatedSlots: readonly RepeatedMediaSlot[];
  additionalSlotPrefix: 'additional';
};
export type MediaRequirements = MediaProfileDefinition;

const MAX_PHOTOS = 20;

/** Labels and tips follow the current app's guided slots. */
const RESIDENTIAL_ROOMS: MediaProfileDefinition = {
  profile: 'residential_rooms',
  minPhotos: 2,
  maxPhotos: MAX_PHOTOS,
  fixedSlots: [
    { slotId: 'exterior', tagCode: PropertyMediaTagCode.EXTERIOR, labelAr: 'المبنى من الخارج', tipAr: 'التقط صورة واضحة بزاوية واسعة لواجهة المبنى في إضاءة نهارية جيدة.', iconKey: 'apartment' },
    { slotId: 'entrance', tagCode: PropertyMediaTagCode.ENTRANCE, labelAr: 'مدخل العقار', tipAr: 'التقط صورة مستقلة وواضحة للمدخل الرئيسي للعقار.', iconKey: 'door_front' },
  ],
  repeatedSlots: [
    { slotPrefix: 'living', countFromAttribute: 'livingRooms', tagCode: PropertyMediaTagCode.LIVING_ROOM, labelAr: 'الصالة', tipAr: 'قف في إحدى زوايا الصالة لإبراز أكبر قدر ممكن من المساحة والفرش والإضاءة.', iconKey: 'weekend' },
    { slotPrefix: 'bedroom', countFromAttribute: 'bedrooms', tagCode: PropertyMediaTagCode.BEDROOM, labelAr: 'غرفة النوم', tipAr: 'التقط صورة تُظهر اتساع الغرفة وموقع النوافذ والإطلالة والخزائن إن وجدت.', iconKey: 'bed' },
    { slotPrefix: 'kitchen', countFromAttribute: 'kitchens', tagCode: PropertyMediaTagCode.KITCHEN, labelAr: 'المطبخ', tipAr: 'صوّر خزائن المطبخ والرخام والحوض بزاوية توضح التجهيزات وحالة التشطيب.', iconKey: 'kitchen' },
    { slotPrefix: 'bathroom', countFromAttribute: 'bathrooms', tagCode: PropertyMediaTagCode.BATHROOM, labelAr: 'الحمام', tipAr: 'التقط صورة توضح تشطيب الحمام والحوض والشاور أو البانيو.', iconKey: 'bathtub' },
  ],
  additionalSlotPrefix: 'additional',
};

const GENERIC: MediaProfileDefinition = {
  profile: 'generic',
  minPhotos: 1,
  maxPhotos: MAX_PHOTOS,
  fixedSlots: [],
  repeatedSlots: [],
  additionalSlotPrefix: 'additional',
};

export const MEDIA_PROFILE_DEFINITIONS: Readonly<Partial<Record<MediaProfile, MediaProfileDefinition>>> = {
  residential_rooms: RESIDENTIAL_ROOMS,
  generic: GENERIC,
};

export function mediaProfileDefinition(profile: MediaProfile): MediaProfileDefinition {
  const definition = MEDIA_PROFILE_DEFINITIONS[profile];
  if (!definition) throw new Error(`Media profile ${profile} has not shipped`);
  return definition;
}

/**
 * Required slot ids for a profile and the listing's effective attributes:
 * fixed slots, then `<prefix>_1..n` for each repeated slot, n taken from the
 * attribute (a missing count yields no slots; nothing is defaulted).
 */
export function requiredSlots(profile: MediaProfile, attributes: Readonly<Record<string, unknown>>): string[] {
  const definition = mediaProfileDefinition(profile);
  return [
    ...definition.fixedSlots.map((slot) => slot.slotId),
    ...definition.repeatedSlots.flatMap((slot) =>
      Array.from({ length: attributes[slot.countFromAttribute] as number }, (_, index) => `${slot.slotPrefix}_${index + 1}`)),
  ];
}

/** Media tag for a guided slot id; anything the profile does not define is OTHER. */
export function slotTag(profile: MediaProfile, slotId?: string): PropertyMediaTagCode {
  const definition = mediaProfileDefinition(profile);
  const fixed = definition.fixedSlots.find((slot) => slot.slotId === slotId);
  if (fixed) return fixed.tagCode;
  const repeated = definition.repeatedSlots.find((slot) => slotId?.startsWith(`${slot.slotPrefix}_`));
  return repeated?.tagCode ?? PropertyMediaTagCode.OTHER;
}

/** Client-facing requirements (returned with every definition version). */
export function mediaRequirements(profile: MediaProfile): MediaRequirements {
  const definition = mediaProfileDefinition(profile);
  return {
    profile: definition.profile,
    minPhotos: definition.minPhotos,
    maxPhotos: definition.maxPhotos,
    fixedSlots: definition.fixedSlots.map((slot) => ({ ...slot })),
    repeatedSlots: definition.repeatedSlots.map((slot) => ({ ...slot })),
    additionalSlotPrefix: definition.additionalSlotPrefix,
  };
}
