export const GOVERNORATE_ICON_OPTIONS = [{ key: 'location', labelAr: 'موقع' }, { key: 'city', labelAr: 'مدينة' }, { key: 'other', labelAr: 'أخرى' }] as const;
export const GOVERNORATE_ICON_KEYS = GOVERNORATE_ICON_OPTIONS.map(i => i.key);
export const DEFAULT_GOVERNORATES = [
  ['cairo', 'القاهرة', 'Cairo', 10], ['giza', 'الجيزة', 'Giza', 20], ['alexandria', 'الإسكندرية', 'Alexandria', 30],
  ['qalyubia', 'القليوبية', 'Qalyubia', 40], ['sharqia', 'الشرقية', 'Sharqia', 50], ['dakahlia', 'الدقهلية', 'Dakahlia', 60],
  ['red_sea', 'البحر الأحمر', 'Red Sea', 70], ['south_sinai', 'جنوب سيناء', 'South Sinai', 80], ['matrouh', 'مطروح', 'Matrouh', 90], ['aswan', 'أسوان', 'Aswan', 100],
] as const;
