'use strict';

const { Transform, Type } = require('class-transformer');
const {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} = require('class-validator');
const { MONEY_MINOR_MAX } = require('../../common/money/money');
const {
  PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED,
} = require('../../migrations/029-non-residential-attribute-registry');
const { PHASE9_PROMOTED_FACET_KEYS } = require('../../migrations/030-phase9-facet-promotion');
const trimmed = ({ value }) => (typeof value === 'string' ? value.trim() : value);
/**
 * Phase 9 (Search & Facets): the 7 approved promoted facets' option codes and
 * hard bounds, read from the same registry seed the migration promotes —
 * never a hand-duplicated list. Only `PHASE9_PROMOTED_FACET_KEYS` are exposed
 * here; the other 10 Phase 8 attributes stay presentation-only and get no
 * query parameter.
 */
const PHASE9_SEED_BY_KEY = new Map(
  PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.map((entry) => [entry.key, entry]),
);
function phase9OptionCodes(key) {
  return [...(PHASE9_SEED_BY_KEY.get(key)?.options ?? [])].map((option) => option.code);
}
const BUILT_AREA_SQM_BOUNDS = PHASE9_SEED_BY_KEY.get('builtAreaSqm').hardBounds;
if (!PHASE9_PROMOTED_FACET_KEYS.every((key) => PHASE9_SEED_BY_KEY.has(key))) {
  throw new Error('Phase 9 promoted facet key missing from the Phase 8 registry seed');
}
/** Normalizes a repeated query param (`?x=a&x=b` or a single `?x=a`) into a deduplicated array, or undefined if absent. */
const toUniqueArray = ({ value }) => {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values)];
};
const PROPERTY_SEARCH_SORTS = ['newest', 'price_asc', 'price_desc'];
/**
 * Query contract for `GET /properties` (MAZAD-021 public marketplace search).
 * Every field is optional; an absent field means "no filter on this
 * dimension". Operation type supports `sale` and `rent`.
 */
class ListPublishedPropertiesDto {}
Min(1)(ListPublishedPropertiesDto.prototype, 'page');
IsInt()(ListPublishedPropertiesDto.prototype, 'page');
Type(() => Number)(ListPublishedPropertiesDto.prototype, 'page');
IsOptional()(ListPublishedPropertiesDto.prototype, 'page');
Max(50)(ListPublishedPropertiesDto.prototype, 'limit');
Min(1)(ListPublishedPropertiesDto.prototype, 'limit');
IsInt()(ListPublishedPropertiesDto.prototype, 'limit');
Type(() => Number)(ListPublishedPropertiesDto.prototype, 'limit');
IsOptional()(ListPublishedPropertiesDto.prototype, 'limit');
IsIn(['sale', 'rent'])(ListPublishedPropertiesDto.prototype, 'operationType');
IsOptional()(ListPublishedPropertiesDto.prototype, 'operationType');
IsMongoId()(ListPublishedPropertiesDto.prototype, 'purposeCategoryId');
IsOptional()(ListPublishedPropertiesDto.prototype, 'purposeCategoryId');
IsMongoId()(ListPublishedPropertiesDto.prototype, 'purposeSubcategoryId');
IsOptional()(ListPublishedPropertiesDto.prototype, 'purposeSubcategoryId');
MaxLength(50)(ListPublishedPropertiesDto.prototype, 'governorateCode');
IsString()(ListPublishedPropertiesDto.prototype, 'governorateCode');
Transform(trimmed)(ListPublishedPropertiesDto.prototype, 'governorateCode');
IsOptional()(ListPublishedPropertiesDto.prototype, 'governorateCode');
MaxLength(100)(ListPublishedPropertiesDto.prototype, 'city');
IsString()(ListPublishedPropertiesDto.prototype, 'city');
Transform(trimmed)(ListPublishedPropertiesDto.prototype, 'city');
IsOptional()(ListPublishedPropertiesDto.prototype, 'city');
Max(MONEY_MINOR_MAX)(ListPublishedPropertiesDto.prototype, 'minPriceMinor');
Min(0)(ListPublishedPropertiesDto.prototype, 'minPriceMinor');
IsInt()(ListPublishedPropertiesDto.prototype, 'minPriceMinor');
Type(() => Number)(ListPublishedPropertiesDto.prototype, 'minPriceMinor');
IsOptional()(ListPublishedPropertiesDto.prototype, 'minPriceMinor');
Max(MONEY_MINOR_MAX)(ListPublishedPropertiesDto.prototype, 'maxPriceMinor');
Min(0)(ListPublishedPropertiesDto.prototype, 'maxPriceMinor');
IsInt()(ListPublishedPropertiesDto.prototype, 'maxPriceMinor');
Type(() => Number)(ListPublishedPropertiesDto.prototype, 'maxPriceMinor');
IsOptional()(ListPublishedPropertiesDto.prototype, 'maxPriceMinor');
MaxLength(120)(ListPublishedPropertiesDto.prototype, 'q');
IsString()(ListPublishedPropertiesDto.prototype, 'q');
Transform(trimmed)(ListPublishedPropertiesDto.prototype, 'q');
IsOptional()(ListPublishedPropertiesDto.prototype, 'q');
IsIn(PROPERTY_SEARCH_SORTS)(ListPublishedPropertiesDto.prototype, 'sort');
IsOptional()(ListPublishedPropertiesDto.prototype, 'sort');
IsIn(phase9OptionCodes('shopFloorLevel'))(ListPublishedPropertiesDto.prototype, 'shopFloorLevel');
Transform(trimmed)(ListPublishedPropertiesDto.prototype, 'shopFloorLevel');
IsOptional()(ListPublishedPropertiesDto.prototype, 'shopFloorLevel');
IsIn(phase9OptionCodes('commercialUseTypes'), { each: true })(
  ListPublishedPropertiesDto.prototype,
  'commercialUseTypes',
);
ArrayMaxSize(PHASE9_SEED_BY_KEY.get('commercialUseTypes').hardBounds.maxItems ?? 6)(
  ListPublishedPropertiesDto.prototype,
  'commercialUseTypes',
);
IsArray()(ListPublishedPropertiesDto.prototype, 'commercialUseTypes');
Transform(toUniqueArray)(ListPublishedPropertiesDto.prototype, 'commercialUseTypes');
IsOptional()(ListPublishedPropertiesDto.prototype, 'commercialUseTypes');
Max(BUILT_AREA_SQM_BOUNDS.max ?? Number.MAX_SAFE_INTEGER)(
  ListPublishedPropertiesDto.prototype,
  'minBuiltAreaSqm',
);
Min(BUILT_AREA_SQM_BOUNDS.min ?? 0)(ListPublishedPropertiesDto.prototype, 'minBuiltAreaSqm');
IsNumber()(ListPublishedPropertiesDto.prototype, 'minBuiltAreaSqm');
Type(() => Number)(ListPublishedPropertiesDto.prototype, 'minBuiltAreaSqm');
IsOptional()(ListPublishedPropertiesDto.prototype, 'minBuiltAreaSqm');
Max(BUILT_AREA_SQM_BOUNDS.max ?? Number.MAX_SAFE_INTEGER)(
  ListPublishedPropertiesDto.prototype,
  'maxBuiltAreaSqm',
);
Min(BUILT_AREA_SQM_BOUNDS.min ?? 0)(ListPublishedPropertiesDto.prototype, 'maxBuiltAreaSqm');
IsNumber()(ListPublishedPropertiesDto.prototype, 'maxBuiltAreaSqm');
Type(() => Number)(ListPublishedPropertiesDto.prototype, 'maxBuiltAreaSqm');
IsOptional()(ListPublishedPropertiesDto.prototype, 'maxBuiltAreaSqm');
IsIn(phase9OptionCodes('powerSource'))(ListPublishedPropertiesDto.prototype, 'powerSource');
Transform(trimmed)(ListPublishedPropertiesDto.prototype, 'powerSource');
IsOptional()(ListPublishedPropertiesDto.prototype, 'powerSource');
IsIn(phase9OptionCodes('industrialUseType'))(
  ListPublishedPropertiesDto.prototype,
  'industrialUseType',
);
Transform(trimmed)(ListPublishedPropertiesDto.prototype, 'industrialUseType');
IsOptional()(ListPublishedPropertiesDto.prototype, 'industrialUseType');
IsIn(phase9OptionCodes('soilType'))(ListPublishedPropertiesDto.prototype, 'soilType');
Transform(trimmed)(ListPublishedPropertiesDto.prototype, 'soilType');
IsOptional()(ListPublishedPropertiesDto.prototype, 'soilType');
IsIn(phase9OptionCodes('waterSource'))(ListPublishedPropertiesDto.prototype, 'waterSource');
Transform(trimmed)(ListPublishedPropertiesDto.prototype, 'waterSource');
IsOptional()(ListPublishedPropertiesDto.prototype, 'waterSource');

Object.assign(exports, { PROPERTY_SEARCH_SORTS, ListPublishedPropertiesDto });
