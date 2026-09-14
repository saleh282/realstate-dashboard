export const PROPERTY_TYPE_ICON_OPTIONS = [
  { key: 'home', labelAr: 'منزل عام' },
  { key: 'apartment', labelAr: 'شقة' },
  { key: 'villa', labelAr: 'فيلا' },
  { key: 'duplex', labelAr: 'دوبلكس' },
  { key: 'penthouse', labelAr: 'بنتهاوس' },
  { key: 'townhouse', labelAr: 'تاون هاوس' },
  { key: 'land', labelAr: 'أرض' },
  { key: 'building', labelAr: 'عمارة' },
  { key: 'chalet', labelAr: 'شاليه' },
  { key: 'office', labelAr: 'مكتب' },
  { key: 'store', labelAr: 'محل تجاري' },
  { key: 'warehouse', labelAr: 'مخزن' },
] as const;

export const PROPERTY_TYPE_ICON_KEYS = PROPERTY_TYPE_ICON_OPTIONS.map((option) => option.key);
