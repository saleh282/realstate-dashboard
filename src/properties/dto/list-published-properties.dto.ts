import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsMongoId, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MONEY_MINOR_MAX } from '../../common/money/money';
import { PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED } from '../../migrations/029-non-residential-attribute-registry';
import { PHASE9_PROMOTED_FACET_KEYS } from '../../migrations/030-phase9-facet-promotion';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Phase 9 (Search & Facets): the 7 approved promoted facets' option codes and
 * hard bounds, read from the same registry seed the migration promotes —
 * never a hand-duplicated list. Only `PHASE9_PROMOTED_FACET_KEYS` are exposed
 * here; the other 10 Phase 8 attributes stay presentation-only and get no
 * query parameter.
 */
const PHASE9_SEED_BY_KEY = new Map(PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.map((entry) => [entry.key, entry]));
function phase9OptionCodes(key: string): string[] {
  return [...(PHASE9_SEED_BY_KEY.get(key)?.options ?? [])].map((option) => option.code);
}
const BUILT_AREA_SQM_BOUNDS = PHASE9_SEED_BY_KEY.get('builtAreaSqm')!.hardBounds;
if (!PHASE9_PROMOTED_FACET_KEYS.every((key) => PHASE9_SEED_BY_KEY.has(key))) {
  throw new Error('Phase 9 promoted facet key missing from the Phase 8 registry seed');
}

/** Normalizes a repeated query param (`?x=a&x=b` or a single `?x=a`) into a deduplicated array, or undefined if absent. */
const toUniqueArray = ({ value }: { value: unknown }) => {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values)];
};

export const PROPERTY_SEARCH_SORTS = ['newest', 'price_asc', 'price_desc'] as const;
export type PropertySearchSort = (typeof PROPERTY_SEARCH_SORTS)[number];

/**
 * Query contract for `GET /properties` (MAZAD-021 public marketplace search).
 * Every field is optional; an absent field means "no filter on this
 * dimension". Auction mode is intentionally not offered here yet: the schema
 * only knows `sale`/`rent` until bidding/auctions are implemented.
 */
export class ListPublishedPropertiesDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;

  @IsOptional() @IsIn(['sale', 'rent']) operationType?: string;

  @IsOptional() @IsMongoId() purposeCategoryId?: string;
  @IsOptional() @IsMongoId() purposeSubcategoryId?: string;

  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(50) governorateCode?: string;
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(100) city?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(MONEY_MINOR_MAX) minPriceMinor?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(MONEY_MINOR_MAX) maxPriceMinor?: number;

  /** Free-text keyword, matched against title/city/district (same pattern as the admin search). */
  @IsOptional() @Transform(trimmed) @IsString() @MaxLength(120) q?: string;

  @IsOptional() @IsIn(PROPERTY_SEARCH_SORTS) sort?: PropertySearchSort;

  // ---------------------------------------------------------------------
  // Phase 9 (Search & Facets): explicit typed parameters for the 7 approved
  // promoted facets only. No `facet[key]`/`attr[key]`/generic filter object —
  // every promoted facet gets its own named, validated parameter. A facet
  // irrelevant to the resolved type/purpose is not rejected; it simply
  // narrows the query to zero rows for a type that never carries it.
  // ---------------------------------------------------------------------

  @IsOptional() @Transform(trimmed) @IsIn(phase9OptionCodes('shopFloorLevel')) shopFloorLevel?: string;

  /** OR within this field (Mongo `$in`); AND against every other facet parameter. */
  @IsOptional()
  @Transform(toUniqueArray)
  @IsArray()
  @ArrayMaxSize(PHASE9_SEED_BY_KEY.get('commercialUseTypes')!.hardBounds.maxItems ?? 6)
  @IsIn(phase9OptionCodes('commercialUseTypes'), { each: true })
  commercialUseTypes?: string[];

  @IsOptional() @Type(() => Number) @IsNumber() @Min(BUILT_AREA_SQM_BOUNDS.min ?? 0) @Max(BUILT_AREA_SQM_BOUNDS.max ?? Number.MAX_SAFE_INTEGER) minBuiltAreaSqm?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(BUILT_AREA_SQM_BOUNDS.min ?? 0) @Max(BUILT_AREA_SQM_BOUNDS.max ?? Number.MAX_SAFE_INTEGER) maxBuiltAreaSqm?: number;

  @IsOptional() @Transform(trimmed) @IsIn(phase9OptionCodes('powerSource')) powerSource?: string;
  @IsOptional() @Transform(trimmed) @IsIn(phase9OptionCodes('industrialUseType')) industrialUseType?: string;
  @IsOptional() @Transform(trimmed) @IsIn(phase9OptionCodes('soilType')) soilType?: string;
  @IsOptional() @Transform(trimmed) @IsIn(phase9OptionCodes('waterSource')) waterSource?: string;
}
