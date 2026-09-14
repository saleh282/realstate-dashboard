export const PROPERTY_OPTION_GROUPS = ['finishing_status', 'delivery_status', 'payment_method'] as const;
export type PropertyOptionGroup = (typeof PROPERTY_OPTION_GROUPS)[number];
export const PROPERTY_OPTION_GROUP_OPTIONS = [
  { value: 'finishing_status', labelAr: 'حالة التشطيب' },
  { value: 'delivery_status', labelAr: 'جاهزية التسليم' },
  { value: 'payment_method', labelAr: 'طريقة السداد المفضلة' },
] as const;
export const PROPERTY_OPTION_ICON_OPTIONS = [
  { key: 'finishing', labelAr: 'تشطيب' }, { key: 'verified', labelAr: 'جاهز' },
  { key: 'schedule', labelAr: 'موعد تسليم' }, { key: 'construction', labelAr: 'قيد الإنشاء' },
  { key: 'cash', labelAr: 'كاش' }, { key: 'installment', labelAr: 'تقسيط' },
  { key: 'mortgage', labelAr: 'تمويل عقاري' }, { key: 'other', labelAr: 'أخرى' },
] as const;
export const PROPERTY_OPTION_ICON_KEYS = PROPERTY_OPTION_ICON_OPTIONS.map((item) => item.key);
export const DEFAULT_PROPERTY_OPTIONS = [
  ['finishing_status', 'unfinished', 'بدون تشطيب', 'Unfinished', 'finishing', 10, false],
  ['finishing_status', 'semi_finished', 'نصف تشطيب', 'Semi Finished', 'finishing', 20, false],
  ['finishing_status', 'fully_finished', 'تشطيب كامل', 'Fully Finished', 'verified', 30, true],
  ['finishing_status', 'ultra_lux', 'ألترا سوبر لوكس', 'Ultra Lux', 'verified', 40, false],
  ['delivery_status', 'immediate', 'فوري', 'Immediate', 'verified', 10, true],
  ['delivery_status', 'within_6_months', 'خلال 6 أشهر', 'Within 6 Months', 'schedule', 20, false],
  ['delivery_status', 'within_1_year', 'خلال سنة', 'Within 1 Year', 'schedule', 30, false],
  ['delivery_status', 'under_construction', 'قيد الإنشاء', 'Under Construction', 'construction', 40, false],
  ['payment_method', 'cash', 'كاش فقط', 'Cash Only', 'cash', 10, false],
  ['payment_method', 'installment', 'تقسيط فقط', 'Installments Only', 'installment', 20, false],
  ['payment_method', 'cash_or_installment', 'كاش أو تقسيط', 'Cash or Installments', 'cash', 30, true],
  ['payment_method', 'mortgage', 'تمويل عقاري بنكي', 'Bank Mortgage', 'mortgage', 40, false],
] as const;
