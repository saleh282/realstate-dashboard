import { BadRequestException, ConflictException } from '@nestjs/common';
import { PropertyErrorCode } from '../common/errors/property-error-codes';
import { EvidenceErrorCode } from '../common/errors/evidence-error-codes';
import { isWellFormedText, normalizeAttributeToken, type NormalizedAttributes, type ParsedAttributes } from '../common/validators/property-attributes';
import {
  LEGACY_ATTRIBUTE_KEYS,
  LEGACY_PROPERTY_ATTRIBUTE_SEED,
  LEGACY_SPEC_FIELD_TO_ATTRIBUTE,
  LEGACY_SPEC_FIELDS,
  PROPERTY_ATTRIBUTE_FACET_KEYS,
} from '../property-attributes/property-attribute.constants';
import {
  CURRENT_RENDERER_VERSION,
  SHIPPED_MEDIA_PROFILES,
  computeFormContentHash,
  type FieldDefinition,
  type FormOperationType,
  type MediaProfile,
} from '../property-form-definitions/property-form-definition.constants';
import { mediaProfileDefinition, requiredSlots } from './media-profiles';

/**
 * Dynamic Property Form write rules (DPF-020..023, frozen §B1, §B8, §C, §H4-H6,
 * §I and the multi-type amendment §5, §9, §10). Pure: no database, no HTTP.
 * The PRIMARY type alone supplies the form, its media profile and its facets;
 * additional selected types only have to be listing-enabled.
 */

/** A FormDefinition head as read from `property_form_definitions`. */
export type FormHeadRecord = {
  _id: unknown;
  purposeSubcategoryId: unknown;
  status: string;
  currentVersionId?: unknown;
  currentVersion?: number;
};

/** An immutable FormDefinitionVersion as read from `property_form_definition_versions`. */
export type FormVersionRecord = {
  _id: unknown;
  definitionId: unknown;
  purposeSubcategoryId: unknown;
  version?: number;
  state: string;
  rendererVersion?: number;
  fields: FieldDefinition[];
  mediaProfile: MediaProfile;
  amenitiesEnabled: boolean;
  legacyWritable?: boolean;
  contentHash?: string;
};

/** Heads keyed by lowercase property-type id; versions keyed by lowercase version id. */
export type FormState = {
  headByType: Map<string, FormHeadRecord>;
  versionById: Map<string, FormVersionRecord>;
};

export type CurrentForm = { head: FormHeadRecord; version: FormVersionRecord };

const id = (value: unknown) => String(value).toLowerCase();

/** `details.reason` of PROPERTY_FORM_DEFINITION_INVALID. */
export enum FormDefinitionInvalidReason {
  /** `attributes` or another pin field was sent without `formDefinitionVersionId` (frozen §B1). */
  VERSION_ID_REQUIRED = 'VERSION_ID_REQUIRED',
  VERSION_NOT_FOUND = 'VERSION_NOT_FOUND',
  /** The version is a draft (frozen §B8). */
  VERSION_NOT_PUBLISHED = 'VERSION_NOT_PUBLISHED',
  /** The version belongs to another property type than the PRIMARY one. */
  SUBCATEGORY_MISMATCH = 'SUBCATEGORY_MISMATCH',
  /** The version, or the sent `formDefinitionId`, is not the primary type's definition. */
  DEFINITION_MISMATCH = 'DEFINITION_MISMATCH',
  VERSION_NUMBER_MISMATCH = 'VERSION_NUMBER_MISMATCH',
  CONTENT_HASH_MISMATCH = 'CONTENT_HASH_MISMATCH',
  RENDERER_UNSUPPORTED = 'RENDERER_UNSUPPORTED',
  MEDIA_PROFILE_UNSUPPORTED = 'MEDIA_PROFILE_UNSUPPORTED',
  /** The stored content no longer hashes to its recorded `contentHash`. */
  VERSION_INTEGRITY = 'VERSION_INTEGRITY',
}

export function formDefinitionInvalid(reason: FormDefinitionInvalidReason, extra: Record<string, unknown> = {}) {
  return new BadRequestException({
    message: 'نموذج مواصفات العقار غير صالح؛ أعد تحميل النموذج',
    code: PropertyErrorCode.FORM_DEFINITION_INVALID,
    details: { reason, ...extra },
  });
}

export const formDefinitionNotPublished = (purposeSubcategoryId: unknown) => new BadRequestException({
  message: 'نوع العقار غير متاح للإضافة حاليًا',
  code: PropertyErrorCode.FORM_DEFINITION_NOT_PUBLISHED,
  details: { purposeSubcategoryId: id(purposeSubcategoryId) },
});

export const formDefinitionArchived = (purposeSubcategoryId: unknown) => new BadRequestException({
  message: 'نوع العقار موقوف حاليًا',
  code: PropertyErrorCode.FORM_DEFINITION_ARCHIVED,
  details: { purposeSubcategoryId: id(purposeSubcategoryId) },
});

export const clientUpgradeRequired = (purposeSubcategoryId: unknown) => new BadRequestException({
  message: 'حدّث التطبيق لإضافة أو تعديل هذا النوع من العقارات',
  code: PropertyErrorCode.CLIENT_UPGRADE_REQUIRED,
  details: { purposeSubcategoryId: id(purposeSubcategoryId) },
});

export const amenitiesNotEnabled = () => new BadRequestException({
  message: 'المميزات والخدمات غير متاحة لهذا النوع من العقارات',
  code: PropertyErrorCode.AMENITIES_NOT_ENABLED,
});

/**
 * Frozen §B8 409 (amendment §10: plus the primary's `purposeSubcategoryId`).
 * Carries everything a client needs to fetch the current version and remap:
 * the definition, the submitted pin (null for an unpinned legacy draft) and
 * the current version's id, number, hash and renderer version.
 */
export function formVersionOutdated(current: CurrentForm, submitted: { versionId: unknown; version?: number | null } | null) {
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
export function currentPublishedForm(purposeSubcategoryId: unknown, state: FormState): CurrentForm {
  const head = state.headByType.get(id(purposeSubcategoryId));
  if (!head) throw formDefinitionNotPublished(purposeSubcategoryId);
  if (head.status !== 'active') throw formDefinitionArchived(purposeSubcategoryId);
  const version = head.currentVersionId ? state.versionById.get(id(head.currentVersionId)) : undefined;
  if (!version || version.state !== 'published' || id(version.definitionId) !== id(head._id) || id(version.purposeSubcategoryId) !== id(purposeSubcategoryId)) {
    throw formDefinitionNotPublished(purposeSubcategoryId);
  }
  return { head, version };
}

/** Amendment rule 4 for every selected type, in the given order; the first failure is reported. */
export function assertListingEnabled(typeIds: readonly unknown[], state: FormState): void {
  for (const typeId of typeIds) currentPublishedForm(typeId, state);
}

export function isListingEnabled(typeId: unknown, state: FormState): boolean {
  try {
    currentPublishedForm(typeId, state);
    return true;
  } catch {
    return false;
  }
}

/** Recomputes the frozen §A3 content hash from a stored version document. */
export function storedFormContentHash(version: Pick<FormVersionRecord, 'rendererVersion' | 'fields' | 'mediaProfile' | 'amenitiesEnabled'>): string {
  return computeFormContentHash({
    rendererVersion: version.rendererVersion!,
    fields: version.fields,
    mediaProfile: version.mediaProfile,
    amenitiesEnabled: version.amenitiesEnabled,
  });
}

/** Stored content integrity and a media profile the backend can enforce. */
export function assertUsableVersion(version: FormVersionRecord, purposeSubcategoryId: unknown): void {
  if (!version.contentHash || storedFormContentHash(version) !== version.contentHash) {
    throw formDefinitionInvalid(FormDefinitionInvalidReason.VERSION_INTEGRITY, { purposeSubcategoryId: id(purposeSubcategoryId) });
  }
  if (!SHIPPED_MEDIA_PROFILES.includes(version.mediaProfile)) {
    throw formDefinitionInvalid(FormDefinitionInvalidReason.MEDIA_PROFILE_UNSUPPORTED, { purposeSubcategoryId: id(purposeSubcategoryId) });
  }
}

/** The dynamic-form transport fields a write may carry (frozen §B1, plus the optional pin echo). */
export type FormWriteInput = {
  formDefinitionVersionId?: string;
  formDefinitionId?: string;
  formDefinitionVersion?: number;
  formContentHash?: string;
  attributes?: unknown;
};

export type FormWriteMode = 'dynamic' | 'legacy';

/**
 * Frozen §B1 and §H5, checked before any database access: a version id makes
 * the write dynamic; pin fields or `attributes` without it are invalid; a
 * dynamic write may not also carry the legacy flat spec fields.
 */
export function classifyFormWrite(dto: FormWriteInput & Record<string, unknown>): FormWriteMode {
  const dynamicOnly = dto.attributes !== undefined || dto.formDefinitionId !== undefined || dto.formDefinitionVersion !== undefined || dto.formContentHash !== undefined;
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
export function assertDynamicPin(dto: FormWriteInput, version: FormVersionRecord | undefined, primaryId: unknown, state: FormState): CurrentForm {
  const primary = id(primaryId);
  if (!version) throw formDefinitionInvalid(FormDefinitionInvalidReason.VERSION_NOT_FOUND, { purposeSubcategoryId: primary });
  if (version.state === 'draft') throw formDefinitionInvalid(FormDefinitionInvalidReason.VERSION_NOT_PUBLISHED, { purposeSubcategoryId: primary });
  if (id(version.purposeSubcategoryId) !== primary) throw formDefinitionInvalid(FormDefinitionInvalidReason.SUBCATEGORY_MISMATCH, { purposeSubcategoryId: primary });
  const current = currentPublishedForm(primary, state);
  if (id(version.definitionId) !== id(current.head._id) || (dto.formDefinitionId !== undefined && id(dto.formDefinitionId) !== id(current.head._id))) {
    throw formDefinitionInvalid(FormDefinitionInvalidReason.DEFINITION_MISMATCH, { purposeSubcategoryId: primary });
  }
  if (id(version._id) !== id(current.version._id)) throw formVersionOutdated(current, { versionId: version._id, version: version.version });
  if (dto.formDefinitionVersion !== undefined && dto.formDefinitionVersion !== version.version) {
    throw formDefinitionInvalid(FormDefinitionInvalidReason.VERSION_NUMBER_MISMATCH, { purposeSubcategoryId: primary });
  }
  if (dto.formContentHash !== undefined && dto.formContentHash !== version.contentHash) {
    throw formDefinitionInvalid(FormDefinitionInvalidReason.CONTENT_HASH_MISMATCH, { purposeSubcategoryId: primary });
  }
  if (!(typeof version.rendererVersion === 'number' && version.rendererVersion <= CURRENT_RENDERER_VERSION)) {
    throw formDefinitionInvalid(FormDefinitionInvalidReason.RENDERER_UNSUPPORTED, { purposeSubcategoryId: primary });
  }
  assertUsableVersion(version, primary);
  return current;
}

/**
 * Frozen §H4: the legacy flat fields that are present, as attributes of the
 * version (legacy keys the version does not contain are dropped). Nothing is
 * defaulted.
 */
export function legacyAttributeInput(dto: Record<string, unknown>, version: Pick<FormVersionRecord, 'fields'>): ParsedAttributes {
  const keys = new Set(version.fields.map((field) => field.key));
  const input: ParsedAttributes = Object.create(null);
  for (const [field, key] of Object.entries(LEGACY_SPEC_FIELD_TO_ATTRIBUTE)) {
    if (dto[field] !== undefined && keys.has(key)) input[key] = dto[field] as ParsedAttributes[string];
  }
  return input;
}

/**
 * Frozen §H4 carry-forward (C11): values of the previous revision's attributes
 * whose keys are not legacy keys, are still fields of the current version,
 * apply to the operation and were not sent. Only offered for the same primary
 * type's definition; the caller still validates them.
 */
export function carriedAttributes(previous: Record<string, unknown> | null | undefined, version: Pick<FormVersionRecord, 'fields'>, operationType: FormOperationType, sent: ParsedAttributes): ParsedAttributes {
  const carried: ParsedAttributes = Object.create(null);
  if (!previous || typeof previous !== 'object') return carried;
  for (const field of version.fields) {
    if (LEGACY_ATTRIBUTE_KEYS.includes(field.key) || Object.prototype.hasOwnProperty.call(sent, field.key)) continue;
    if (field.operations && !field.operations.includes(operationType)) continue;
    if (!Object.prototype.hasOwnProperty.call(previous, field.key)) continue;
    carried[field.key] = previous[field.key] as ParsedAttributes[string];
  }
  return carried;
}

/** Stored (plain-object) attributes as validator input. */
export function toParsedAttributes(stored: Record<string, unknown> | null | undefined): ParsedAttributes {
  const parsed: ParsedAttributes = Object.create(null);
  for (const [key, value] of Object.entries(stored ?? {})) parsed[key] = value as ParsedAttributes[string];
  return parsed;
}

/** Catalog `{group, code}` pairs referenced by provided catalog-backed values (for the live active lookup). */
export function catalogCandidates(version: Pick<FormVersionRecord, 'fields'>, attributes: ParsedAttributes | NormalizedAttributes): Array<{ group: string; code: string }> {
  const pairs = new Map<string, { group: string; code: string }>();
  for (const field of version.fields) {
    if (field.optionSource !== 'catalog' || !field.catalogGroup || !Object.prototype.hasOwnProperty.call(attributes, field.key)) continue;
    const value = attributes[field.key];
    for (const code of Array.isArray(value) ? value : [value]) {
      // Same token normalization the validator applies before its catalog check.
      const token = typeof code === 'string' && isWellFormedText(code) ? normalizeAttributeToken(code) : '';
      if (token) pairs.set(`${field.catalogGroup}:${token}`, { group: field.catalogGroup, code: token });
    }
  }
  return [...pairs.values()];
}

/** Attribute key -> facet key, from the engineering-owned registry seed (frozen §A1, §G2). */
const FACET_KEY_BY_ATTRIBUTE: ReadonlyMap<string, string> = new Map(
  LEGACY_PROPERTY_ATTRIBUTE_SEED.filter((entry) => entry.facetKey).map((entry) => [entry.key, entry.facetKey!]),
);

export type PropertyFacetValues = { bedrooms?: number };

/**
 * Frozen §A6/§G4: the typed facets of an approved revision's effective
 * attributes. Only engineering-promoted keys; a value that is missing or not
 * a valid facet value is omitted, never defaulted.
 */
export function approvedFacets(attributes: Readonly<Record<string, unknown>>): PropertyFacetValues {
  const facets: Record<string, number> = {};
  for (const [attributeKey, facetKey] of FACET_KEY_BY_ATTRIBUTE) {
    if (!(PROPERTY_ATTRIBUTE_FACET_KEYS as readonly string[]).includes(facetKey)) continue;
    const value = attributes[attributeKey];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100) facets[facetKey] = value;
  }
  return facets;
}

/** One stored or uploaded photo, as far as slot completeness is concerned. */
export type MediaSlotEntry = { slotId?: string; digest?: string };

export type MediaEvaluation = {
  profile: MediaProfile;
  requiredPhotoSlots: string[];
  missingPhotoSlots: string[];
  invalidPhotoSlots: string[];
  duplicatePhotoSlots: string[];
  minPhotos: number;
  photoCount: number;
};

const ADDITIONAL_SLOT = /^additional_[1-9]\d*$/;

/**
 * Frozen §I for one profile and the listing's effective attributes: required
 * slots, which are missing, which supplied slot ids the profile does not
 * know (entries without a slot id are not judged), and which required slots
 * reuse the same photo content.
 */
export function evaluateMedia(profile: MediaProfile, attributes: Readonly<Record<string, unknown>>, entries: readonly MediaSlotEntry[]): MediaEvaluation {
  const definition = mediaProfileDefinition(profile);
  const required = requiredSlots(profile, attributes);
  const supplied = new Set(entries.map((entry) => entry.slotId).filter((slotId): slotId is string => Boolean(slotId)));
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
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
    invalidPhotoSlots: entries.map((entry) => entry.slotId).filter((slotId): slotId is string => Boolean(slotId) && !required.includes(slotId!) && !ADDITIONAL_SLOT.test(slotId!)),
    duplicatePhotoSlots: [...new Set(duplicates)],
    minPhotos: definition.minPhotos,
    photoCount: entries.length,
  };
}

/** Frozen §I draft save: slot ids must be valid and required slots may not share content; completeness waits for submit. */
export function assertDraftMedia(evaluation: MediaEvaluation): void {
  if (evaluation.invalidPhotoSlots.length) {
    throw new BadRequestException({
      message: 'يجب استكمال جميع فئات صور العقار المطلوبة',
      code: EvidenceErrorCode.REQUIRED_PHOTO_SLOTS_MISSING,
      details: { missingPhotoSlots: evaluation.missingPhotoSlots, invalidPhotoSlots: evaluation.invalidPhotoSlots },
    });
  }
  assertNoDuplicateSlots(evaluation);
}

function assertNoDuplicateSlots(evaluation: MediaEvaluation): void {
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
export function assertMediaComplete(evaluation: MediaEvaluation, stage: 'submit' | 'approval'): void {
  const invalid = stage === 'submit' ? evaluation.invalidPhotoSlots : [];
  const belowMinimum = evaluation.photoCount < evaluation.minPhotos;
  if (evaluation.missingPhotoSlots.length || invalid.length || belowMinimum) {
    throw new BadRequestException({
      message: 'لا يمكن نشر العقار قبل استكمال صور العرض المطلوبة',
      code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING,
      details: {
        missingPhotoSlots: evaluation.missingPhotoSlots,
        ...(invalid.length ? { invalidPhotoSlots: invalid } : {}),
        ...(belowMinimum ? { minPhotos: evaluation.minPhotos, photoCount: evaluation.photoCount } : {}),
      },
    });
  }
  if (stage === 'submit') assertNoDuplicateSlots(evaluation);
}
