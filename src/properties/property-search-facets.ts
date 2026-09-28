import { PropertyAttributeDataType, PropertyAttributeUnit } from '../property-attributes/property-attribute.constants';
import { PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED, Phase8AttributeOption } from '../migrations/029-non-residential-attribute-registry';
import { PHASE9_PROMOTED_FACET_KEYS } from '../migrations/030-phase9-facet-promotion';

/**
 * Phase 9 (Search & Facets) filter-metadata contract (`GET /properties/filter-metadata`).
 * Searchability, `filterKind` and per-type applicability are explicit,
 * engineering-owned configuration here — never derived automatically from a
 * FormDefinition's fields, so a field being on a type's form never by itself
 * makes it a filter. Labels/units/option labels are sourced from the Attribute
 * Registry seed to avoid duplicated translations.
 */
export type FacetFilterKind = 'exact' | 'range' | 'multi';

export type PromotedFacetMetadata = {
  key: string;
  labelAr: string;
  labelEn: string;
  dataType: PropertyAttributeDataType;
  filterKind: FacetFilterKind;
  unit?: PropertyAttributeUnit;
  options?: readonly Phase8AttributeOption[];
  /** `PropertyType.code` values this facet applies to. */
  applicablePropertyTypeCodes: readonly string[];
};

const SEED_BY_KEY = new Map(PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.map((entry) => [entry.key, entry]));

function seeded(key: string, filterKind: FacetFilterKind, applicablePropertyTypeCodes: readonly string[]): PromotedFacetMetadata {
  const seed = SEED_BY_KEY.get(key);
  if (!seed) throw new Error(`Phase 9 facet metadata references an unknown Phase 8 attribute key: ${key}`);
  return {
    key: seed.key,
    labelAr: seed.labelAr,
    labelEn: seed.labelEn,
    dataType: seed.dataType,
    filterKind,
    ...(seed.unit ? { unit: seed.unit } : {}),
    ...(seed.options ? { options: seed.options } : {}),
    applicablePropertyTypeCodes,
  };
}

/** Deterministic order: shop, then factory, then agricultural_land — the Phase 9 approved promotion order. */
export const PHASE9_FACET_METADATA: readonly PromotedFacetMetadata[] = [
  seeded('shopFloorLevel', 'exact', ['shop']),
  seeded('commercialUseTypes', 'multi', ['shop']),
  seeded('builtAreaSqm', 'range', ['factory']),
  seeded('powerSource', 'exact', ['factory']),
  seeded('industrialUseType', 'exact', ['factory']),
  seeded('soilType', 'exact', ['agricultural_land']),
  seeded('waterSource', 'exact', ['agricultural_land']),
];

if (PHASE9_FACET_METADATA.length !== PHASE9_PROMOTED_FACET_KEYS.length || !PHASE9_PROMOTED_FACET_KEYS.every((key) => PHASE9_FACET_METADATA.some((entry) => entry.key === key))) {
  throw new Error('Phase 9 facet metadata does not exactly match the approved promoted facet keys');
}

/** Facets applicable to one property type code, in the fixed metadata order. */
export function facetMetadataForPropertyTypeCode(code: string): PromotedFacetMetadata[] {
  return PHASE9_FACET_METADATA.filter((entry) => entry.applicablePropertyTypeCodes.includes(code));
}
