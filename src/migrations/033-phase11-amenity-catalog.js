'use strict';

/**
 * Phase 11 (Type-Aware Amenities): seeds 5 new engineering-approved amenity
 * catalog entries (fire_safety, accessibility, storage_yard, fenced,
 * drainage). Insert-only ($setOnInsert): an existing amenity document —
 * including the 7 seeded by the pre-legacy baseline catalog
 * (`seeds/baseline-catalog.seed.ts`) — is never modified. Mirrors that
 * script's amenity document shape exactly (same `amenities` collection,
 * same fields), but runs through the ledger-tracked migration framework so
 * it is dry-run-able and idempotent like every other Phase 8-10 seed.
 */
const AMENITIES = 'amenities';
const PHASE11_NEW_AMENITY_SEED = [
  {
    code: 'fire_safety',
    nameAr: 'أنظمة السلامة ومكافحة الحريق',
    nameEn: 'Fire Safety',
    iconKey: 'fire_safety',
    category: 'feature',
    sortOrder: 8,
  },
  {
    code: 'accessibility',
    nameAr: 'سهولة الوصول لذوي الإعاقة',
    nameEn: 'Accessibility',
    iconKey: 'accessibility',
    category: 'feature',
    sortOrder: 9,
  },
  {
    code: 'storage_yard',
    nameAr: 'ساحة تخزين',
    nameEn: 'Storage Yard',
    iconKey: 'storage_yard',
    category: 'facility',
    sortOrder: 10,
  },
  {
    code: 'fenced',
    nameAr: 'مسوّر',
    nameEn: 'Fenced',
    iconKey: 'fenced',
    category: 'feature',
    sortOrder: 11,
  },
  {
    code: 'drainage',
    nameAr: 'نظام صرف',
    nameEn: 'Drainage',
    iconKey: 'drainage',
    category: 'feature',
    sortOrder: 12,
  },
];
/** The 7 pre-existing (pre-legacy baseline) amenities; never touched by this migration. */
const PHASE11_PRE_EXISTING_AMENITY_CODES = [
  'elevator',
  'parking',
  'security',
  'garden',
  'pool',
  'balcony',
  'air_conditioning',
];
function phase11AmenityDocument(seed, createdBy, now) {
  return {
    code: seed.code,
    nameAr: seed.nameAr,
    nameEn: seed.nameEn,
    iconKey: seed.iconKey,
    category: seed.category,
    isActive: true,
    sortOrder: seed.sortOrder,
    usageCount: 0,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
}
/** Seed codes that are missing, already present with the same identity, or present with a different identity. */
async function scanPhase11AmenitySeed(db) {
  const existing = await db
    .collection(AMENITIES)
    .find({ code: { $in: PHASE11_NEW_AMENITY_SEED.map((seed) => seed.code) } })
    .toArray();
  const byCode = new Map(existing.map((document) => [document.code, document]));
  const missing = [];
  const matching = [];
  const conflicting = [];
  for (const seed of PHASE11_NEW_AMENITY_SEED) {
    const stored = byCode.get(seed.code);
    if (!stored) {
      missing.push(seed.code);
      continue;
    }
    const identityMatches =
      stored.nameAr === seed.nameAr &&
      stored.nameEn === seed.nameEn &&
      stored.iconKey === seed.iconKey &&
      stored.category === seed.category;
    if (identityMatches) matching.push(seed.code);
    else conflicting.push(seed.code);
  }
  return { missing, matching, conflicting };
}
/** The 7 pre-existing amenities are exactly present, untouched (identity is not re-checked here; migration 033 never writes to them). */
async function scanExistingAmenityCatalog(db) {
  const count = await db
    .collection(AMENITIES)
    .countDocuments({ code: { $in: [...PHASE11_PRE_EXISTING_AMENITY_CODES] } });
  return { count, expected: PHASE11_PRE_EXISTING_AMENITY_CODES.length };
}
async function seedPhase11Amenities(db, now) {
  const admin = await db
    .collection('users')
    .findOne({ systemRole: 'SUPER_ADMIN' }, { projection: { _id: 1 } });
  if (!admin?._id) throw new Error('A SUPER_ADMIN must exist before amenity catalog seeding');
  let inserted = 0;
  for (const seed of PHASE11_NEW_AMENITY_SEED) {
    // Insert-only: an existing code is never modified (identity is immutable once seeded).
    const result = await db
      .collection(AMENITIES)
      .updateOne(
        { code: seed.code },
        { $setOnInsert: phase11AmenityDocument(seed, admin._id, now) },
        { upsert: true },
      );
    inserted += result.upsertedCount ? 1 : 0;
  }
  return inserted;
}

Object.assign(exports, {
  PHASE11_NEW_AMENITY_SEED,
  PHASE11_PRE_EXISTING_AMENITY_CODES,
  phase11AmenityDocument,
  scanPhase11AmenitySeed,
  scanExistingAmenityCatalog,
  seedPhase11Amenities,
});
