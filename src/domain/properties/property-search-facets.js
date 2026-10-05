'use strict';

const {
  PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED,
} = require('../../migrations/029-non-residential-attribute-registry');
const { PHASE9_PROMOTED_FACET_KEYS } = require('../../migrations/030-phase9-facet-promotion');
const SEED_BY_KEY = new Map(
  PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.map((entry) => [entry.key, entry]),
);
function seeded(key, filterKind, applicablePropertyTypeCodes) {
  const seed = SEED_BY_KEY.get(key);
  if (!seed)
    throw new Error(`Phase 9 facet metadata references an unknown Phase 8 attribute key: ${key}`);
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
const PHASE9_FACET_METADATA = [
  seeded('shopFloorLevel', 'exact', ['shop']),
  seeded('commercialUseTypes', 'multi', ['shop']),
  seeded('builtAreaSqm', 'range', ['factory']),
  seeded('powerSource', 'exact', ['factory']),
  seeded('industrialUseType', 'exact', ['factory']),
  seeded('soilType', 'exact', ['agricultural_land']),
  seeded('waterSource', 'exact', ['agricultural_land']),
];
if (
  PHASE9_FACET_METADATA.length !== PHASE9_PROMOTED_FACET_KEYS.length ||
  !PHASE9_PROMOTED_FACET_KEYS.every((key) =>
    PHASE9_FACET_METADATA.some((entry) => entry.key === key),
  )
) {
  throw new Error('Phase 9 facet metadata does not exactly match the approved promoted facet keys');
}
/** Facets applicable to one property type code, in the fixed metadata order. */
function facetMetadataForPropertyTypeCode(code) {
  return PHASE9_FACET_METADATA.filter((entry) => entry.applicablePropertyTypeCodes.includes(code));
}

Object.assign(exports, { PHASE9_FACET_METADATA, facetMetadataForPropertyTypeCode });
