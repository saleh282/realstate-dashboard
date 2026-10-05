'use strict';

const { BadRequestException } = require('../../common/http/errors');
const { Types } = require('mongoose');
const { PropertyErrorCode } = require('../../common/errors/property-error-codes');
/**
 * Multi-property-type classification (DPF-005).
 *
 * `purposeSubcategoryId` stays the single PRIMARY type; `purposeSubcategoryIds`
 * holds every selected type, primary included, in one canonical order
 * (ascending lowercase ObjectId hex). The array order never identifies the
 * primary.
 */
const MAX_PROPERTY_TYPES = 4;
var PropertySubcategoriesInvalidReason;
(function (PropertySubcategoriesInvalidReason) {
  PropertySubcategoriesInvalidReason['EMPTY'] = 'EMPTY';
  PropertySubcategoriesInvalidReason['TOO_MANY'] = 'TOO_MANY';
  PropertySubcategoriesInvalidReason['DUPLICATE'] = 'DUPLICATE';
  PropertySubcategoriesInvalidReason['PRIMARY_NOT_INCLUDED'] = 'PRIMARY_NOT_INCLUDED';
  PropertySubcategoriesInvalidReason['INACTIVE'] = 'INACTIVE';
})(PropertySubcategoriesInvalidReason || (PropertySubcategoriesInvalidReason = {}));
/**
 * Read fallback: records written before DPF-005 carry only the primary, which
 * is read as a one-element selection. Records with no primary read as [].
 */
function selectedPropertyTypeIds(source) {
  if (source?.purposeSubcategoryIds?.length) return [...source.purposeSubcategoryIds];
  return source?.purposeSubcategoryId ? [source.purposeSubcategoryId] : [];
}
/** Canonical order for a list of ObjectId-like values; keeps duplicates so callers can still detect them. */
function canonicalPropertyTypeOrder(ids) {
  return ids.map((id) => String(id).toLowerCase()).sort();
}
function subcategoriesInvalid(reason, extra = {}) {
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
function normalizeSelectedPropertyTypeIds(primaryId, ids) {
  if (!ids.length) throw subcategoriesInvalid(PropertySubcategoriesInvalidReason.EMPTY);
  if (ids.length > MAX_PROPERTY_TYPES) {
    throw subcategoriesInvalid(PropertySubcategoriesInvalidReason.TOO_MANY, {
      maxPropertyTypes: MAX_PROPERTY_TYPES,
    });
  }
  const canonical = canonicalPropertyTypeOrder(ids);
  const duplicates = [...new Set(canonical.filter((id, index) => canonical.indexOf(id) !== index))];
  if (duplicates.length)
    throw subcategoriesInvalid(PropertySubcategoriesInvalidReason.DUPLICATE, {
      invalidIds: duplicates,
    });
  const primary = primaryId.toLowerCase();
  if (!canonical.includes(primary)) {
    throw subcategoriesInvalid(PropertySubcategoriesInvalidReason.PRIMARY_NOT_INCLUDED, {
      invalidIds: [primary],
    });
  }
  return canonical;
}
const toObjectIds = (ids) => ids.map((id) => new Types.ObjectId(id));

Object.assign(exports, {
  MAX_PROPERTY_TYPES,
  PropertySubcategoriesInvalidReason,
  selectedPropertyTypeIds,
  canonicalPropertyTypeOrder,
  subcategoriesInvalid,
  normalizeSelectedPropertyTypeIds,
  toObjectIds,
});
