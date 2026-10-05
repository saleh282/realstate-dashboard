'use strict';

const { NotFoundException } = require('../common/http/errors');
const { Types } = require('mongoose');
const { LruCache } = require('../common/cache/lru-cache');
const { mediaRequirements } = require('../domain/properties/media-profiles');
const {
  FormDefinitionErrorCode,
  PROPERTY_FORM_LIMITS,
  READABLE_FORM_VERSION_STATES,
} = require('../domain/property-form-definitions/property-form-definition.constants');
const FIELD_PROPERTIES = [
  'key',
  'dataType',
  'unit',
  'optionSource',
  'catalogGroup',
  'labelAr',
  'labelEn',
  'helpAr',
  'helpEn',
  'placeholderAr',
  'required',
  'order',
  'operations',
  'validation',
  'options',
  'widget',
];
class PropertyFormDefinitionsService {
  constructor(definitions, versions) {
    this.definitions = definitions;
    this.versions = versions;
    /** Published/superseded versions never change, so a read can be cached for the process lifetime. */
    this.versionCache = new LruCache(PROPERTY_FORM_LIMITS.versionCacheSize);
  }
  /**
   * Frozen §D #3: only published or superseded versions are readable. Drafts,
   * unknown ids and malformed ids are the same 404 (nothing to enumerate).
   */
  async getPublicVersion(versionId) {
    const notFound = () =>
      new NotFoundException({
        message: 'نسخة نموذج العقار غير موجودة',
        code: FormDefinitionErrorCode.NOT_FOUND,
      });
    if (!/^[a-fA-F0-9]{24}$/.test(versionId)) throw notFound();
    const key = versionId.toLowerCase();
    const cached = this.versionCache.get(key);
    if (cached) return cached;
    const version = await this.versions
      .findOne({ _id: new Types.ObjectId(key), state: { $in: [...READABLE_FORM_VERSION_STATES] } })
      .lean()
      .exec();
    if (!version) throw notFound();
    const projection = toPublicVersion(version);
    this.versionCache.set(key, projection);
    return projection;
  }
  /**
   * Current published form per property type, for active (not archived)
   * definitions only. A head whose current version is missing or not
   * published yields no pointer (the type is not creatable).
   */
  async creationPointers() {
    const heads = await this.definitions
      .find({ status: 'active', currentVersionId: { $exists: true, $ne: null } })
      .lean()
      .exec();
    if (!heads.length) return new Map();
    const versions = await this.versions
      .find(
        { _id: { $in: heads.map((head) => head.currentVersionId) }, state: 'published' },
        { contentHash: 1, rendererVersion: 1, legacyWritable: 1, version: 1, definitionId: 1 },
      )
      .lean()
      .exec();
    const versionById = new Map(versions.map((version) => [String(version._id), version]));
    const pointers = new Map();
    for (const head of heads) {
      const version = versionById.get(String(head.currentVersionId));
      if (!version || String(version.definitionId) !== String(head._id)) continue;
      pointers.set(String(head.purposeSubcategoryId), {
        purposeSubcategoryId: String(head.purposeSubcategoryId),
        definitionId: String(head._id),
        currentVersionId: String(version._id),
        currentVersion: version.version,
        contentHash: version.contentHash,
        rendererVersion: version.rendererVersion,
        legacyWritable: version.legacyWritable === true,
      });
    }
    return pointers;
  }
}
function toPublicVersion(version) {
  return {
    versionId: String(version._id),
    definitionId: String(version.definitionId),
    purposeSubcategoryId: String(version.purposeSubcategoryId),
    version: version.version,
    rendererVersion: version.rendererVersion,
    contentHash: version.contentHash,
    amenitiesEnabled: version.amenitiesEnabled,
    ...(version.allowedAmenityCodes !== undefined
      ? { allowedAmenityCodes: version.allowedAmenityCodes }
      : {}),
    fields: [...(version.fields ?? [])]
      .sort((a, b) => a.order - b.order)
      .map((field) =>
        Object.fromEntries(
          FIELD_PROPERTIES.filter(
            (property) => field[property] !== undefined && field[property] !== null,
          ).map((property) => [property, field[property]]),
        ),
      ),
    mediaRequirements: mediaRequirements(version.mediaProfile),
  };
}

Object.assign(exports, { PropertyFormDefinitionsService, toPublicVersion });
