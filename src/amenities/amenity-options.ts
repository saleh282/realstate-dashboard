export const AMENITY_ICON_OPTIONS = [
  { key: 'elevator', labelAr: 'مصعد' },
  { key: 'parking', labelAr: 'موقف سيارات' },
  { key: 'security', labelAr: 'أمن وحراسة' },
  { key: 'pool', labelAr: 'مسبح' },
  { key: 'garden', labelAr: 'حديقة' },
  { key: 'balcony', labelAr: 'شرفة' },
  { key: 'natural_gas', labelAr: 'غاز طبيعي' },
  { key: 'central_ac', labelAr: 'تكييف مركزي' },
  { key: 'fiber_internet', labelAr: 'إنترنت ألياف' },
  { key: 'gym', labelAr: 'صالة ألعاب' },
  { key: 'maid_room', labelAr: 'غرفة خادمة' },
  { key: 'surveillance_cameras', labelAr: 'كاميرات مراقبة' },
  { key: 'other', labelAr: 'أخرى' },
] as const;

export const AMENITY_ICON_KEYS = AMENITY_ICON_OPTIONS.map((option) => option.key);

export const AMENITY_CATEGORY_OPTIONS = [
  { value: 'feature', labelAr: 'ميزة' },
  { value: 'service', labelAr: 'خدمة' },
  { value: 'facility', labelAr: 'مرفق' },
] as const;

export const AMENITY_CATEGORIES = AMENITY_CATEGORY_OPTIONS.map((option) => option.value);
