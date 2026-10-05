'use strict';

const { BadRequestException, ConflictException } = require('../../common/http/errors');
const { PropertyErrorCode } = require('../../common/errors/property-error-codes');
const { EvidenceErrorCode } = require('../../common/errors/evidence-error-codes');
const {
  isWellFormedText,
  normalizeAttributeToken,
} = require('../../common/validators/property-attributes/index');
const {
  LEGACY_ATTRIBUTE_KEYS,
  LEGACY_PROPERTY_ATTRIBUTE_SEED,
  LEGACY_SPEC_FIELD_TO_ATTRIBUTE,
  LEGACY_SPEC_FIELDS,
  PROPERTY_ATTRIBUTE_FACET_KEYS,
} = require('../property-attributes/property-attribute.constants');
const {
  PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED,
} = require('../../migrations/029-non-residential-attribute-registry');
const { PHASE9_PROMOTED_FACET_KEYS } = require('../../migrations/030-phase9-facet-promotion');
const {
  CURRENT_RENDERER_VERSION,
  SHIPPED_MEDIA_PROFILES,
  computeFormContentHash,
} = require('../property-form-definitions/property-form-definition.constants');
const { mediaProfileDefinition, requiredSlots } = require('./media-profiles');
const id = (value) => String(value).toLowerCase();
/** `details.reason` of PROPERTY_FORM_DEFINITION_INVALID. */
var FormDefinitionInvalidReason;
(function (FormDefinitionInvalidReason) {
  /** `attributes` or another pin field was sent without `formDefinitionVersionId` (frozen §B1). */
  FormDefinitionInvalidReason['VERSION_ID_REQUIRED'] = 'VERSION_ID_REQUIRED';
  FormDefinitionInvalidReason['VERSION_NOT_FOUND'] = 'VERSION_NOT_FOUND';
  /** The version is a draft (frozen §B8). */
  FormDefinitionInvalidReason['VERSION_NOT_PUBLISHED'] = 'VERSION_NOT_PUBLISHED';
  /** The version belongs to another property type than the PRIMARY one. */
  FormDefinitionInvalidReason['SUBCATEGORY_MISMATCH'] = 'SUBCATEGORY_MISMATCH';
  /** The version, or the sent `formDefinitionId`, is not the primary type's definition. */
  FormDefinitionInvalidReason['DEFINITION_MISMATCH'] = 'DEFINITION_MISMATCH';
  FormDefinitionInvalidReason['VERSION_NUMBER_MISMATCH'] = 'VERSION_NUMBER_MISMATCH';
  FormDefinitionInvalidReason['CONTENT_HASH_MISMATCH'] = 'CONTENT_HASH_MISMATCH';
  FormDefinitionInvalidReason['RENDERER_UNSUPPORTED'] = 'RENDERER_UNSUPPORTED';
  FormDefinitionInvalidReason['MEDIA_PROFILE_UNSUPPORTED'] = 'MEDIA_PROFILE_UNSUPPORTED';
  /** The stored content no longer hashes to its recorded `contentHash`. */
  FormDefinitionInvalidReason['VERSION_INTEGRITY'] = 'VERSION_INTEGRITY';
})(FormDefinitionInvalidReason || (FormDefinitionInvalidReason = {}));
function formDefinitionInvalid(reason, extra = {}) {
  return new BadRequestException({
    message: 'نموذج مواصفات العقار غير صالح؛ أعد تحميل النموذج',
    code: PropertyErrorCode.FORM_DEFINITION_INVALID,
    details: { reason, ...extra },
  });
}
const formDefinitionNotPublished = (purposeSubcategoryId) =>
  new BadRequestException({
    message: 'نوع العقار غير متاح للإضافة حاليًا',
    code: PropertyErrorCode.FORM_DEFINITION_NOT_PUBLISHED,
    details: { purposeSubcategoryId: id(purposeSubcategoryId) },
  });
const formDefinitionArchived = (purposeSubcategoryId) =>
  new BadRequestException({
    message: 'نوع العقار موقوف حاليًا',
    code: PropertyErrorCode.FORM_DEFINITION_ARCHIVED,
    details: { purposeSubcategoryId: id(purposeSubcategoryId) },
  });
const clientUpgradeRequired = (purposeSubcategoryId) =>
  new BadRequestException({
    message: 'حدّث التطبيق لإضافة أو تعديل هذا النوع من العقارات',
    code: PropertyErrorCode.CLIENT_UPGRADE_REQUIRED,
    details: { purposeSubcategoryId: id(purposeSubcategoryId) },
  });
const amenitiesNotEnabled = () =>
  new BadRequestException({
    message: 'المميزات والخدمات غير متاحة لهذا النوع من العقارات',
    code: PropertyErrorCode.AMENITIES_NOT_ENABLED,
  });
const amenityNotAllowed = (amenityCodes) =>
  new BadRequestException({
    message: 'بعض المميزات المختارة غير متاحة لهذا النوع من العقارات',
    code: PropertyErrorCode.AMENITY_NOT_ALLOWED,
    details: { amenityCodes },
  });
/**
 * Phase 11 type-aware amenities, checked at create/save, submit and approval
 * alike (the same three points `amenitiesEnabled` was already checked at).
 * `allowedAmenityCodes` absent is the legacy behavior every version published
 * before Phase 11 has: once enabled, the full active catalog is allowed (the
 * catalog-membership/active check happens elsewhere, unchanged). Present
 * (including an explicit empty array) restricts selection to exactly those
 * codes. A primary-type/version change is covered automatically: this is
 * always checked against the version actually resolved for the write, so a
 * selection valid under a previous type's or version's list is rejected here
 * the moment it no longer belongs to the current one — nothing needs to be
 * separately "cleared" server-side.
 */
function assertAmenitySelection(form, amenityCodes) {
  if (!amenityCodes.length) return;
  if (!form.amenitiesEnabled) throw amenitiesNotEnabled();
  if (form.allowedAmenityCodes === undefined) return;
  const disallowed = amenityCodes.filter((code) => !form.allowedAmenityCodes.includes(code));
  if (disallowed.length) throw amenityNotAllowed(disallowed);
}
/**
 * Frozen §B8 409 (amendment §10: plus the primary's `purposeSubcategoryId`).
 * Carries everything a client needs to fetch the current version and remap:
 * the definition, the submitted pin (null for an unpinned legacy draft) and
 * the current version's id, number, hash and renderer version.
 */
function formVersionOutdated(current, submitted) {
  return new ConflictException({
    message: 'تم تحديث نموذج مواصفات هذا النوع؛ أعد تحميل النموذج وراجع البيانات',
    code: PropertyErrorCode.FORM_VERSION_OUTDATED,
    details: {
      purposeSubcategoryId: id(current.head.purposeSubcategoryId),
      definitionId: id(current.head._id),
      submittedVersionId: submitted?.versionId ? id(submitted.versionId) : null,
      submittedVersion: submitted?.version ?? null,
      currentVersionId: id(current.version._id),
      currentVersion: current.version.version ?? null,
      currentContentHash: current.version.contentHash ?? null,
      rendererVersion: current.version.rendererVersion ?? null,
    },
  });
}
/**
 * The type's current published form (amendment rule 4 / frozen §C, §H6):
 * an archived head is ARCHIVED; a missing head, or a head without a
 * consistent published current version, is NOT_PUBLISHED.
 */
function currentPublishedForm(purposeSubcategoryId, state) {
  const head = state.headByType.get(id(purposeSubcategoryId));
  if (!head) throw formDefinitionNotPublished(purposeSubcategoryId);
  if (head.status !== 'active') throw formDefinitionArchived(purposeSubcategoryId);
  const version = head.currentVersionId
    ? state.versionById.get(id(head.currentVersionId))
    : undefined;
  if (
    !version ||
    version.state !== 'published' ||
    id(version.definitionId) !== id(head._id) ||
    id(version.purposeSubcategoryId) !== id(purposeSubcategoryId)
  ) {
    throw formDefinitionNotPublished(purposeSubcategoryId);
  }
  return { head, version };
}
/** Amendment rule 4 for every selected type, in the given order; the first failure is reported. */
function assertListingEnabled(typeIds, state) {
  for (const typeId of typeIds) currentPublishedForm(typeId, state);
}
function isListingEnabled(typeId, state) {
  try {
    currentPublishedForm(typeId, state);
    return true;
  } catch {
    return false;
  }
}
/** Recomputes the frozen §A3 content hash from a stored version document. */
function storedFormContentHash(version) {
  return computeFormContentHash({
    rendererVersion: version.rendererVersion,
    fields: version.fields,
    mediaProfile: version.mediaProfile,
    amenitiesEnabled: version.amenitiesEnabled,
    allowedAmenityCodes: version.allowedAmenityCodes,
  });
}
/** Stored content integrity and a media profile the backend can enforce. */
function assertUsableVersion(version, purposeSubcategoryId) {
  if (!version.contentHash || storedFormContentHash(version) !== version.contentHash) {
    throw formDefinitionInvalid(FormDefinitionInvalidReason.VERSION_INTEGRITY, {
      purposeSubcategoryId: id(purposeSubcategoryId),
    });
  }
  if (!SHIPPED_MEDIA_PROFILES.includes(version.mediaProfile)) {
    throw formDefinitionInvalid(FormDefinitionInvalidReason.MEDIA_PROFILE_UNSUPPORTED, {
      purposeSubcategoryId: id(purposeSubcategoryId),
    });
  }
}
/**
 * Frozen §B1 and §H5, checked before any database access: a version id makes
 * the write dynamic; pin fields or `attributes` without it are invalid; a
 * dynamic write may not also carry the legacy flat spec fields.
 */
function classifyFormWrite(dto) {
  const dynamicOnly =
    dto.attributes !== undefined ||
    dto.formDefinitionId !== undefined ||
    dto.formDefinitionVersion !== undefined ||
    dto.formContentHash !== undefined;
  if (dto.formDefinitionVersionId === undefined) {
    if (dynamicOnly) throw formDefinitionInvalid(FormDefinitionInvalidReason.VERSION_ID_REQUIRED);
    return 'legacy';
  }
  const legacyFields = LEGACY_SPEC_FIELDS.filter((field) => dto[field] !== undefined);
  if (legacyFields.length) {
    throw new BadRequestException({
      message: 'لا يمكن إرسال حقول المواصفات القديمة مع نموذج المواصفات',
      code: PropertyErrorCode.LEGACY_INPUT_NOT_ACCEPTED,
      details: { fields: legacyFields },
    });
  }
  return 'dynamic';
}
/**
 * Frozen §B8 pin checks of a dynamic write against the loaded version and
 * the PRIMARY type's current form. Order: existence, draft, type, definition,
 * currency (409), echoed number/hash, renderer, stored integrity.
 */
function assertDynamicPin(dto, version, primaryId, state) {
  const primary = id(primaryId);
  if (!version)
    throw formDefinitionInvalid(FormDefinitionInvalidReason.VERSION_NOT_FOUND, {
      purposeSubcategoryId: primary,
    });
  if (version.state === 'draft')
    throw formDefinitionInvalid(FormDefinitionInvalidReason.VERSION_NOT_PUBLISHED, {
      purposeSubcategoryId: primary,
    });
  if (id(version.purposeSubcategoryId) !== primary)
    throw formDefinitionInvalid(FormDefinitionInvalidReason.SUBCATEGORY_MISMATCH, {
      purposeSubcategoryId: primary,
    });
  const current = currentPublishedForm(primary, state);
  if (
    id(version.definitionId) !== id(current.head._id) ||
    (dto.formDefinitionId !== undefined && id(dto.formDefinitionId) !== id(current.head._id))
  ) {
    throw formDefinitionInvalid(FormDefinitionInvalidReason.DEFINITION_MISMATCH, {
      purposeSubcategoryId: primary,
    });
  }
  if (id(version._id) !== id(current.version._id))
    throw formVersionOutdated(current, { versionId: version._id, version: version.version });
  if (dto.formDefinitionVersion !== undefined && dto.formDefinitionVersion !== version.version) {
    throw formDefinitionInvalid(FormDefinitionInvalidReason.VERSION_NUMBER_MISMATCH, {
      purposeSubcategoryId: primary,
    });
  }
  if (dto.formContentHash !== undefined && dto.formContentHash !== version.contentHash) {
    throw formDefinitionInvalid(FormDefinitionInvalidReason.CONTENT_HASH_MISMATCH, {
      purposeSubcategoryId: primary,
    });
  }
  if (
    !(
      typeof version.rendererVersion === 'number' &&
      version.rendererVersion <= CURRENT_RENDERER_VERSION
    )
  ) {
    throw formDefinitionInvalid(FormDefinitionInvalidReason.RENDERER_UNSUPPORTED, {
      purposeSubcategoryId: primary,
    });
  }
  assertUsableVersion(version, primary);
  return current;
}
/**
 * Frozen §H4: the legacy flat fields that are present, as attributes of the
 * version (legacy keys the version does not contain are dropped). Nothing is
 * defaulted.
 */
function legacyAttributeInput(dto, version) {
  const keys = new Set(version.fields.map((field) => field.key));
  const input = Object.create(null);
  for (const [field, key] of Object.entries(LEGACY_SPEC_FIELD_TO_ATTRIBUTE)) {
    if (dto[field] !== undefined && keys.has(key)) input[key] = dto[field];
  }
  return input;
}
/**
 * Frozen §H4 carry-forward (C11): values of the previous revision's attributes
 * whose keys are not legacy keys, are still fields of the current version,
 * apply to the operation and were not sent. Only offered for the same primary
 * type's definition; the caller still validates them.
 */
function carriedAttributes(previous, version, operationType, sent) {
  const carried = Object.create(null);
  if (!previous || typeof previous !== 'object') return carried;
  for (const field of version.fields) {
    if (
      LEGACY_ATTRIBUTE_KEYS.includes(field.key) ||
      Object.prototype.hasOwnProperty.call(sent, field.key)
    )
      continue;
    if (field.operations && !field.operations.includes(operationType)) continue;
    if (!Object.prototype.hasOwnProperty.call(previous, field.key)) continue;
    carried[field.key] = previous[field.key];
  }
  return carried;
}
/** Stored (plain-object) attributes as validator input. */
function toParsedAttributes(stored) {
  const parsed = Object.create(null);
  for (const [key, value] of Object.entries(stored ?? {})) parsed[key] = value;
  return parsed;
}
/** Catalog `{group, code}` pairs referenced by provided catalog-backed values (for the live active lookup). */
function catalogCandidates(version, attributes) {
  const pairs = new Map();
  for (const field of version.fields) {
    if (
      field.optionSource !== 'catalog' ||
      !field.catalogGroup ||
      !Object.prototype.hasOwnProperty.call(attributes, field.key)
    )
      continue;
    const value = attributes[field.key];
    for (const code of Array.isArray(value) ? value : [value]) {
      // Same token normalization the validator applies before its catalog check.
      const token =
        typeof code === 'string' && isWellFormedText(code) ? normalizeAttributeToken(code) : '';
      if (token)
        pairs.set(`${field.catalogGroup}:${token}`, { group: field.catalogGroup, code: token });
    }
  }
  return [...pairs.values()];
}
function phase9PromotedFacetDefinition(seed) {
  if (seed.dataType === 'singleSelect')
    return {
      facetKey: seed.key,
      dataType: 'singleSelect',
      optionCodes: (seed.options ?? []).map((option) => option.code),
    };
  if (seed.dataType === 'multiSelect')
    return {
      facetKey: seed.key,
      dataType: 'multiSelect',
      optionCodes: (seed.options ?? []).map((option) => option.code),
      maxItems: seed.hardBounds.maxItems,
    };
  if (seed.dataType === 'boolean') return { facetKey: seed.key, dataType: 'boolean' };
  return { facetKey: seed.key, dataType: seed.dataType, hardBounds: seed.hardBounds };
}
/** Attribute key -> promoted-facet derivation contract (frozen §A1, §G2; extended by Phase 9). */
const PROMOTED_FACET_DEFINITIONS = new Map([
  ...LEGACY_PROPERTY_ATTRIBUTE_SEED.filter((entry) => entry.facetKey).map((entry) => [
    entry.key,
    { facetKey: entry.facetKey, dataType: entry.dataType, hardBounds: entry.hardBounds },
  ]),
  ...PHASE8_NON_RESIDENTIAL_ATTRIBUTE_SEED.filter((entry) =>
    PHASE9_PROMOTED_FACET_KEYS.includes(entry.key),
  ).map((entry) => [entry.key, phase9PromotedFacetDefinition(entry)]),
]);
function normalizedFacetNumber(value, hardBounds, integer) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (integer && !Number.isSafeInteger(value)) return undefined;
  if (hardBounds.min !== undefined && value < hardBounds.min) return undefined;
  if (hardBounds.max !== undefined && value > hardBounds.max) return undefined;
  return value;
}
/** Dedupe + drop anything not a currently-approved option code; canonical order is already the option-declared order the field validator stored (frozen §B4). */
function normalizedFacetMultiSelect(value, optionCodes, maxItems) {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !optionCodes.includes(entry) || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  if (!result.length) return undefined;
  if (maxItems !== undefined && result.length > maxItems) return undefined;
  return result;
}
/**
 * Frozen §A6/§G4 (extended by Phase 9 Search & Facets): the typed facets of
 * an approved revision's effective attributes — PRIMARY form only, never an
 * additional type's. Only engineering-promoted keys (`facetKey` set, which is
 * always == the attribute's own key) are ever considered; a value that is
 * missing, the wrong shape, or fails its registry-defined bounds/option check
 * is omitted, never defaulted and never stored malformed.
 */
function approvedFacets(attributes) {
  const facets = {};
  for (const [attributeKey, definition] of PROMOTED_FACET_DEFINITIONS) {
    if (!PROPERTY_ATTRIBUTE_FACET_KEYS.includes(definition.facetKey)) continue;
    const value = attributes[attributeKey];
    switch (definition.dataType) {
      case 'integer':
      case 'decimal': {
        const normalized = normalizedFacetNumber(
          value,
          definition.hardBounds,
          definition.dataType === 'integer',
        );
        if (normalized !== undefined) facets[definition.facetKey] = normalized;
        break;
      }
      case 'boolean':
        if (typeof value === 'boolean') facets[definition.facetKey] = value;
        break;
      case 'singleSelect':
        if (typeof value === 'string' && definition.optionCodes.includes(value))
          facets[definition.facetKey] = value;
        break;
      case 'multiSelect': {
        const normalized = normalizedFacetMultiSelect(
          value,
          definition.optionCodes,
          definition.maxItems,
        );
        if (normalized) facets[definition.facetKey] = normalized;
        break;
      }
    }
  }
  return facets;
}
const ADDITIONAL_SLOT = /^additional_[1-9]\d*$/;
/**
 * Frozen §I for one profile and the listing's effective attributes: required
 * slots, which are missing, which supplied slot ids the profile does not
 * know (entries without a slot id are not judged), and which required slots
 * reuse the same photo content.
 */
function evaluateMedia(profile, attributes, entries) {
  const definition = mediaProfileDefinition(profile);
  const required = requiredSlots(profile, attributes);
  const supplied = new Set(
    entries.map((entry) => entry.slotId).filter((slotId) => Boolean(slotId)),
  );
  const seen = new Map();
  const duplicates = [];
  for (const slotId of required) {
    const entry = entries.find((item) => item.slotId === slotId);
    if (!entry?.digest) continue;
    const first = seen.get(entry.digest);
    if (first) duplicates.push(first, slotId);
    else seen.set(entry.digest, slotId);
  }
  return {
    profile,
    requiredPhotoSlots: required,
    missingPhotoSlots: required.filter((slotId) => !supplied.has(slotId)),
    invalidPhotoSlots: entries
      .map((entry) => entry.slotId)
      .filter(
        (slotId) => Boolean(slotId) && !required.includes(slotId) && !ADDITIONAL_SLOT.test(slotId),
      ),
    duplicatePhotoSlots: [...new Set(duplicates)],
    minPhotos: definition.minPhotos,
    photoCount: entries.length,
  };
}
/** Frozen §I draft save: slot ids must be valid and required slots may not share content; completeness waits for submit. */
function assertDraftMedia(evaluation) {
  if (evaluation.invalidPhotoSlots.length) {
    throw new BadRequestException({
      message: 'يجب استكمال جميع فئات صور العقار المطلوبة',
      code: EvidenceErrorCode.REQUIRED_PHOTO_SLOTS_MISSING,
      details: {
        missingPhotoSlots: evaluation.missingPhotoSlots,
        invalidPhotoSlots: evaluation.invalidPhotoSlots,
      },
    });
  }
  assertNoDuplicateSlots(evaluation);
}
function assertNoDuplicateSlots(evaluation) {
  if (evaluation.duplicatePhotoSlots.length) {
    throw new BadRequestException({
      message: 'يجب استخدام صورة مستقلة لكل قسم مطلوب',
      code: EvidenceErrorCode.PHOTO_SLOT_MEDIA_DUPLICATED,
      details: { duplicatePhotoSlots: evaluation.duplicatePhotoSlots },
    });
  }
}
/**
 * SELF_SERVICE presentation completeness (frozen §I) at submit and approval.
 * DPF-003 shape under `details`: `missingPhotoSlots` always, `invalidPhotoSlots`
 * when some are invalid, `minPhotos`/`photoCount` when below the profile minimum.
 * Submit also rejects invalid and duplicate slots; approval keeps today's
 * gate (missing slots and the minimum only).
 */
function assertMediaComplete(evaluation, stage) {
  const invalid = stage === 'submit' ? evaluation.invalidPhotoSlots : [];
  const belowMinimum = evaluation.photoCount < evaluation.minPhotos;
  if (evaluation.missingPhotoSlots.length || invalid.length || belowMinimum) {
    throw new BadRequestException({
      message: 'لا يمكن نشر العقار قبل استكمال صور العرض المطلوبة',
      code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING,
      details: {
        missingPhotoSlots: evaluation.missingPhotoSlots,
        ...(invalid.length ? { invalidPhotoSlots: invalid } : {}),
        ...(belowMinimum
          ? { minPhotos: evaluation.minPhotos, photoCount: evaluation.photoCount }
          : {}),
      },
    });
  }
  if (stage === 'submit') assertNoDuplicateSlots(evaluation);
}

Object.assign(exports, {
  FormDefinitionInvalidReason,
  formDefinitionInvalid,
  formDefinitionNotPublished,
  formDefinitionArchived,
  clientUpgradeRequired,
  amenitiesNotEnabled,
  amenityNotAllowed,
  assertAmenitySelection,
  formVersionOutdated,
  currentPublishedForm,
  assertListingEnabled,
  isListingEnabled,
  storedFormContentHash,
  assertUsableVersion,
  classifyFormWrite,
  assertDynamicPin,
  legacyAttributeInput,
  carriedAttributes,
  toParsedAttributes,
  catalogCandidates,
  approvedFacets,
  evaluateMedia,
  assertDraftMedia,
  assertMediaComplete,
});
