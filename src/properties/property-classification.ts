import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PropertyErrorCode } from '../common/errors/property-error-codes';

/**
 * Multi-property-type classification (DPF-005).
 *
 * `purposeSubcategoryId` stays the single PRIMARY type; `purposeSubcategoryIds`
 * holds every selected type, primary included, in one canonical order
 * (ascending lowercase ObjectId hex). The array order never identifies the
 * primary.
 */
export const MAX_PROPERTY_TYPES = 4;

export enum PropertySubcategoriesInvalidReason {
  EMPTY = 'EMPTY',
  TOO_MANY = 'TOO_MANY',
  DUPLICATE = 'DUPLICATE',
  PRIMARY_NOT_INCLUDED = 'PRIMARY_NOT_INCLUDED',
  INACTIVE = 'INACTIVE',
}

type ClassificationSource = { purposeSubcategoryId?: unknown; purposeSubcategoryIds?: unknown[] | null } | null | undefined;

/**
 * Read fallback: records written before DPF-005 carry only the primary, which
 * is read as a one-element selection. Records with no primary read as [].
 */
export function selectedPropertyTypeIds<T = unknown>(source: ClassificationSource): T[] {
  if (source?.purposeSubcategoryIds?.length) return [...source.purposeSubcategoryIds] as T[];
  return source?.purposeSubcategoryId ? [source.purposeSubcategoryId as T] : [];
}

/** Canonical order for a list of ObjectId-like values; keeps duplicates so callers can still detect them. */
export function canonicalPropertyTypeOrder(ids: readonly unknown[]): string[] {
  return ids.map((id) => String(id).toLowerCase()).sort();
}

export function subcategoriesInvalid(reason: PropertySubcategoriesInvalidReason, extra: Record<string, unknown> = {}) {
  return new BadRequestException({
    message: 'أنواع العقار المختارة غير صالحة',
    code: PropertyErrorCode.SUBCATEGORIES_INVALID,
    details: { reason, ...extra },
  });
}

/**
 * Structural rules for an explicitly supplied selection (no catalog access):
 * 1..MAX_PROPERTY_TYPES entries, no duplicates, primary included. Returns the
 * canonical lowercase-hex selection.
 */
export function normalizeSelectedPropertyTypeIds(primaryId: string, ids: readonly string[]): string[] {
  if (!ids.length) throw subcategoriesInvalid(PropertySubcategoriesInvalidReason.EMPTY);
  if (ids.length > MAX_PROPERTY_TYPES) {
    throw subcategoriesInvalid(PropertySubcategoriesInvalidReason.TOO_MANY, { maxPropertyTypes: MAX_PROPERTY_TYPES });
  }
  const canonical = canonicalPropertyTypeOrder(ids);
  const duplicates = [...new Set(canonical.filter((id, index) => canonical.indexOf(id) !== index))];
  if (duplicates.length) throw subcategoriesInvalid(PropertySubcategoriesInvalidReason.DUPLICATE, { invalidIds: duplicates });
  const primary = primaryId.toLowerCase();
  if (!canonical.includes(primary)) {
    throw subcategoriesInvalid(PropertySubcategoriesInvalidReason.PRIMARY_NOT_INCLUDED, { invalidIds: [primary] });
  }
  return canonical;
}

export const toObjectIds = (ids: readonly string[]) => ids.map((id) => new Types.ObjectId(id));
