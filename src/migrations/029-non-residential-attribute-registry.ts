import type { Db, Document } from 'mongodb';
import {
  PropertyAttributeDataType,
  PropertyAttributeUnit,
} from '../property-attributes/property-attribute.constants';
import { PropertyAttributeSchema } from '../property-attributes/schemas/property-attribute.schema';
import { ensureSchemaIndexes, ATTRIBUTES } from './025-property-form-foundation';

/**
 * DPF-044 (Phase 8): the engineering-owned Attribute Registry entries for the
 * first three real non-residential property types (shop, factory,
 * agricultural_land). Product decisions (which fields, required/optional,
 * option codes, hard bounds) were approved ahead of this migration; nothing
 * here is invented. Insert-only, same pattern as migration 025 M-A: an
 * existing key is never modified, this file never touches migration 025.
 */

export type Phase8AttributeOption = { code: string; labelAr: string; labelEn: string };

export type Phase8AttributeSeed = {
  key: string;
  dataType: PropertyAttributeDataType;
  unit?: PropertyAttributeUnit;
  labelAr: string;
  labelEn: string;
  hardBounds: { min?: number; max?: number; scale?: number; maxItems?: number };
  options?: readonly Phase8AttributeOption[];
};

const SCALE = 2;
/** Broad, non-restrictive transport/data-safety ceilings, not business policy. */
const BROAD_LENGTH_MAX_M = 1000;
const BROAD_AREA_MAX_SQM = 1_000_000;
const BROAD_POWER_MAX_KW = 100_000;

export const PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED: readonly Phase8AttributeSeed[] = [
  // ---------------------------------------------------------------- shop
  {
    key: 'shopFloorLevel',
    dataType: 'singleSelect',
    labelAr: 'مستوى المحل',
    labelEn: 'Shop Floor Level',
    hardBounds: {},
    options: [
      { code: 'ground', labelAr: 'الدور الأرضي', labelEn: 'Ground Floor' },
      { code: 'basement', labelAr: 'البدروم', labelEn: 'Basement' },
      { code: 'mezzanine', labelAr: 'الميزانين', labelEn: 'Mezzanine' },
      { code: 'upper', labelAr: 'دور علوي', labelEn: 'Upper Floor' },
    ],
  },
  {
    key: 'frontageWidthM',
    dataType: 'decimal',
    unit: 'm',
    labelAr: 'عرض الواجهة',
    labelEn: 'Frontage Width',
    hardBounds: { min: 0, max: BROAD_LENGTH_MAX_M, scale: SCALE },
  },
  {
    key: 'hasStorefront',
    dataType: 'boolean',
    labelAr: 'واجهة عرض',
    labelEn: 'Storefront',
    hardBounds: {},
  },
  {
    key: 'commercialUseTypes',
    dataType: 'multiSelect',
    labelAr: 'الاستخدامات التجارية المناسبة',
    labelEn: 'Suitable Commercial Uses',
    hardBounds: { maxItems: 6 },
    options: [
      { code: 'retail', labelAr: 'تجزئة', labelEn: 'Retail' },
      { code: 'food', labelAr: 'مطاعم وأغذية', labelEn: 'Food & Beverage' },
      { code: 'pharmacy', labelAr: 'صيدلية', labelEn: 'Pharmacy' },
      { code: 'services', labelAr: 'خدمات', labelEn: 'Services' },
      { code: 'showroom', labelAr: 'معرض', labelEn: 'Showroom' },
      { code: 'other', labelAr: 'أخرى', labelEn: 'Other' },
    ],
  },
  {
    key: 'hasServiceAccess',
    dataType: 'boolean',
    labelAr: 'مدخل خدمة أو تحميل',
    labelEn: 'Service / Loading Access',
    hardBounds: {},
  },
  // ---------------------------------------------------------------- factory
  {
    key: 'builtAreaSqm',
    dataType: 'decimal',
    unit: 'sqm',
    labelAr: 'المساحة المبنية',
    labelEn: 'Built Area',
    hardBounds: { min: 0, max: BROAD_AREA_MAX_SQM, scale: SCALE },
  },
  {
    key: 'ceilingHeightM',
    dataType: 'decimal',
    unit: 'm',
    labelAr: 'ارتفاع السقف',
    labelEn: 'Ceiling Height',
    hardBounds: { min: 0, max: BROAD_LENGTH_MAX_M, scale: SCALE },
  },
  {
    key: 'electricalCapacityKw',
    dataType: 'decimal',
    unit: 'kw',
    labelAr: 'القدرة الكهربائية',
    labelEn: 'Electrical Capacity',
    hardBounds: { min: 0, max: BROAD_POWER_MAX_KW, scale: SCALE },
  },
  {
    key: 'powerSource',
    dataType: 'singleSelect',
    labelAr: 'مصدر الكهرباء',
    labelEn: 'Power Source',
    hardBounds: {},
    options: [
      { code: 'grid', labelAr: 'كهرباء عامة', labelEn: 'Grid Power' },
      { code: 'generator', labelAr: 'مولد', labelEn: 'Generator' },
      { code: 'both', labelAr: 'كهرباء عامة ومولد', labelEn: 'Grid & Generator' },
      { code: 'none', labelAr: 'بدون', labelEn: 'None' },
    ],
  },
  {
    key: 'industrialUseType',
    dataType: 'singleSelect',
    labelAr: 'نوع الاستخدام الصناعي',
    labelEn: 'Industrial Use Type',
    hardBounds: {},
    options: [
      { code: 'light', labelAr: 'صناعة خفيفة', labelEn: 'Light Industry' },
      { code: 'medium', labelAr: 'صناعة متوسطة', labelEn: 'Medium Industry' },
      { code: 'heavy', labelAr: 'صناعة ثقيلة', labelEn: 'Heavy Industry' },
      { code: 'warehouse_related', labelAr: 'أنشطة تخزين', labelEn: 'Warehouse-Related' },
      { code: 'other', labelAr: 'أخرى', labelEn: 'Other' },
    ],
  },
  {
    key: 'hasLoadingDock',
    dataType: 'boolean',
    labelAr: 'منطقة تحميل',
    labelEn: 'Loading Dock',
    hardBounds: {},
  },
  // ---------------------------------------------------------------- agricultural_land
  {
    key: 'soilType',
    dataType: 'singleSelect',
    labelAr: 'نوع التربة',
    labelEn: 'Soil Type',
    hardBounds: {},
    options: [
      { code: 'clay', labelAr: 'طينية', labelEn: 'Clay' },
      { code: 'sandy', labelAr: 'رملية', labelEn: 'Sandy' },
      { code: 'loamy', labelAr: 'طميية', labelEn: 'Loamy' },
      { code: 'mixed', labelAr: 'مختلطة', labelEn: 'Mixed' },
      { code: 'other', labelAr: 'أخرى', labelEn: 'Other' },
    ],
  },
  {
    key: 'waterSource',
    dataType: 'singleSelect',
    labelAr: 'مصدر المياه',
    labelEn: 'Water Source',
    hardBounds: {},
    options: [
      { code: 'well', labelAr: 'بئر', labelEn: 'Well' },
      { code: 'canal', labelAr: 'ترعة', labelEn: 'Canal' },
      { code: 'municipal', labelAr: 'شبكة مياه', labelEn: 'Municipal Supply' },
      { code: 'none', labelAr: 'بدون', labelEn: 'None' },
    ],
  },
  {
    key: 'irrigationTypes',
    dataType: 'multiSelect',
    labelAr: 'أنظمة الري',
    labelEn: 'Irrigation Types',
    hardBounds: { maxItems: 5 },
    options: [
      { code: 'drip', labelAr: 'تنقيط', labelEn: 'Drip' },
      { code: 'sprinkler', labelAr: 'رش', labelEn: 'Sprinkler' },
      { code: 'flood', labelAr: 'غمر', labelEn: 'Flood' },
      { code: 'pivot', labelAr: 'محوري', labelEn: 'Pivot' },
      { code: 'other', labelAr: 'أخرى', labelEn: 'Other' },
    ],
  },
  {
    key: 'plotShape',
    dataType: 'singleSelect',
    labelAr: 'شكل الأرض',
    labelEn: 'Plot Shape',
    hardBounds: {},
    options: [
      { code: 'regular', labelAr: 'منتظم', labelEn: 'Regular' },
      { code: 'irregular', labelAr: 'غير منتظم', labelEn: 'Irregular' },
      { code: 'rectangular', labelAr: 'مستطيل', labelEn: 'Rectangular' },
      { code: 'square', labelAr: 'مربع', labelEn: 'Square' },
      { code: 'other', labelAr: 'أخرى', labelEn: 'Other' },
    ],
  },
  {
    key: 'hasRoadAccess',
    dataType: 'boolean',
    labelAr: 'وصول مباشر لطريق',
    labelEn: 'Direct Road Access',
    hardBounds: {},
  },
  {
    key: 'roadFrontageM',
    dataType: 'decimal',
    unit: 'm',
    labelAr: 'عرض واجهة الطريق',
    labelEn: 'Road Frontage',
    hardBounds: { min: 0, max: BROAD_LENGTH_MAX_M, scale: SCALE },
  },
];

const IDENTITY_FIELDS = ['dataType', 'unit'] as const;

function optionCodes(options?: readonly Phase8AttributeOption[]): string[] {
  return [...(options ?? [])].map((option) => option.code).sort();
}

/** Builds the registry document for one Phase 8 seed entry (mirrors migration 025's registryDocument, kept independent so 025 is never touched). */
export function phase8RegistryDocument(seed: Phase8AttributeSeed, now: Date): Document {
  const select = seed.dataType === 'singleSelect' || seed.dataType === 'multiSelect';
  return {
    key: seed.key,
    dataType: seed.dataType,
    ...(seed.unit ? { unit: seed.unit } : {}),
    labelAr: seed.labelAr,
    labelEn: seed.labelEn,
    hardBounds: { ...seed.hardBounds },
    ...(select ? { optionSource: 'inline' } : {}),
    ...(seed.options
      ? { options: seed.options.map((option) => ({ code: option.code, labelAr: option.labelAr, labelEn: option.labelEn, status: 'active' })) }
      : {}),
    status: 'active',
    origin: 'system',
    createdAt: now,
    updatedAt: now,
  };
}

/** Seed keys that are missing, already present with the same identity, or present with a different identity/options. */
export async function scanPhase8RegistrySeed(db: Db) {
  const existing = await db.collection(ATTRIBUTES).find({ key: { $in: PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.map((seed) => seed.key) } }).toArray();
  const byKey = new Map(existing.map((document) => [document.key as string, document]));
  const missing: string[] = [];
  const matching: string[] = [];
  const conflicting: string[] = [];
  for (const seed of PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED) {
    const stored = byKey.get(seed.key);
    if (!stored) { missing.push(seed.key); continue; }
    const identityMatches = IDENTITY_FIELDS.every((field) => (stored[field] ?? null) === ((phase8RegistryDocument(seed, new Date()) as any)[field] ?? null));
    const optionsMatch = JSON.stringify(optionCodes(stored.options)) === JSON.stringify(optionCodes(seed.options));
    if (identityMatches && optionsMatch) matching.push(seed.key);
    else conflicting.push(seed.key);
  }
  const inactive = existing.filter((document) => document.status !== 'active').map((document) => document.key as string);
  return { missing, matching, conflicting, inactive };
}

export async function seedPhase8Registry(db: Db, now: Date): Promise<number> {
  await ensureSchemaIndexes(db, ATTRIBUTES, PropertyAttributeSchema);
  let inserted = 0;
  for (const seed of PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED) {
    // Insert-only: an existing key is never modified (identity is immutable).
    const result = await db.collection(ATTRIBUTES).updateOne({ key: seed.key }, { $setOnInsert: phase8RegistryDocument(seed, now) }, { upsert: true });
    inserted += result.upsertedCount ?? 0;
  }
  return inserted;
}
